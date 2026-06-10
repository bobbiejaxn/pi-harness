/**
 * Single path runner — extracted from executor-path-runners.ts.
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



export async function runSinglePath(data: ExecutionContextData, deps: ExecutorDeps): Promise<AgentToolResult<Details>> {
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
		onUpdate,
		sessionRoot,
		controlConfig,
	} = data;
	const onControlEvent = createForegroundControlNotifier(data, deps);
	const childIntercomTarget = data.intercomBridge.active ? resolveSubagentIntercomTarget(runId, params.agent!, 0) : undefined;
	const allProgress: AgentProgress[] = [];
	const allArtifactPaths: ArtifactPaths[] = [];
	const agentConfig = agents.find((a) => a.name === params.agent);
	if (!agentConfig) {
		return {
			content: [{ type: "text", text: `Unknown agent: ${params.agent}` }],
			isError: true,
			details: { mode: "single", results: [] },
		};
	}

	const currentProvider = ctx.model?.provider;
	const availableModels: ModelInfo[] = ctx.modelRegistry.getAvailable().map(toModelInfo);
	let task = params.task ?? "";
	let modelOverride: string | undefined = resolveModelCandidate(
		(params.model as string | undefined) ?? agentConfig.model,
		availableModels,
		currentProvider,
	);
	let skillOverride: string[] | false | undefined = normalizeSkillInput(params.skill);
	const rawOutput = params.output !== undefined ? params.output : agentConfig.output;
	let effectiveOutput = normalizeSingleOutputOverride(rawOutput, agentConfig.output);
	const effectiveOutputMode = params.outputMode ?? "inline";
	const currentMaxSubagentDepth = resolveCurrentMaxSubagentDepth(deps.config.maxSubagentDepth);
	const maxSubagentDepth = resolveChildMaxSubagentDepth(currentMaxSubagentDepth, agentConfig.maxSubagentDepth);

	if (params.clarify === true && ctx.hasUI) {
		const behavior = resolveStepBehavior(agentConfig, { output: effectiveOutput, skills: skillOverride });
		const availableSkills = discoverAvailableSkills(effectiveCwd);

		const result = await ctx.ui.custom<ChainClarifyResult>(
			(tui, theme, _kb, done) =>
				new ChainClarifyComponent(
					tui, theme,
					[agentConfig],
					[task],
					task,
					undefined,
					[behavior],
					availableModels,
					currentProvider,
					availableSkills,
					done,
					"single",
				),
			{ overlay: true, overlayOptions: { anchor: "center", width: 84, maxHeight: "80%" } },
		);

		if (!result || !result.confirmed) {
			return { content: [{ type: "text", text: "Cancelled" }], details: { mode: "single", results: [] } };
		}

		task = result.templates[0]!;
		const override = result.behaviorOverrides[0];
		if (override?.model) modelOverride = override.model;
		if (override?.output !== undefined) effectiveOutput = normalizeSingleOutputOverride(override.output, agentConfig.output);
		if (override?.skills !== undefined) skillOverride = override.skills;

		if (result.runInBackground) {
			if (!isAsyncAvailable()) {
				return {
					content: [{ type: "text", text: "Background mode requires upstream jiti for TypeScript execution but it could not be found. Ensure the pi-subagents package dependencies are installed." }],
					isError: true,
					details: { mode: "single" as const, results: [] },
				};
			}
			const id = randomUUID();
			const asyncCtx = {
				pi: deps.pi,
				cwd: ctx.cwd,
				currentSessionId: deps.state.currentSessionId!,
				currentModelProvider: ctx.model?.provider,
			};
			return executeAsyncSingle(id, {
				agent: params.agent!,
				task: params.context === "fork" ? wrapForkTask(task) : task,
				agentConfig,
				ctx: asyncCtx,
				availableModels,
				cwd: effectiveCwd,
				maxOutput: params.maxOutput,
				artifactsDir: artifactConfig.enabled ? artifactsDir : undefined,
				artifactConfig,
				shareEnabled,
				sessionRoot,
				sessionFile: sessionFileForIndex(0),
				skills: skillOverride === false ? [] : skillOverride,
				output: effectiveOutput,
				outputMode: effectiveOutputMode,
				modelOverride,
				maxSubagentDepth,
				worktreeSetupHook: deps.config.worktreeSetupHook,
				worktreeSetupHookTimeoutMs: deps.config.worktreeSetupHookTimeoutMs,
				controlConfig,
				controlIntercomTarget: data.intercomBridge.active ? data.intercomBridge.orchestratorTarget : undefined,
				childIntercomTarget: data.intercomBridge.active ? (agent, index) => resolveSubagentIntercomTarget(id, agent, index) : undefined,
			});
		}
	}

	if (params.context === "fork") {
		task = wrapForkTask(task);
	}
	const cleanTask = task;
	const outputPath = resolveSingleOutputPath(effectiveOutput, ctx.cwd, effectiveCwd);
	const validationError = validateFileOnlyOutputMode(effectiveOutputMode, outputPath, `Single run (${params.agent})`);
	if (validationError) {
		return { content: [{ type: "text", text: validationError }], isError: true, details: { mode: "single", results: [] } };
	}
	task = injectSingleOutputInstruction(task, outputPath);

	let effectiveSkills: string[] | undefined;
	if (skillOverride === false) {
		effectiveSkills = [];
	} else {
		effectiveSkills = skillOverride;
	}
	const interruptController = new AbortController();
	const foregroundControl = deps.state.foregroundControls.get(runId);
	if (foregroundControl) {
		foregroundControl.currentAgent = params.agent;
		foregroundControl.currentIndex = 0;
		foregroundControl.currentActivityState = undefined;
		foregroundControl.updatedAt = Date.now();
		foregroundControl.interrupt = () => {
			if (interruptController.signal.aborted) return false;
			interruptController.abort();
			foregroundControl.currentActivityState = undefined;
			foregroundControl.updatedAt = Date.now();
			return true;
		};
	}

	const forwardSingleUpdate = onUpdate
		? (update: AgentToolResult<Details>) => {
			if (foregroundControl) {
				const firstProgress = update.details?.progress?.[0];
				foregroundControl.currentAgent = params.agent;
				foregroundControl.currentIndex = firstProgress?.index ?? 0;
				foregroundControl.currentActivityState = firstProgress?.activityState;
				foregroundControl.lastActivityAt = firstProgress?.lastActivityAt;
				foregroundControl.currentTool = firstProgress?.currentTool;
				foregroundControl.currentToolStartedAt = firstProgress?.currentToolStartedAt;
				foregroundControl.currentPath = firstProgress?.currentPath;
				foregroundControl.turnCount = firstProgress?.turnCount;
				foregroundControl.tokens = firstProgress?.tokens;
				foregroundControl.toolCount = firstProgress?.toolCount;
				foregroundControl.updatedAt = Date.now();
			}
			onUpdate(update);
		}
		: undefined;

	// Session learner: get hint for this agent/task
	const learnerHint = deps.sessionLearner?.suggest(params.agent!, task);

	// Circuit breaker: check if agent is blocked
	const breaker = deps.circuitBreaker;
	if (breaker && breaker.isBlocked(params.agent!)) {
		const state = breaker.getState(params.agent!);
		return {
			content: [{ type: "text", text: `⛔ ${state.blockReason ?? `Agent \"${params.agent}\" is circuit-broken`}` }],
			details: { mode: "single" as const, results: [] },
		};
	}

	const r = await runSync(ctx.cwd, agents, params.agent!, task, {
		cwd: effectiveCwd,
		signal,
		interruptSignal: interruptController.signal,
		allowIntercomDetach: agentConfig.systemPrompt?.includes(INTERCOM_BRIDGE_MARKER) === true,
		intercomEvents: deps.pi.events,
		runId,
		sessionDir: sessionDirForIndex(0),
		sessionFile: sessionFileForIndex(0),
		share: shareEnabled,
		artifactsDir: artifactConfig.enabled ? artifactsDir : undefined,
		artifactConfig,
		maxOutput: params.maxOutput,
		outputPath,
		outputMode: effectiveOutputMode,
		maxSubagentDepth,
		onUpdate: forwardSingleUpdate,
		controlConfig,
		onControlEvent,
		intercomSessionName: childIntercomTarget,
		orchestratorIntercomTarget: data.intercomBridge.active ? data.intercomBridge.orchestratorTarget : undefined,
		nestedRoute: foregroundControl?.nestedRoute,
		index: 0,
		modelOverride,
		availableModels,
		preferredModelProvider: currentProvider,
		skills: effectiveSkills,
		acceptance: params.acceptance,
		acceptanceContext: { mode: "single" },
		// Cost & Reliability
		costGuard: deps.costGuardConfig,
		sessionCostTracker: deps.sessionCostTracker,
		timeoutConfig: deps.timeoutConfig,
		spawnDepth: parseInt(process.env.PI_TRACE_SPAWN_DEPTH ?? "0", 10) || 0,
		retryConfig: deps.retryConfig,
		traceRunId: resolveTraceRunId(),
		// Domain & Tool Restrictions
		domain: deps.domain,
		expertise: deps.expertise,
		allowedTools: deps.allowedTools,
		// Execution guard with learner-enhanced timeout
		executionGuard: learnerHint?.suggestedTimeoutMs
			? { ...(deps.config.executionGuard ?? {}), stallTimeoutMs: learnerHint.suggestedTimeoutMs }
			: deps.config.executionGuard,
	});

	// Record result for circuit breaker + session learner
	deps.circuitBreaker?.record(r.agent, r.exitCode, r.error);
	deps.sessionLearner?.observe(r);

	// Surface learner escalation if warranted
	if (learnerHint?.shouldEscalate && learnerHint.escalationReason) {
		r.error = (r.error ? r.error + "\n" : "") + `⚠️ ${learnerHint.escalationReason}`;
	}

	if (foregroundControl?.currentIndex === 0) {
		foregroundControl.interrupt = undefined;
		foregroundControl.currentActivityState = r.progress?.activityState;
		foregroundControl.lastActivityAt = r.progress?.lastActivityAt;
		foregroundControl.currentTool = r.progress?.currentTool;
		foregroundControl.currentToolStartedAt = r.progress?.currentToolStartedAt;
		foregroundControl.currentPath = r.progress?.currentPath;
		foregroundControl.turnCount = r.progress?.turnCount;
		foregroundControl.tokens = r.progress?.tokens;
		foregroundControl.toolCount = r.progress?.toolCount;
		foregroundControl.updatedAt = Date.now();
	}
	recordRun(params.agent!, cleanTask, r.exitCode, r.progressSummary?.durationMs ?? 0);

	if (r.progress) allProgress.push(r.progress);
	if (r.artifactPaths) allArtifactPaths.push(r.artifactPaths);

	const fullOutput = getSingleResultOutput(r);
	const finalizedOutput = finalizeSingleOutput({
		fullOutput,
		truncatedOutput: r.truncation?.text,
		outputPath,
		outputMode: r.outputMode,
		exitCode: r.exitCode,
		savedPath: r.savedOutputPath,
		outputReference: r.outputReference,
		saveError: r.outputSaveError,
	});
	const details = compactForegroundDetails({
		mode: "single",
		runId,
		results: [r],
		progress: params.includeProgress ? allProgress : undefined,
		artifacts: allArtifactPaths.length ? { dir: artifactsDir, files: allArtifactPaths } : undefined,
		truncation: r.truncation,
	});
	rememberForegroundRun(deps.state, { runId, mode: "single", cwd: effectiveCwd, results: details.results });

	if (!r.detached && !r.interrupted) {
		if (foregroundControl) updateForegroundNestedProjection(foregroundControl);
		const intercomReceipt = await maybeBuildForegroundIntercomReceipt({
			pi: deps.pi,
			intercomBridge: data.intercomBridge,
			runId,
			mode: "single",
			details,
			...(foregroundControl?.nestedChildren?.length ? { nestedChildren: foregroundControl.nestedChildren } : {}),
		});
		if (intercomReceipt) {
			return {
				content: [{ type: "text", text: intercomReceipt.text }],
				details: intercomReceipt.details,
				...(r.exitCode !== 0 ? { isError: true } : {}),
			};
		}
	}

	if (r.detached) {
		return {
			content: [{ type: "text", text: `Detached for intercom coordination: ${params.agent}. Reply to the supervisor request first. After the child exits, start a fresh follow-up if needed.` }],
			details,
		};
	}

	if (r.interrupted) {
		return {
			content: [{ type: "text", text: `Run paused after interrupt (${params.agent}). Waiting for explicit next action.` }],
			details,
		};
	}

	if (r.exitCode !== 0)
		return {
			content: [{ type: "text", text: r.error || "Failed" }],
			details,
			isError: true,
		};
	return {
		content: [{ type: "text", text: finalizedOutput.displayOutput || "(no output)" }],
		details,
	};
}
