/**
 * Chain execution helpers and parallel task runner.
 * Extracted from chain-execution.ts.
 */

/**
 * Chain execution logic for subagent tool
 */

import * as path from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentConfig } from "../../agents/agents.ts";
import { toModelInfo, type ModelInfo } from "../../shared/model-info.ts";
import {
	resolveChainTemplates,
	createChainDir,
	removeChainDir,
	resolveStepBehavior,
	resolveParallelBehaviors,
	buildChainInstructions,
	writeInitialProgressFile,
	createParallelDirs,
	suppressProgressForReadOnlyTask,
	aggregateParallelOutputs,
	isDynamicParallelStep,
	isParallelStep,
	type StepOverrides,
	type ChainStep,
	type ParallelStep,
	type SequentialStep,
	type ParallelTaskResult,
	type ResolvedStepBehavior,
	type ResolvedTemplates,
} from "../../shared/settings.ts";
import { INTERCOM_BRIDGE_MARKER } from "../../intercom/intercom-bridge.ts";
import { runSync } from "./execution.ts";
import { compactForegroundDetails, getSingleResultOutput, mapConcurrent, resolveChildCwd } from "../../shared/utils.ts";
import { recordRun } from "../shared/run-history.ts";
import {
	cleanupWorktrees,
	createWorktrees,
	diffWorktrees,
	findWorktreeTaskCwdConflict,
	formatWorktreeDiffSummary,
	formatWorktreeTaskCwdConflict,
	type WorktreeSetup,
} from "../shared/worktree.ts";
import {
	type ActivityState,
	type AgentProgress,
	type ArtifactConfig,
	type ArtifactPaths,
	type ControlEvent,
	type Details,
	type IntercomEventBus,
	type NestedRouteInfo,
	type ResolvedControlConfig,
	type SingleResult,
	MAX_CONCURRENCY,
	resolveChildMaxSubagentDepth,
} from "../../shared/types.ts";
import { resolveModelCandidate } from "../shared/model-fallback.ts";
import { buildWorkflowGraphSnapshot } from "../shared/workflow-graph.ts";
import { ChainOutputValidationError, outputEntryFromResult, resolveOutputReferences, validateChainOutputBindings } from "../shared/chain-outputs.ts";
import { createStructuredOutputRuntime } from "../shared/structured-output.ts";
import type { ChainOutputMap } from "../../shared/types.ts";


export interface ChainExecutionDetailsInput {
	results: SingleResult[];
	includeProgress?: boolean;
	allProgress: AgentProgress[];
	allArtifactPaths: ArtifactPaths[];
	artifactsDir: string;
	chainAgents: string[];
	chainSteps: ChainStep[];
	totalSteps: number;
	currentStepIndex?: number;
	runId: string;
	outputs?: ChainOutputMap;
	currentFlatIndex?: number;
	dynamicChildren?: Record<number, Array<{ agent: string; label?: string; flatIndex: number; itemKey: string; outputName?: string; structured?: boolean; error?: string }>>;
	dynamicGroupStatuses?: Record<number, { status: "pending" | "running" | "completed" | "failed" | "paused" | "detached"; error?: string; acceptance?: SingleResult["acceptance"] }>;
}

interface ParallelChainRunInput {
	step: ParallelStep;
	parallelTemplates: string[];
	parallelBehaviors: ResolvedStepBehavior[];
	agents: AgentConfig[];
	stepIndex: number;
	availableModels: ModelInfo[];
	chainDir: string;
	prev: string;
	originalTask: string;
	ctx: ExtensionContext;
	intercomEvents?: IntercomEventBus;
	cwd?: string;
	runId: string;
	globalTaskIndex: number;
	sessionDirForIndex: (idx?: number) => string | undefined;
	sessionFileForIndex?: (idx?: number) => string | undefined;
	shareEnabled: boolean;
	artifactConfig: ArtifactConfig;
	artifactsDir: string;
	signal?: AbortSignal;
	onUpdate?: (r: AgentToolResult<Details>) => void;
	onControlEvent?: (event: ControlEvent) => void;
	controlConfig: ResolvedControlConfig;
	childIntercomTarget?: (agent: string, index: number) => string | undefined;
	orchestratorIntercomTarget?: string;
	foregroundControl?: {
		updatedAt: number;
		currentAgent?: string;
		currentIndex?: number;
		currentActivityState?: ActivityState;
		lastActivityAt?: number;
		currentTool?: string;
		currentToolStartedAt?: number;
		currentPath?: string;
		turnCount?: number;
		tokens?: number;
		toolCount?: number;
		interrupt?: () => boolean;
	};
	results: SingleResult[];
	allProgress: AgentProgress[];
	outputs: ChainOutputMap;
	chainAgents: string[];
	chainSteps: ChainStep[];
	totalSteps: number;
	dynamicChildren?: ChainExecutionDetailsInput["dynamicChildren"];
	dynamicGroupStatuses?: ChainExecutionDetailsInput["dynamicGroupStatuses"];
	worktreeSetup?: WorktreeSetup;
	maxSubagentDepth: number;
	nestedRoute?: NestedRouteInfo;
}


export function buildChainExecutionDetails(input: ChainExecutionDetailsInput): Details {
	return compactForegroundDetails({
		mode: "chain",
		results: input.results,
		progress: input.includeProgress ? input.allProgress : undefined,
		artifacts: input.allArtifactPaths.length ? { dir: input.artifactsDir, files: input.allArtifactPaths } : undefined,
		chainAgents: input.chainAgents,
		totalSteps: input.totalSteps,
		currentStepIndex: input.currentStepIndex,
		outputs: input.outputs,
	workflowGraph: buildWorkflowGraphSnapshot({
			runId: input.runId,
			mode: "chain",
			steps: input.chainSteps,
			results: input.results,
			currentStepIndex: input.currentStepIndex,
			currentFlatIndex: input.currentFlatIndex,
			dynamicChildren: input.dynamicChildren,
			dynamicGroupStatuses: input.dynamicGroupStatuses,
		}),
	});
}

export function buildChainExecutionErrorResult(message: string, input: ChainExecutionDetailsInput): ChainExecutionResult {
	return {
		content: [{ type: "text", text: message }],
		isError: true,
		details: buildChainExecutionDetails(input),
	};
}

export function ensureParallelProgressFile(
	chainDir: string,
	progressCreated: boolean,
	parallelBehaviors: ResolvedStepBehavior[],
): boolean {
	if (progressCreated || !parallelBehaviors.some((behavior) => behavior.progress)) {
		return progressCreated;
	}
	writeInitialProgressFile(chainDir);
	return true;
}

export function appendParallelWorktreeSummary(
	output: string,
	worktreeSetup: WorktreeSetup | undefined,
	diffsDir: string,
	agents: string[],
): string {
	if (!worktreeSetup) return output;
	const diffs = diffWorktrees(worktreeSetup, agents, diffsDir);
	const diffSummary = formatWorktreeDiffSummary(diffs);
	if (!diffSummary) return output;
	return `${output}\n\n${diffSummary}`;
}

export async function runParallelChainTasks(input: ParallelChainRunInput): Promise<SingleResult[]> {
	const concurrency = input.step.concurrency ?? MAX_CONCURRENCY;
	const failFast = input.step.failFast ?? false;
	let aborted = false;

	const parallelResults = await mapConcurrent(
		input.step.parallel,
		concurrency,
		async (task, taskIndex) => {
			if (aborted && failFast) {
				return {
					agent: task.agent,
					task: "(skipped)",
					exitCode: -1,
					messages: [],
					usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
					error: "Skipped due to fail-fast",
				} as SingleResult;
			}

			const taskTemplate = input.parallelTemplates[taskIndex] ?? "{previous}";
			const behavior = suppressProgressForReadOnlyTask(input.parallelBehaviors[taskIndex]!, taskTemplate, input.originalTask);
			const templateHasPrevious = taskTemplate.includes("{previous}");
			const { prefix, suffix } = buildChainInstructions(
				behavior,
				input.chainDir,
				false,
				templateHasPrevious ? undefined : input.prev,
			);

			let taskStr = resolveOutputReferences(taskTemplate, input.outputs);
			taskStr = taskStr.replace(/\{task\}/g, input.originalTask);
			taskStr = taskStr.replace(/\{previous\}/g, input.prev);
			taskStr = taskStr.replace(/\{chain_dir\}/g, input.chainDir);
			const cleanTask = taskStr;
			taskStr = prefix + taskStr + suffix;

			const taskAgentConfig = input.agents.find((agent) => agent.name === task.agent);
			const effectiveModel =
				(task.model ? resolveModelCandidate(task.model, input.availableModels, input.ctx.model?.provider) : null)
				?? resolveModelCandidate(taskAgentConfig?.model, input.availableModels, input.ctx.model?.provider);
			const maxSubagentDepth = resolveChildMaxSubagentDepth(input.maxSubagentDepth, taskAgentConfig?.maxSubagentDepth);

			const taskCwd = input.worktreeSetup
				? input.worktreeSetup.worktrees[taskIndex]!.agentCwd
				: resolveChildCwd(input.cwd ?? input.ctx.cwd, task.cwd);

			const outputPath = typeof behavior.output === "string"
				? (path.isAbsolute(behavior.output) ? behavior.output : path.join(input.chainDir, behavior.output))
				: undefined;
			const interruptController = new AbortController();
			if (input.foregroundControl) {
				input.foregroundControl.currentAgent = task.agent;
				input.foregroundControl.currentIndex = input.globalTaskIndex + taskIndex;
				input.foregroundControl.currentActivityState = undefined;
				input.foregroundControl.updatedAt = Date.now();
				input.foregroundControl.interrupt = () => {
					if (interruptController.signal.aborted) return false;
					interruptController.abort();
					input.foregroundControl!.currentActivityState = undefined;
					input.foregroundControl!.updatedAt = Date.now();
					return true;
				};
			}

			const structuredRuntime = task.outputSchema
				? createStructuredOutputRuntime(task.outputSchema, path.join(input.chainDir, "structured-output"))
				: undefined;
			const result = await runSync(input.ctx.cwd, input.agents, task.agent, taskStr, {
				cwd: taskCwd,
				signal: input.signal,
				interruptSignal: interruptController.signal,
				allowIntercomDetach: taskAgentConfig?.systemPrompt?.includes(INTERCOM_BRIDGE_MARKER) === true,
				intercomEvents: input.intercomEvents,
				runId: input.runId,
				index: input.globalTaskIndex + taskIndex,
				sessionDir: input.sessionDirForIndex(input.globalTaskIndex + taskIndex),
				sessionFile: input.sessionFileForIndex?.(input.globalTaskIndex + taskIndex),
				share: input.shareEnabled,
				artifactsDir: input.artifactConfig.enabled ? input.artifactsDir : undefined,
				artifactConfig: input.artifactConfig,
				outputPath,
				outputMode: behavior.outputMode,
				maxSubagentDepth,
				controlConfig: input.controlConfig,
				onControlEvent: input.onControlEvent,
				intercomSessionName: input.childIntercomTarget?.(task.agent, input.globalTaskIndex + taskIndex),
				orchestratorIntercomTarget: input.orchestratorIntercomTarget,
				nestedRoute: input.nestedRoute,
				modelOverride: effectiveModel,
				availableModels: input.availableModels,
				preferredModelProvider: input.ctx.model?.provider,
				skills: behavior.skills === false ? [] : behavior.skills,
				structuredOutput: structuredRuntime,
				acceptance: task.acceptance,
				acceptanceContext: { mode: "chain" },
				onUpdate: input.onUpdate
					? (progressUpdate) => {
						const stepResults = progressUpdate.details?.results || [];
						const stepProgress = progressUpdate.details?.progress || [];
						if (input.foregroundControl && stepProgress.length > 0) {
							const current = stepProgress[0];
							input.foregroundControl.currentAgent = task.agent;
							input.foregroundControl.currentIndex = input.globalTaskIndex + taskIndex;
							input.foregroundControl.currentActivityState = current?.activityState;
							input.foregroundControl.lastActivityAt = current?.lastActivityAt;
							input.foregroundControl.currentTool = current?.currentTool;
							input.foregroundControl.currentToolStartedAt = current?.currentToolStartedAt;
							input.foregroundControl.currentPath = current?.currentPath;
							input.foregroundControl.turnCount = current?.turnCount;
							input.foregroundControl.tokens = current?.tokens;
							input.foregroundControl.toolCount = current?.toolCount;
							input.foregroundControl.updatedAt = Date.now();
						}
						input.onUpdate?.({
							...progressUpdate,
							details: {
								mode: "chain",
								results: input.results.concat(stepResults),
								progress: input.allProgress.concat(stepProgress),
								controlEvents: progressUpdate.details?.controlEvents,
								chainAgents: input.chainAgents,
								totalSteps: input.totalSteps,
								currentStepIndex: input.stepIndex,
								outputs: input.outputs,
								workflowGraph: buildWorkflowGraphSnapshot({
									runId: input.runId,
									mode: "chain",
									steps: input.chainSteps,
									results: input.results.concat(stepResults),
									currentStepIndex: input.stepIndex,
									currentFlatIndex: input.globalTaskIndex + taskIndex,
									dynamicChildren: input.dynamicChildren,
									dynamicGroupStatuses: input.dynamicGroupStatuses,
								}),
							},
						});
					}
					: undefined,
			});
			if (input.foregroundControl?.currentIndex === input.globalTaskIndex + taskIndex) {
				input.foregroundControl.interrupt = undefined;
				input.foregroundControl.updatedAt = Date.now();
			}

			if (result.exitCode !== 0 && failFast) {
				aborted = true;
			}
			recordRun(task.agent, cleanTask, result.exitCode, result.progressSummary?.durationMs ?? 0);
			return result;
		},
	);

	return parallelResults;
}

export interface ChainExecutionParams {
	chain: ChainStep[];
	task?: string;
	agents: AgentConfig[];
	ctx: ExtensionContext;
	intercomEvents?: IntercomEventBus;
	signal?: AbortSignal;
	runId: string;
	cwd?: string;
	shareEnabled: boolean;
	sessionDirForIndex: (idx?: number) => string | undefined;
	sessionFileForIndex?: (idx?: number) => string | undefined;
	artifactsDir: string;
	artifactConfig: ArtifactConfig;
	includeProgress?: boolean;
	clarify?: boolean;
	onUpdate?: (r: AgentToolResult<Details>) => void;
	onControlEvent?: (event: ControlEvent) => void;
	controlConfig: ResolvedControlConfig;
	childIntercomTarget?: (agent: string, index: number) => string | undefined;
	orchestratorIntercomTarget?: string;
	foregroundControl?: {
		updatedAt: number;
		currentAgent?: string;
		currentIndex?: number;
		currentActivityState?: ActivityState;
		lastActivityAt?: number;
		currentTool?: string;
		currentToolStartedAt?: number;
		currentPath?: string;
		turnCount?: number;
		tokens?: number;
		toolCount?: number;
		interrupt?: () => boolean;
	};
	chainSkills?: string[];
	chainDir?: string;
	dynamicFanoutMaxItems?: number;
	maxSubagentDepth: number;
	nestedRoute?: NestedRouteInfo;
	worktreeSetupHook?: string;
	worktreeSetupHookTimeoutMs?: number;
}

export interface ChainExecutionResult {
	content: Array<{ type: "text"; text: string }>;
	details: Details;
	isError?: boolean;
	/** User requested async execution via TUI - caller should dispatch to executeAsyncChain */
	requestedAsync?: {
		chain: ChainStep[];
		chainSkills: string[];
	};
}

/**
 * Execute a chain of subagent steps
 */