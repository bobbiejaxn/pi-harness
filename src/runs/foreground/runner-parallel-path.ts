/**
 * Parallel path runner — extracted from executor-path-runners.ts.
 */

/**
 * Parallel and single foreground path runners.
 * Extracted from subagent-executor.ts.
 */

import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { resolveTraceRunId } from "../../shared/trace-propagation.ts";
import { type AgentConfig, type AgentScope } from "../../agents/agents.ts";
import { ChainClarifyComponent, type ChainClarifyResult } from "./chain-clarify.ts";
import { toModelInfo, type ModelInfo } from "../../shared/model-info.ts";
import { runSync } from "./execution.ts";
import {
	type ExecutionContextData,
	type ExecutorDeps,
} from "./executor-types.ts";
export type {
	ExecutionContextData,
	ExecutorDeps,
} from "./executor-types.ts";
import { resolveMerge, type MergeResolverOptions, type MergeResolutionResult } from "../../shared/merge-resolver.ts";
import { resolveModelCandidate } from "../shared/model-fallback.ts";
import { aggregateParallelOutputs } from "../shared/parallel-utils.ts";
import { recordRun } from "../shared/run-history.ts";
import {
	writeInitialProgressFile,
	resolveStepBehavior,
	suppressProgressForReadOnlyTask,
	taskDisallowsFileUpdates,
	type StepOverrides,
} from "../../shared/settings.ts";
import { discoverAvailableSkills, normalizeSkillInput } from "../../agents/skills.ts";
import { executeAsyncChain, executeAsyncSingle, formatAsyncStartedMessage, isAsyncAvailable } from "../background/async-execution.ts";
import { applyIntercomBridgeToAgent, INTERCOM_BRIDGE_MARKER, resolveIntercomBridge, resolveIntercomSessionTarget, resolveSubagentIntercomTarget, type IntercomBridgeState } from "../../intercom/intercom-bridge.ts";
import { finalizeSingleOutput, injectSingleOutputInstruction, normalizeSingleOutputOverride, resolveSingleOutputPath, validateFileOnlyOutputMode } from "../shared/single-output.ts";
import { compactForegroundDetails, getSingleResultOutput, mapConcurrent, readStatus, resolveChildCwd } from "../../shared/utils.ts";
import { createNestedRoute, readNestedControlResults, resolveInheritedNestedRouteFromEnv, resolveNestedAsyncDir, resolveNestedParentAddressFromEnv, updateForegroundNestedProjection, writeNestedControlRequest, writeNestedEvent, type NestedRunResolutionScope } from "../shared/nested-events.ts";
import {
	cleanupWorktrees,
} from "../shared/worktree.ts";
import {
	type AgentProgress,
	type ArtifactPaths,
	type Details,
	type SingleResult,
	resolveTopLevelParallelConcurrency,
	resolveTopLevelParallelMaxTasks,
	resolveChildMaxSubagentDepth,
	resolveCurrentMaxSubagentDepth,
	wrapForkTask,
} from "../../shared/types.ts";
import {
	buildParallelModeError,
	resolveParallelTaskCwd,
	findDuplicateParallelOutputPath,
	createParallelWorktreeSetup,
	buildParallelWorktreeTaskCwdError,
	mergeWorktreeResults,
	buildParallelWorktreeSuffix,
} from "./foreground-validation.ts";

// Helpers extracted to executor-helpers.ts
import {
	createForegroundControlNotifier,
	maybeBuildForegroundIntercomReceipt,
	rememberForegroundRun,
} from "./executor-helpers.ts";

// Chain/parallel path runners extracted to executor-paths.ts
import {
	runForegroundParallelTasks,
} from "./executor-paths.ts";

// Shared constants from executor-helpers.ts



export async function runParallelPath(data: ExecutionContextData, deps: ExecutorDeps): Promise<AgentToolResult<Details>> {
	const {
		params,
		effectiveCwd,
		agents,
		ctx,
		signal,
		runId,
		sessionDirForIndex,
		sessionFileForIndex,
		shareEnabled,
		artifactConfig,
		artifactsDir,
		backgroundRequestedWhileClarifying,
		onUpdate,
		sessionRoot,
		controlConfig,
	} = data;
	const onControlEvent = createForegroundControlNotifier(data, deps);
	const childIntercomTarget = data.intercomBridge.active ? resolveSubagentIntercomTarget : undefined;
	const allProgress: AgentProgress[] = [];
	const allArtifactPaths: ArtifactPaths[] = [];
	const tasks = params.tasks!;
	const maxParallelTasks = resolveTopLevelParallelMaxTasks(deps.config.parallel?.maxTasks);
	const parallelConcurrency = resolveTopLevelParallelConcurrency(params.concurrency, deps.config.parallel?.concurrency);

	if (tasks.length > maxParallelTasks)
		return {
			content: [{ type: "text", text: `Max ${maxParallelTasks} tasks` }],
			isError: true,
			details: { mode: "parallel" as const, results: [] },
		};

	const agentConfigs: AgentConfig[] = [];
	for (const t of tasks) {
		const config = agents.find((a) => a.name === t.agent);
		if (!config) {
			return {
				content: [{ type: "text", text: `Unknown agent: ${t.agent}` }],
				isError: true,
				details: { mode: "parallel" as const, results: [] },
			};
		}
		agentConfigs.push(config);
	}

	const currentMaxSubagentDepth = resolveCurrentMaxSubagentDepth(deps.config.maxSubagentDepth);
	const maxSubagentDepths = agentConfigs.map((config) =>
		resolveChildMaxSubagentDepth(currentMaxSubagentDepth, config.maxSubagentDepth),
	);

	if (params.worktree) {
		const worktreeTaskCwdError = buildParallelWorktreeTaskCwdError(tasks, effectiveCwd);
		if (worktreeTaskCwdError) return buildParallelModeError(worktreeTaskCwdError);
	}

	const currentProvider = ctx.model?.provider;
	const availableModels: ModelInfo[] = ctx.modelRegistry.getAvailable().map(toModelInfo);
	let taskTexts = tasks.map((t) => t.task);
	const skillOverrides: (string[] | false | undefined)[] = tasks.map((t) =>
		normalizeSkillInput(t.skill),
	);
	const behaviorOverrides: StepOverrides[] = tasks.map((task, index) => ({
		...(task.output !== undefined ? { output: task.output === true ? agentConfigs[index]?.output ?? false : task.output } : {}),
		...(task.outputMode !== undefined ? { outputMode: task.outputMode } : {}),
		...(task.reads !== undefined && task.reads !== true ? { reads: task.reads } : {}),
		...(task.progress !== undefined ? { progress: task.progress } : {}),
		...(skillOverrides[index] !== undefined ? { skills: skillOverrides[index] } : {}),
		...(task.model ? { model: task.model } : {}),
	}));
	const modelOverrides: (string | undefined)[] = tasks.map((_, i) =>
		resolveModelCandidate(behaviorOverrides[i]?.model ?? agentConfigs[i]?.model, availableModels, currentProvider),
	);

	if (params.clarify === true && ctx.hasUI) {
		const behaviors = agentConfigs.map((c, i) =>
			resolveStepBehavior(c, behaviorOverrides[i]!),
		);
		const availableSkills = discoverAvailableSkills(effectiveCwd);

		const result = await ctx.ui.custom<ChainClarifyResult>(
			(tui, theme, _kb, done) =>
				new ChainClarifyComponent(
					tui, theme,
					agentConfigs,
					taskTexts,
					"",
					undefined,
					behaviors,
					availableModels,
					currentProvider,
					availableSkills,
					done,
					"parallel",
				),
			{ overlay: true, overlayOptions: { anchor: "center", width: 84, maxHeight: "80%" } },
		);

		if (!result || !result.confirmed) {
			return { content: [{ type: "text", text: "Cancelled" }], details: { mode: "parallel", results: [] } };
		}

		taskTexts = result.templates;
		for (let i = 0; i < result.behaviorOverrides.length; i++) {
			const override = result.behaviorOverrides[i];
			if (override?.model) {
				modelOverrides[i] = override.model;
				behaviorOverrides[i]!.model = override.model;
			}
			if (override?.output !== undefined) behaviorOverrides[i]!.output = override.output;
			if (override?.reads !== undefined) behaviorOverrides[i]!.reads = override.reads;
			if (override?.progress !== undefined) behaviorOverrides[i]!.progress = override.progress;
			if (override?.skills !== undefined) {
				skillOverrides[i] = override.skills;
				behaviorOverrides[i]!.skills = override.skills;
			}
		}

		if (result.runInBackground) {
			if (!isAsyncAvailable()) {
				return {
					content: [{ type: "text", text: "Background mode requires upstream jiti for TypeScript execution but it could not be found. Ensure the pi-subagents package dependencies are installed." }],
					isError: true,
					details: { mode: "parallel" as const, results: [] },
				};
			}
			const id = randomUUID();
			const asyncCtx = {
				pi: deps.pi,
				cwd: ctx.cwd,
				currentSessionId: deps.state.currentSessionId!,
				currentModelProvider: ctx.model?.provider,
			};
			const parallelTasks = tasks.map((t, i) => {
				const taskText = params.context === "fork" ? wrapForkTask(taskTexts[i]!) : taskTexts[i]!;
				const progress = taskDisallowsFileUpdates(taskText) ? false : behaviorOverrides[i]?.progress;
				return {
					agent: t.agent,
					task: taskText,
					cwd: t.cwd,
					...(modelOverrides[i] ? { model: modelOverrides[i] } : {}),
					...(skillOverrides[i] !== undefined ? { skill: skillOverrides[i] } : {}),
					...(behaviorOverrides[i]?.output !== undefined ? { output: behaviorOverrides[i]!.output } : {}),
					...(behaviorOverrides[i]?.outputMode !== undefined ? { outputMode: behaviorOverrides[i]!.outputMode } : {}),
					...(behaviorOverrides[i]?.reads !== undefined ? { reads: behaviorOverrides[i]!.reads } : {}),
					...(progress !== undefined ? { progress } : {}),
					...(t.acceptance !== undefined ? { acceptance: t.acceptance } : {}),
				};
			});
			return executeAsyncChain(id, {
				chain: [{ parallel: parallelTasks, concurrency: parallelConcurrency, worktree: params.worktree }],
				resultMode: "parallel",
				agents,
				ctx: asyncCtx,
				availableModels,
				cwd: effectiveCwd,
				maxOutput: params.maxOutput,
				artifactsDir: artifactConfig.enabled ? artifactsDir : undefined,
				artifactConfig,
				shareEnabled,
				sessionRoot,
				chainSkills: [],
				sessionFilesByFlatIndex: tasks.map((_, index) => sessionFileForIndex(index)),
				maxSubagentDepth: currentMaxSubagentDepth,
				worktreeSetupHook: deps.config.worktreeSetupHook,
				worktreeSetupHookTimeoutMs: deps.config.worktreeSetupHookTimeoutMs,
				controlConfig,
				controlIntercomTarget: data.intercomBridge.active ? data.intercomBridge.orchestratorTarget : undefined,
				childIntercomTarget: data.intercomBridge.active ? (agent, index) => resolveSubagentIntercomTarget(id, agent, index) : undefined,
			});
		}
	}

	const behaviors = agentConfigs.map((config, index) => suppressProgressForReadOnlyTask(resolveStepBehavior(config, behaviorOverrides[index]!), taskTexts[index]));
	const firstProgressIndex = behaviors.findIndex((behavior) => behavior.progress);
	const liveResults: (SingleResult | undefined)[] = new Array(tasks.length).fill(undefined);
	const liveProgress: (AgentProgress | undefined)[] = new Array(tasks.length).fill(undefined);
	const foregroundControl = deps.state.foregroundControls.get(runId);
	const { setup: worktreeSetup, errorResult } = createParallelWorktreeSetup(
		params.worktree,
		effectiveCwd,
		runId,
		tasks,
		deps.config.worktreeSetupHook,
		deps.config.worktreeSetupHookTimeoutMs,
	);
	if (errorResult) return errorResult;

	try {
		const duplicateOutputError = findDuplicateParallelOutputPath({
			tasks,
			behaviors,
			paramsCwd: effectiveCwd,
			ctxCwd: ctx.cwd,
			worktreeSetup,
		});
		if (duplicateOutputError) return buildParallelModeError(duplicateOutputError);
		for (let index = 0; index < tasks.length; index++) {
			const taskCwd = resolveParallelTaskCwd(tasks[index]!, effectiveCwd, worktreeSetup, index);
			const outputPath = resolveSingleOutputPath(behaviors[index]?.output, ctx.cwd, taskCwd);
			const validationError = validateFileOnlyOutputMode(behaviors[index]?.outputMode, outputPath, `Parallel task ${index + 1} (${tasks[index]!.agent})`);
			if (validationError) return buildParallelModeError(validationError);
		}

		const parallelProgressPrecreated = firstProgressIndex !== -1;
		if (parallelProgressPrecreated) writeInitialProgressFile(effectiveCwd);

		if (params.context === "fork") {
			for (let i = 0; i < taskTexts.length; i++) {
				taskTexts[i] = wrapForkTask(taskTexts[i]!);
			}
		}

		const results = await runForegroundParallelTasks({
			tasks,
			taskTexts,
			agents,
			ctx,
			intercomEvents: deps.pi.events,
			signal,
			runId,
			sessionDirForIndex,
			sessionFileForIndex,
			shareEnabled,
			artifactConfig,
			artifactsDir,
			maxOutput: params.maxOutput,
			paramsCwd: effectiveCwd,
			availableModels,
			modelOverrides,
			behaviors,
			firstProgressIndex: parallelProgressPrecreated ? -1 : firstProgressIndex,
			controlConfig,
			onControlEvent,
			childIntercomTarget: childIntercomTarget ? (agent, index) => childIntercomTarget(runId, agent, index) : undefined,
			orchestratorIntercomTarget: data.intercomBridge.active ? data.intercomBridge.orchestratorTarget : undefined,
			foregroundControl,
			concurrencyLimit: parallelConcurrency,
			maxSubagentDepths,
			liveResults,
			liveProgress,
			onUpdate,
			worktreeSetup,
		});
		for (let i = 0; i < results.length; i++) {
			const run = results[i]!;
			recordRun(run.agent, taskTexts[i]!, run.exitCode, run.progressSummary?.durationMs ?? 0);
		}

		// Merge worktree branches for successful tasks
		if (worktreeSetup) {
			try {
				const okResults = results.filter((r, i) => r.exitCode === 0);
				if (okResults.length > 0) {
					const mergeResults = await mergeWorktreeResults(
						effectiveCwd,
						worktreeSetup,
						results,
						deps.mergeResolverOptions,
						deps.parentModel,
					);
					// Attach merge results to the details
					for (const mr of mergeResults) {
						if (mr.result) {
							(results[mr.index] as SingleResult & { worktreeMerge?: MergeResolutionResult }).worktreeMerge = mr.result;
						}
					}
				}
			} catch {
				// Merge is best-effort — don't fail the whole run if merge fails
			}
		}

		for (const result of results) {
			if (result.progress) allProgress.push(result.progress);
			if (result.artifactPaths) allArtifactPaths.push(result.artifactPaths);
		}

		const interrupted = results.find((result) => result.interrupted);
		const details = compactForegroundDetails({
			mode: "parallel",
			runId,
			results,
			progress: params.includeProgress ? allProgress : undefined,
			artifacts: allArtifactPaths.length ? { dir: artifactsDir, files: allArtifactPaths } : undefined,
		});
		rememberForegroundRun(deps.state, { runId, mode: "parallel", cwd: effectiveCwd, results: details.results });
		if (interrupted) {
			return {
				content: [{ type: "text", text: `Parallel run paused after interrupt (${interrupted.agent}). Waiting for explicit next action.` }],
				details,
			};
		}
		const detachedIndex = results.findIndex((result) => result.detached);
		const detached = detachedIndex >= 0 ? results[detachedIndex] : undefined;
		if (detached) {
			return {
				content: [{ type: "text", text: `Parallel run detached for intercom coordination (${detached.agent}). Reply to the supervisor request first. After the child exits, start a fresh follow-up if needed.` }],
				details,
			};
		}

		if (foregroundControl) updateForegroundNestedProjection(foregroundControl);
		const intercomReceipt = await maybeBuildForegroundIntercomReceipt({
			pi: deps.pi,
			intercomBridge: data.intercomBridge,
			runId,
			mode: "parallel",
			details,
			...(foregroundControl?.nestedChildren?.length ? { nestedChildren: foregroundControl.nestedChildren } : {}),
		});
		if (intercomReceipt) {
			return {
				content: [{ type: "text", text: intercomReceipt.text }],
				details: intercomReceipt.details,
			};
		}

		const worktreeSuffix = buildParallelWorktreeSuffix(worktreeSetup, artifactsDir, tasks);
		const ok = results.filter((result) => result.exitCode === 0).length;
		const downgradeNote = backgroundRequestedWhileClarifying ? " (background requested, but clarify kept this run foreground)" : "";
		const aggregatedOutput = aggregateParallelOutputs(
			results.map((result) => ({
				agent: result.agent,
				output: result.truncation?.text || getSingleResultOutput(result),
				exitCode: result.exitCode,
				error: result.error,
			})),
			(i, agent) => `=== Task ${i + 1}: ${agent} ===`,
		);

		const summary = `${ok}/${results.length} succeeded${downgradeNote}`;
		const fullContent = worktreeSuffix
			? `${summary}\n\n${aggregatedOutput}\n\n${worktreeSuffix}`
			: `${summary}\n\n${aggregatedOutput}`;

		return {
			content: [{ type: "text", text: fullContent }],
			details,
		};
	} finally {
		if (worktreeSetup) cleanupWorktrees(worktreeSetup);
	}
}


