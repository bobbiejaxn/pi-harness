/**
 * Parallel group management for subagent runner.
 * Extracted from subagent-runner.ts.
 */

import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import type { Message } from "@earendil-works/pi-ai";
import { writeAtomicJson } from "../../shared/atomic-json.ts";
import { appendJsonl, getArtifactPaths } from "../../shared/artifacts.ts";
import { PI_CODING_AGENT_PACKAGE, getPiSpawnCommand, resolveInstalledPiPackageRoot } from "../shared/pi-spawn.ts";
import { captureSingleOutputSnapshot, finalizeSingleOutput, formatSavedOutputReference, resolveSingleOutput, type SingleOutputSnapshot } from "../shared/single-output.ts";
import {
	type ActivityState,
	type ArtifactConfig,
	type ArtifactPaths,
	type AsyncParallelGroupStatus,
	type AsyncStatus,
	type ChainOutputMap,
	type ModelAttempt,
	type NestedRouteInfo,
	type ResolvedControlConfig,
	type SubagentRunMode,
	type Usage,
	type WorkflowGraphSnapshot,
	DEFAULT_MAX_OUTPUT,
	type MaxOutputConfig,
	truncateOutput,
	getSubagentDepthEnv,
} from "../../shared/types.ts";
import {
	DEFAULT_CONTROL_CONFIG,
	buildControlEvent,
	deriveActivityState,
	claimControlNotification,
	formatControlIntercomMessage,
	formatControlNoticeMessage,
} from "../shared/subagent-control.ts";
import {
	type RunnerSubagentStep as SubagentStep,
	type RunnerStep,
	isDynamicRunnerGroup,
	isParallelGroup,
	flattenSteps,
	mapConcurrent,
	aggregateParallelOutputs,
	MAX_PARALLEL_CONCURRENCY,
} from "../shared/parallel-utils.ts";
import { buildPiArgs, cleanupTempDir } from "../shared/pi-args.ts";
import { outputEntryFromAsyncResult, resolveOutputReferences } from "../shared/chain-outputs.ts";
import { createStructuredOutputRuntime, readStructuredOutput } from "../shared/structured-output.ts";
import { collectDynamicResults, DynamicFanoutError, materializeDynamicParallelStep, validateDynamicCollection } from "../shared/dynamic-fanout.ts";
import { nestedSummaryFromAsyncStatus, writeNestedEvent } from "../shared/nested-events.ts";
import { formatModelAttemptNote, isRetryableModelFailure } from "../shared/model-fallback.ts";
import { attachPostExitStdioGuard, trySignalChild } from "../../shared/post-exit-stdio-guard.ts";
import { detectSubagentError, extractTextFromContent, extractToolArgsPreview, getFinalOutput } from "../../shared/utils.ts";
import { evaluateCompletionMutationGuard } from "../shared/completion-guard.ts";
import {
	createMutatingFailureState,
	didMutatingToolFail,
	isMutatingTool,
	nextLongRunningTrigger,
	recordMutatingFailure,
	resetMutatingFailureState,
	resolveCurrentPath,
	shouldEscalateMutatingFailures,
	summarizeRecentMutatingFailures,
} from "../shared/long-running-guard.ts";
import { parseSessionTokens } from "../../shared/session-tokens.ts";
import type { TokenUsage } from "../../shared/types.ts";
import {
	cleanupWorktrees,
	createWorktrees,
	diffWorktrees,
	findWorktreeTaskCwdConflict,
	formatWorktreeDiffSummary,
	formatWorktreeTaskCwdConflict,
	type WorktreeSetup,
} from "../shared/worktree.ts";
import { resolveEffectiveThinking } from "../../shared/model-info.ts";
import { writeInitialProgressFile } from "../../shared/settings.ts";
import { resolveSubagentIntercomTarget } from "../../intercom/intercom-bridge.ts";
import { acceptanceFailureMessage, aggregateAcceptanceReport, evaluateAcceptance, formatAcceptancePrompt, stripAcceptanceReport } from "../shared/acceptance.ts";

interface SubagentRunConfig {
	id: string;
	steps: RunnerStep[];
	resultPath: string;
	cwd: string;
	placeholder: string;
	taskIndex?: number;
	totalTasks?: number;
	maxOutput?: MaxOutputConfig;
	artifactsDir?: string;
	artifactConfig?: Partial<ArtifactConfig>;
	share?: boolean;
	sessionDir?: string;
	asyncDir: string;
	sessionId?: string | null;
	piPackageRoot?: string;
	piArgv1?: string;
	worktreeSetupHook?: string;
	worktreeSetupHookTimeoutMs?: number;
	controlConfig?: ResolvedControlConfig;
	controlIntercomTarget?: string;
	childIntercomTargets?: Array<string | undefined>;
	resultMode?: SubagentRunMode;
	dynamicFanoutMaxItems?: number;
	workflowGraph?: WorkflowGraphSnapshot;
	nestedRoute?: NestedRouteInfo;
	nestedSelf?: { parentRunId: string; parentStepIndex?: number; depth: number; path?: Array<{ runId: string; stepIndex?: number; agent?: string }> };
}

interface StepResult {
	agent: string;
	output: string;
	error?: string;
	success: boolean;
	exitCode?: number | null;
	skipped?: boolean;
	sessionFile?: string;
	intercomTarget?: string;
	model?: string;
	attemptedModels?: string[];
	modelAttempts?: ModelAttempt[];
	artifactPaths?: ArtifactPaths;
	truncated?: boolean;
	structuredOutput?: unknown;
	structuredOutputPath?: string;
	structuredOutputSchemaPath?: string;
	acceptance?: import("../../shared/types.ts").AcceptanceLedger;
}

const ASYNC_INTERRUPT_SIGNAL: NodeJS.Signals = process.platform === "win32" ? "SIGBREAK" : "SIGUSR2";


// Utility helpers extracted to runner-utils.ts
import {
	findLatestSessionFile,
	emptyUsage,
	tokenUsageFromAttempts,
	appendRecentStepOutput,
	resetStepLiveDetail,
	resolvePiPackageRootFallback,
	exportSessionHtml,
	createShareLink,
	formatDuration,
	writeRunLog,
} from "./runner-utils.ts";



// Streaming functions shared via runner-streaming.ts
import {
	runPiStreaming,
	runSingleStep,
} from "./runner-streaming.ts";


type RunnerStatusStep = NonNullable<AsyncStatus["steps"]>[number] & {
	exitCode?: number | null;
};

type RunnerStatusPayload = Omit<AsyncStatus, "steps" | "parallelGroups" | "pid" | "cwd" | "currentStep" | "chainStepCount" | "lastUpdate"> & {
	pid: number;
	cwd: string;
	currentStep: number;
	chainStepCount: number;
	parallelGroups: AsyncParallelGroupStatus[];
	steps: RunnerStatusStep[];
	lastUpdate: number;
	artifactsDir?: string;
	shareUrl?: string;
	gistUrl?: string;
	shareError?: string;
	error?: string;
};


export function markParallelGroupSetupFailure(input: {
	statusPayload: RunnerStatusPayload;
	results: StepResult[];
	group: Extract<RunnerStep, { parallel: SubagentStep[] }>;
	groupStartFlatIndex: number;
	setupError: string;
	failedAt: number;
	statusPath: string;
	eventsPath: string;
	asyncDir: string;
	runId: string;
	stepIndex: number;
}): void {
	for (let taskIndex = 0; taskIndex < input.group.parallel.length; taskIndex++) {
		const flatTaskIndex = input.groupStartFlatIndex + taskIndex;
		input.statusPayload.steps[flatTaskIndex].status = "failed";
		input.statusPayload.steps[flatTaskIndex].startedAt = input.failedAt;
		input.statusPayload.steps[flatTaskIndex].endedAt = input.failedAt;
		input.statusPayload.steps[flatTaskIndex].durationMs = 0;
		input.statusPayload.steps[flatTaskIndex].exitCode = 1;
		input.results.push({ agent: input.group.parallel[taskIndex].agent, output: input.setupError, success: false, exitCode: 1, sessionFile: input.group.parallel[taskIndex].sessionFile });
	}
	input.statusPayload.currentStep = input.groupStartFlatIndex;
	input.statusPayload.lastUpdate = input.failedAt;
	input.statusPayload.outputFile = path.join(input.asyncDir, `output-${input.groupStartFlatIndex}.log`);
	writeAtomicJson(input.statusPath, input.statusPayload);
	appendJsonl(input.eventsPath, JSON.stringify({
		type: "subagent.parallel.completed",
		ts: input.failedAt,
		runId: input.runId,
		stepIndex: input.stepIndex,
		success: false,
	}));
}

export function markParallelGroupRunning(input: {
	statusPayload: RunnerStatusPayload;
	group: Extract<RunnerStep, { parallel: SubagentStep[] }>;
	groupStartFlatIndex: number;
	groupStartTime: number;
	statusPath: string;
	eventsPath: string;
	asyncDir: string;
	runId: string;
	stepIndex: number;
}): void {
	for (let taskIndex = 0; taskIndex < input.group.parallel.length; taskIndex++) {
		const flatTaskIndex = input.groupStartFlatIndex + taskIndex;
		input.statusPayload.steps[flatTaskIndex].status = "pending";
		input.statusPayload.steps[flatTaskIndex].startedAt = undefined;
		input.statusPayload.steps[flatTaskIndex].endedAt = undefined;
		input.statusPayload.steps[flatTaskIndex].durationMs = undefined;
		input.statusPayload.steps[flatTaskIndex].lastActivityAt = undefined;
		input.statusPayload.steps[flatTaskIndex].activityState = undefined;
		input.statusPayload.steps[flatTaskIndex].error = undefined;
	}
	input.statusPayload.currentStep = input.groupStartFlatIndex;
	input.statusPayload.activityState = undefined;
	input.statusPayload.lastActivityAt = input.groupStartTime;
	input.statusPayload.lastUpdate = input.groupStartTime;
	input.statusPayload.outputFile = path.join(input.asyncDir, `output-${input.groupStartFlatIndex}.log`);
	writeAtomicJson(input.statusPath, input.statusPayload);
	appendJsonl(input.eventsPath, JSON.stringify({
		type: "subagent.parallel.started",
		ts: input.groupStartTime,
		runId: input.runId,
		stepIndex: input.stepIndex,
		agents: input.group.parallel.map((task) => task.agent),
		count: input.group.parallel.length,
	}));
}

export function prepareParallelTaskRun(
	task: SubagentStep,
	cwd: string,
	worktreeSetup: WorktreeSetup | undefined,
	taskIndex: number,
): { taskForRun: SubagentStep; taskCwd: string } {
	if (!worktreeSetup) return { taskForRun: task, taskCwd: cwd };
	return {
		taskForRun: { ...task, cwd: undefined },
		taskCwd: worktreeSetup.worktrees[taskIndex]!.agentCwd,
	};
}

export function appendParallelWorktreeSummary(
	previousOutput: string,
	worktreeSetup: WorktreeSetup | undefined,
	asyncDir: string,
	stepIndex: number,
	group: Extract<RunnerStep, { parallel: SubagentStep[] }>,
): string {
	if (!worktreeSetup) return previousOutput;
	const diffsDir = path.join(asyncDir, "worktree-diffs", `step-${stepIndex}`);
	const diffs = diffWorktrees(worktreeSetup, group.parallel.map((task) => task.agent), diffsDir);
	const diffSummary = formatWorktreeDiffSummary(diffs);
	if (!diffSummary) return previousOutput;
	return `${previousOutput}\n\n${diffSummary}`;
}

export function ensureParallelProgressFile(cwd: string, group: Extract<RunnerStep, { parallel: SubagentStep[] }>): void {
	const progressPath = path.join(cwd, "progress.md");
	if (!group.parallel.some((task) => task.task.includes(`Update progress at: ${progressPath}`))) return;
	writeInitialProgressFile(cwd);
}
