/**
 * Async single-agent execution.
 * Extracted from async-execution.ts.
 */

/**
 * Async execution logic for subagent tool
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AgentConfig } from "../../agents/agents.ts";
import { applyThinkingSuffix } from "../shared/pi-args.ts";
import { injectSingleOutputInstruction, normalizeSingleOutputOverride, resolveSingleOutputPath, validateFileOnlyOutputMode } from "../shared/single-output.ts";
import { buildChainInstructions, isDynamicParallelStep, isParallelStep, resolveStepBehavior, suppressProgressForReadOnlyTask, writeInitialProgressFile, type ChainStep, type ResolvedStepBehavior, type SequentialStep, type StepOverrides } from "../../shared/settings.ts";
import type { RunnerStep } from "../shared/parallel-utils.ts";
import { resolvePiPackageRoot } from "../shared/pi-spawn.ts";
import { buildSkillInjection, normalizeSkillInput, resolveSkillsWithFallback } from "../../agents/skills.ts";
import { resolveChildCwd } from "../../shared/utils.ts";
import { buildModelCandidates, resolveModelCandidate, type AvailableModelInfo } from "../shared/model-fallback.ts";
import { resolveEffectiveThinking } from "../../shared/model-info.ts";
import { resolveExpectedWorktreeAgentCwd } from "../shared/worktree.ts";
import { buildWorkflowGraphSnapshot } from "../shared/workflow-graph.ts";
import { ChainOutputValidationError, validateChainOutputBindings } from "../shared/chain-outputs.ts";
import { createStructuredOutputRuntime } from "../shared/structured-output.ts";
import { resolveEffectiveAcceptance } from "../shared/acceptance.ts";
import {
	type AcceptanceInput,
	type ArtifactConfig,
	type Details,
	type MaxOutputConfig,
	type NestedRouteInfo,
	type ResolvedControlConfig,
	type SubagentRunMode,
	ASYNC_DIR,
	RESULTS_DIR,
	SUBAGENT_ASYNC_STARTED_EVENT,
	TEMP_ROOT_DIR,
	getAsyncConfigPath,
	resolveChildMaxSubagentDepth,
} from "../../shared/types.ts";
import { nestedResultsPath, resolveInheritedNestedRouteFromEnv, resolveNestedParentAddressFromEnv, writeNestedEvent } from "../shared/nested-events.ts";
import { resolveTraceRunId, buildTraceEnv, resolveSpawnDepth, writePidFile, removePidFile } from "../../shared/trace-propagation.ts";

// Helpers extracted to async-helpers.ts
import {
	spawnRunner,
	formatAsyncStartError,
} from "./async-helpers.ts";

// Re-export for backward compat
export { formatAsyncStartedMessage, isAsyncAvailable } from "./async-helpers.ts";


const require = createRequire(import.meta.url);
const piPackageRoot = resolvePiPackageRoot();
export function executeAsyncChain(
	id: string,
	params: AsyncChainParams,
): AsyncExecutionResult {
	const {
		chain,
		agents,
		ctx,
		cwd,
		maxOutput,
		artifactsDir,
		artifactConfig,
		shareEnabled,
		sessionRoot,
		sessionFilesByFlatIndex,
		maxSubagentDepth,
		worktreeSetupHook,
		worktreeSetupHookTimeoutMs,
		controlConfig,
		controlIntercomTarget,
		childIntercomTarget,
		nestedRoute,
	} = params;
	const resultMode = params.resultMode ?? "chain";
	const chainSkills = params.chainSkills ?? [];
	const availableModels = params.availableModels;
	const runnerCwd = resolveChildCwd(ctx.cwd, cwd);
	const firstStep = chain[0];
	const originalTask = params.task ?? (firstStep
		? (isParallelStep(firstStep)
			? firstStep.parallel[0]?.task
			: isDynamicParallelStep(firstStep)
				? firstStep.parallel.task
				: (firstStep as SequentialStep).task)
		: undefined);
	try {
		validateChainOutputBindings(chain, { maxItems: params.dynamicFanoutMaxItems });
	} catch (error) {
		if (error instanceof ChainOutputValidationError) return formatAsyncStartError(resultMode, error.message);
		throw error;
	}
	const workflowGraph = buildWorkflowGraphSnapshot({ runId: id, mode: resultMode, steps: chain });

	for (const s of chain) {
		const stepAgents = isParallelStep(s)
			? s.parallel.map((t) => t.agent)
			: isDynamicParallelStep(s)
				? [s.parallel.agent]
			: [(s as SequentialStep).agent];
		for (const agentName of stepAgents) {
			if (!agents.find((x) => x.name === agentName)) {
				return {
					content: [{ type: "text", text: `Unknown agent: ${agentName}` }],
					isError: true,
					details: { mode: resultMode, results: [] },
				};
			}
		}
	}

	const inheritedNestedRoute = resolveInheritedNestedRouteFromEnv();
	const nestedAddress = inheritedNestedRoute ? resolveNestedParentAddressFromEnv() : undefined;
	const asyncDir = inheritedNestedRoute
		? path.join(TEMP_ROOT_DIR, "nested-subagent-runs", inheritedNestedRoute.rootRunId, id)
		: path.join(ASYNC_DIR, id);
	try {
		fs.mkdirSync(asyncDir, { recursive: true });
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return {
			content: [{ type: "text", text: `Failed to create async run directory '${asyncDir}': ${message}` }],
			isError: true,
			details: { mode: resultMode, results: [] },
		};
	}

	let progressInstructionCreated = false;
	const buildStepOverrides = (s: SequentialStep): StepOverrides => {
		const stepSkillInput = normalizeSkillInput(s.skill);
		return {
			...(s.output !== undefined ? { output: s.output } : {}),
			...(s.outputMode !== undefined ? { outputMode: s.outputMode } : {}),
			...(s.reads !== undefined ? { reads: s.reads } : {}),
			...(s.progress !== undefined ? { progress: s.progress } : {}),
			...(stepSkillInput !== undefined ? { skills: stepSkillInput } : {}),
			...(s.model ? { model: s.model } : {}),
		};
	};
	const buildSeqStep = (s: SequentialStep, sessionFile?: string, behaviorCwd?: string, progressPrecreated = false, resolvedBehavior?: ResolvedStepBehavior) => {
		const a = agents.find((x) => x.name === s.agent)!;
		const stepCwd = resolveChildCwd(runnerCwd, s.cwd);
		const instructionCwd = behaviorCwd ?? stepCwd;
		const behavior = suppressProgressForReadOnlyTask(resolvedBehavior ?? resolveStepBehavior(a, buildStepOverrides(s), chainSkills), s.task, originalTask);
		const skillNames = behavior.skills === false ? [] : behavior.skills;
		const { resolved: resolvedSkills, missing: missingSkills } = resolveSkillsWithFallback(skillNames, stepCwd, ctx.cwd);
		if (missingSkills.includes("pi-subagents")) throw new UnavailableSubagentSkillError(UNAVAILABLE_SUBAGENT_SKILL_ERROR);

		let systemPrompt = a.systemPrompt?.trim() ?? "";
		if (resolvedSkills.length > 0) {
			const injection = buildSkillInjection(resolvedSkills);
			systemPrompt = systemPrompt ? `${systemPrompt}\n\n${injection}` : injection;
		}

		const readInstructions = buildChainInstructions({ ...behavior, output: false, progress: false }, instructionCwd, false);
		const isFirstProgressAgent = behavior.progress && !progressPrecreated && !progressInstructionCreated;
		if (behavior.progress) progressInstructionCreated = true;
		const progressInstructions = buildChainInstructions({ ...behavior, output: false, reads: false }, runnerCwd, isFirstProgressAgent);
		const outputPath = resolveSingleOutputPath(behavior.output, ctx.cwd, instructionCwd);
		const validationError = validateFileOnlyOutputMode(behavior.outputMode, outputPath, `Async step (${s.agent})`);
		if (validationError) throw new AsyncStartValidationError(validationError);
		let taskTemplate = s.task ?? "{previous}";
		taskTemplate = taskTemplate.replace(/\{task\}/g, originalTask ?? "");
		taskTemplate = taskTemplate.replace(/\{chain_dir\}/g, runnerCwd);
		const task = injectSingleOutputInstruction(`${readInstructions.prefix}${taskTemplate}${progressInstructions.suffix}`, outputPath);

		const primaryModel = resolveModelCandidate(behavior.model ?? a.model, availableModels, ctx.currentModelProvider);
		const model = applyThinkingSuffix(primaryModel, a.thinking);
		return {
			agent: s.agent,
			task,
			phase: s.phase,
			label: s.label,
			outputName: s.as,
			structured: Boolean(s.outputSchema),
			cwd: stepCwd,
			model,
			thinking: resolveEffectiveThinking(model, a.thinking),
			modelCandidates: buildModelCandidates(behavior.model ?? a.model, a.fallbackModels, availableModels, ctx.currentModelProvider).map((candidate) =>
				applyThinkingSuffix(candidate, a.thinking),
			),
			tools: a.tools,
			extensions: a.extensions,
			mcpDirectTools: a.mcpDirectTools,
			completionGuard: a.completionGuard,
			systemPrompt,
			systemPromptMode: a.systemPromptMode,
			inheritProjectContext: a.inheritProjectContext,
			inheritSkills: a.inheritSkills,
			skills: resolvedSkills.map((r) => r.name),
			outputPath,
			outputMode: behavior.outputMode,
			sessionFile,
			maxSubagentDepth: resolveChildMaxSubagentDepth(maxSubagentDepth, a.maxSubagentDepth),
			effectiveAcceptance: resolveEffectiveAcceptance({
				explicit: s.acceptance,
				agentName: s.agent,
				task: s.task,
				mode: resultMode,
				async: true,
				dynamic: false,
			}),
			...(s.outputSchema ? { structuredOutputSchema: s.outputSchema } : {}),
			...(s.outputSchema ? { structuredOutput: createStructuredOutputRuntime(s.outputSchema, path.join(asyncDir, "structured-output")) } : {}),
		};
	};

	let flatStepIndex = 0;
	const nextSessionFile = (): string | undefined => {
		const sessionFile = sessionFilesByFlatIndex?.[flatStepIndex];
		flatStepIndex++;
		return sessionFile;
	};

	let steps: RunnerStep[];
	try {
		steps = chain.map((s, stepIndex) => {
			if (isParallelStep(s)) {
				const parallelBehaviors = s.parallel.map((task) => {
					const agent = agents.find((candidate) => candidate.name === task.agent)!;
					return suppressProgressForReadOnlyTask(resolveStepBehavior(agent, buildStepOverrides(task), chainSkills), task.task, originalTask);
				});
				const progressPrecreated = parallelBehaviors.some((behavior) => behavior.progress);
				if (progressPrecreated) {
					if (!s.worktree) writeInitialProgressFile(runnerCwd);
					progressInstructionCreated = true;
				}
				return {
					parallel: s.parallel.map((t, taskIndex) => {
						let behaviorCwd: string | undefined;
						if (s.worktree) {
							try {
								behaviorCwd = resolveExpectedWorktreeAgentCwd(runnerCwd, `${id}-s${stepIndex}`, taskIndex);
							} catch {
								behaviorCwd = undefined;
							}
						}
						return buildSeqStep(t, nextSessionFile(), behaviorCwd, progressPrecreated, parallelBehaviors[taskIndex]);
					}),
					concurrency: s.concurrency,
					failFast: s.failFast,
					worktree: s.worktree,
				};
			}
			if (isDynamicParallelStep(s)) {
				const agent = agents.find((candidate) => candidate.name === s.parallel.agent)!;
				const behavior = suppressProgressForReadOnlyTask(resolveStepBehavior(agent, buildStepOverrides(s.parallel), chainSkills), s.parallel.task, originalTask);
				const progressPrecreated = behavior.progress;
				if (progressPrecreated) {
					writeInitialProgressFile(runnerCwd);
					progressInstructionCreated = true;
				}
				return {
					expand: s.expand,
					parallel: buildSeqStep(s.parallel as SequentialStep, undefined, undefined, progressPrecreated, behavior),
					collect: s.collect,
					concurrency: s.concurrency,
					failFast: s.failFast,
					phase: s.phase,
					label: s.label,
					effectiveAcceptance: resolveEffectiveAcceptance({
						explicit: s.acceptance,
						agentName: s.parallel.agent,
						task: s.parallel.task,
						mode: resultMode,
						async: true,
						dynamicGroup: true,
					}),
				};
			}
			return buildSeqStep(s as SequentialStep, nextSessionFile());
		});
	} catch (error) {
		if (error instanceof UnavailableSubagentSkillError || error instanceof AsyncStartValidationError) return formatAsyncStartError(resultMode, error.message);
		throw error;
	}
	let childTargetIndex = 0;
	const childIntercomTargets = childIntercomTarget ? steps.flatMap((step) => {
		if ("parallel" in step) {
			if (!Array.isArray(step.parallel)) {
				childTargetIndex++;
				return [undefined];
			}
			return step.parallel.map((task) => childIntercomTarget(task.agent, childTargetIndex++));
		}
		return [childIntercomTarget(step.agent, childTargetIndex++)];
	}) : undefined;

	let spawnResult: { pid?: number; error?: string } = {};
	try {
		spawnResult = spawnRunner(
			{
				id,
				steps,
				resultPath: inheritedNestedRoute ? nestedResultsPath(inheritedNestedRoute.rootRunId, id) : path.join(RESULTS_DIR, `${id}.json`),
				cwd: runnerCwd,
				placeholder: "{previous}",
				maxOutput,
				artifactsDir: artifactConfig.enabled ? artifactsDir : undefined,
				artifactConfig,
				share: shareEnabled,
				sessionDir: sessionRoot ? path.join(sessionRoot, `async-${id}`) : undefined,
				asyncDir,
				sessionId: ctx.currentSessionId,
				piPackageRoot,
				piArgv1: process.argv[1],
				worktreeSetupHook,
				worktreeSetupHookTimeoutMs,
				controlConfig,
				controlIntercomTarget,
				childIntercomTargets,
				resultMode,
				dynamicFanoutMaxItems: params.dynamicFanoutMaxItems,
				workflowGraph,
				nestedRoute: nestedRoute ?? inheritedNestedRoute,
				nestedSelf: inheritedNestedRoute && nestedAddress ? {
					parentRunId: nestedAddress.parentRunId,
					parentStepIndex: nestedAddress.parentStepIndex,
					depth: nestedAddress.depth,
					path: nestedAddress.path,
				} : undefined,
			},
			id,
			runnerCwd,
			buildTraceEnv(resolveTraceRunId(), "async-chain", resolveSpawnDepth()),
		);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return formatAsyncStartError(resultMode, `Failed to start async ${resultMode} '${id}': ${message}`);
	}

	if (spawnResult.error) {
		return formatAsyncStartError(resultMode, `Failed to start async ${resultMode} '${id}': ${spawnResult.error}`);
	}

	if (spawnResult.pid) {
		const firstStep = chain[0];
		const firstAgents = isParallelStep(firstStep)
			? firstStep.parallel.map((t) => t.agent)
			: isDynamicParallelStep(firstStep)
				? [firstStep.parallel.agent]
			: [(firstStep as SequentialStep).agent];
		const parallelGroups: Array<{ start: number; count: number; stepIndex: number }> = [];
		const flatAgents: string[] = [];
		let flatStepStart = 0;
		for (let stepIndex = 0; stepIndex < chain.length; stepIndex++) {
			const step = chain[stepIndex]!;
			if (isParallelStep(step)) {
				parallelGroups.push({ start: flatStepStart, count: step.parallel.length, stepIndex });
				flatAgents.push(...step.parallel.map((task) => task.agent));
				flatStepStart += step.parallel.length;
			} else if (isDynamicParallelStep(step)) {
				parallelGroups.push({ start: flatStepStart, count: 1, stepIndex });
				flatAgents.push(step.parallel.agent);
				flatStepStart++;
			} else {
				flatAgents.push((step as SequentialStep).agent);
				flatStepStart++;
			}
		}
		if (inheritedNestedRoute && nestedAddress) {
			const now = Date.now();
			try {
				writeNestedEvent(inheritedNestedRoute, {
					type: "subagent.nested.started",
					ts: now,
					parentRunId: nestedAddress.parentRunId,
					parentStepIndex: nestedAddress.parentStepIndex,
					child: {
						id,
						parentRunId: nestedAddress.parentRunId,
						parentStepIndex: nestedAddress.parentStepIndex,
						depth: nestedAddress.depth,
						path: nestedAddress.path,
						asyncDir,
						pid: spawnResult.pid,
						ownerIntercomTarget: process.env.PI_SUBAGENT_INTERCOM_SESSION_NAME,
						leafIntercomTarget: childIntercomTargets?.[0],
						intercomTarget: childIntercomTargets?.[0],
						ownerState: "live",
						mode: resultMode,
						state: "running",
						agent: firstAgents[0],
						agents: flatAgents,
						chainStepCount: chain.length,
						parallelGroups,
						startedAt: now,
						lastUpdate: now,
					},
				});
			} catch (error) {
				console.error("Failed to emit nested async start event:", error);
			}
		}
		ctx.pi.events.emit(SUBAGENT_ASYNC_STARTED_EVENT, {
			id,
			pid: spawnResult.pid,
			sessionId: ctx.currentSessionId,
			mode: resultMode,
			agent: firstAgents[0],
			agents: flatAgents,
			task: isParallelStep(firstStep)
				? firstStep.parallel[0]?.task?.slice(0, 50)
				: isDynamicParallelStep(firstStep)
					? firstStep.parallel.task?.slice(0, 50)
				: (firstStep as SequentialStep).task?.slice(0, 50),
			chain: chain.map((s) =>
				isParallelStep(s) ? `[${s.parallel.map((t) => t.agent).join("+")}]` : isDynamicParallelStep(s) ? `expand:${s.parallel.agent}` : (s as SequentialStep).agent,
			),
			chainStepCount: chain.length,
			parallelGroups,
			workflowGraph,
			cwd: runnerCwd,
			asyncDir,
			nestedRoute,
		});
	}

	const chainDesc = chain
		.map((s) =>
			isParallelStep(s) ? `[${s.parallel.map((t) => t.agent).join("+")}]` : isDynamicParallelStep(s) ? `expand:${s.parallel.agent}` : (s as SequentialStep).agent,
		)
		.join(" -> ");

	return {
		content: [{ type: "text", text: formatAsyncStartedMessage(`Async ${resultMode}: ${chainDesc} [${id}]`) }],
		details: { mode: resultMode, runId: id, results: [], asyncId: id, asyncDir, workflowGraph },
	};
}

/**
 * Execute a single agent asynchronously
 */
export function executeAsyncSingle(
	id: string,
	params: AsyncSingleParams,
): AsyncExecutionResult {
	const {
		agent,
		agentConfig,
		ctx,
		cwd,
		maxOutput,
		artifactsDir,
		artifactConfig,
		shareEnabled,
		sessionRoot,
		sessionFile,
		maxSubagentDepth,
		worktreeSetupHook,
		worktreeSetupHookTimeoutMs,
		controlConfig,
		controlIntercomTarget,
		childIntercomTarget,
		nestedRoute,
	} = params;
	const task = params.task ?? "";
	const runnerCwd = resolveChildCwd(ctx.cwd, cwd);
	const skillNames = params.skills ?? agentConfig.skills ?? [];
	const availableModels = params.availableModels;
	const { resolved: resolvedSkills, missing: missingSkills } = resolveSkillsWithFallback(skillNames, runnerCwd, ctx.cwd);
	if (missingSkills.includes("pi-subagents")) return formatAsyncStartError("single", UNAVAILABLE_SUBAGENT_SKILL_ERROR);
	let systemPrompt = agentConfig.systemPrompt?.trim() ?? "";
	if (resolvedSkills.length > 0) {
		const injection = buildSkillInjection(resolvedSkills);
		systemPrompt = systemPrompt ? `${systemPrompt}\n\n${injection}` : injection;
	}

	const inheritedNestedRoute = resolveInheritedNestedRouteFromEnv();
	const nestedAddress = inheritedNestedRoute ? resolveNestedParentAddressFromEnv() : undefined;
	const asyncDir = inheritedNestedRoute
		? path.join(TEMP_ROOT_DIR, "nested-subagent-runs", inheritedNestedRoute.rootRunId, id)
		: path.join(ASYNC_DIR, id);
	try {
		fs.mkdirSync(asyncDir, { recursive: true });
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return {
			content: [{ type: "text", text: `Failed to create async run directory '${asyncDir}': ${message}` }],
			isError: true,
			details: { mode: "single" as const, results: [] },
		};
	}

	const effectiveOutput = normalizeSingleOutputOverride(params.output, agentConfig.output);
	const outputPath = resolveSingleOutputPath(effectiveOutput, ctx.cwd, runnerCwd);
	const outputMode = params.outputMode ?? "inline";
	const validationError = validateFileOnlyOutputMode(outputMode, outputPath, `Async single run (${agent})`);
	if (validationError) return formatAsyncStartError("single", validationError);
	const taskWithOutputInstruction = injectSingleOutputInstruction(task, outputPath);
	const model = applyThinkingSuffix(
		resolveModelCandidate(params.modelOverride ?? agentConfig.model, availableModels, ctx.currentModelProvider),
		agentConfig.thinking,
	);
	let spawnResult: { pid?: number; error?: string } = {};
	try {
		spawnResult = spawnRunner(
			{
				id,
				steps: [
					{
						agent,
						task: taskWithOutputInstruction,
						cwd: runnerCwd,
						model,
						thinking: resolveEffectiveThinking(model, agentConfig.thinking),
						modelCandidates: buildModelCandidates(params.modelOverride ?? agentConfig.model, agentConfig.fallbackModels, availableModels, ctx.currentModelProvider).map((candidate) =>
							applyThinkingSuffix(candidate, agentConfig.thinking),
						),
						tools: agentConfig.tools,
						extensions: agentConfig.extensions,
						mcpDirectTools: agentConfig.mcpDirectTools,
						completionGuard: agentConfig.completionGuard,
						systemPrompt,
						systemPromptMode: agentConfig.systemPromptMode,
						inheritProjectContext: agentConfig.inheritProjectContext,
						inheritSkills: agentConfig.inheritSkills,
						skills: resolvedSkills.map((r) => r.name),
						outputPath,
						outputMode,
						sessionFile,
						maxSubagentDepth: resolveChildMaxSubagentDepth(maxSubagentDepth, agentConfig.maxSubagentDepth),
						effectiveAcceptance: resolveEffectiveAcceptance({
							explicit: params.acceptance,
							agentName: agent,
							task,
							mode: "single",
							async: true,
						}),
					},
				],
				resultPath: inheritedNestedRoute ? nestedResultsPath(inheritedNestedRoute.rootRunId, id) : path.join(RESULTS_DIR, `${id}.json`),
				cwd: runnerCwd,
				placeholder: "{previous}",
				maxOutput,
				artifactsDir: artifactConfig.enabled ? artifactsDir : undefined,
				artifactConfig,
				share: shareEnabled,
				sessionDir: sessionRoot ? path.join(sessionRoot, `async-${id}`) : undefined,
				asyncDir,
				sessionId: ctx.currentSessionId,
				piPackageRoot,
				piArgv1: process.argv[1],
				worktreeSetupHook,
				worktreeSetupHookTimeoutMs,
				controlConfig,
				controlIntercomTarget,
				childIntercomTargets: childIntercomTarget ? [childIntercomTarget(agent, 0)] : undefined,
				resultMode: "single",
				nestedRoute: nestedRoute ?? inheritedNestedRoute,
				nestedSelf: inheritedNestedRoute && nestedAddress ? {
					parentRunId: nestedAddress.parentRunId,
					parentStepIndex: nestedAddress.parentStepIndex,
					depth: nestedAddress.depth,
					path: nestedAddress.path,
				} : undefined,
			},
			id,
			runnerCwd,
			buildTraceEnv(resolveTraceRunId(), agent, resolveSpawnDepth()),
		);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return formatAsyncStartError("single", `Failed to start async run '${id}': ${message}`);
	}

	if (spawnResult.error) {
		return formatAsyncStartError("single", `Failed to start async run '${id}': ${spawnResult.error}`);
	}

	if (spawnResult.pid) {
		if (inheritedNestedRoute && nestedAddress) {
			const now = Date.now();
			try {
				writeNestedEvent(inheritedNestedRoute, {
					type: "subagent.nested.started",
					ts: now,
					parentRunId: nestedAddress.parentRunId,
					parentStepIndex: nestedAddress.parentStepIndex,
					child: {
						id,
						parentRunId: nestedAddress.parentRunId,
						parentStepIndex: nestedAddress.parentStepIndex,
						depth: nestedAddress.depth,
						path: nestedAddress.path,
						asyncDir,
						pid: spawnResult.pid,
						ownerIntercomTarget: process.env.PI_SUBAGENT_INTERCOM_SESSION_NAME,
						leafIntercomTarget: childIntercomTarget?.(agent, 0),
						intercomTarget: childIntercomTarget?.(agent, 0),
						ownerState: "live",
						mode: "single",
						state: "running",
						agent,
						agents: [agent],
						chainStepCount: 1,
						startedAt: now,
						lastUpdate: now,
					},
				});
			} catch (error) {
				console.error("Failed to emit nested async start event:", error);
			}
		}
		ctx.pi.events.emit(SUBAGENT_ASYNC_STARTED_EVENT, {
			id,
			pid: spawnResult.pid,
			sessionId: ctx.currentSessionId,
			mode: "single",
			agent,
			task: task?.slice(0, 50),
			cwd: runnerCwd,
			asyncDir,
			nestedRoute,
		});
	}

	return {
		content: [{ type: "text", text: formatAsyncStartedMessage(`Async: ${agent} [${id}]`) }],
		details: { mode: "single", runId: id, results: [], asyncId: id, asyncDir },
	};
}
