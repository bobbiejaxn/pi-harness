/**
 * Input validation and normalization helpers for subagent execution.
 *
 * Extracted from subagent-executor.ts to keep it under the refactor ceiling.
 * All functions are pure — no closures over executor state.
 */

import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import * as path from "node:path";
import { type AgentConfig } from "../../agents/agents.ts";
import {
	isParallelStep,
	isDynamicParallelStep,
	getStepAgents,
	type ChainStep,
	type SequentialStep,
	type ResolvedStepBehavior,
} from "../../shared/settings.ts";
import { resolveChildCwd } from "../../shared/utils.ts";
import { resolveSingleOutputPath } from "../shared/single-output.ts";
import { resolveMerge, type MergeResolverOptions, type MergeResolutionResult } from "../../shared/merge-resolver.ts";
import {
	cleanupWorktrees,
	createWorktrees,
	diffWorktrees,
	findWorktreeTaskCwdConflict,
	formatWorktreeDiffSummary,
	formatWorktreeTaskCwdConflict,
	type WorktreeSetup,
} from "../shared/worktree.ts";
import type { Details, ExtensionConfig, SingleResult } from "../../shared/types.ts";
import type { SubagentParamsLike, TaskParam } from "./executor-types.ts";

// ── Mode validation ─────────────────────────────────────────────────────────

export function validateExecutionInput(
	params: SubagentParamsLike,
	agents: AgentConfig[],
	hasChain: boolean,
	hasTasks: boolean,
	hasSingle: boolean,
	allowClarifyTaskPrompt: boolean,
): AgentToolResult<Details> | null {
	if (Number(hasChain) + Number(hasTasks) + Number(hasSingle) !== 1) {
		return {
			content: [
				{
					type: "text",
					text: `Provide exactly one mode. Agents: ${agents.map((a) => a.name).join(", ") || "none"}`,
				},
			],
			isError: true,
			details: { mode: "single" as const, results: [] },
		};
	}

	if (hasSingle && params.agent && !agents.find((agent) => agent.name === params.agent)) {
		return {
			content: [{ type: "text", text: `Unknown agent: ${params.agent}` }],
			isError: true,
			details: { mode: "single" as const, results: [] },
		};
	}

	if (hasTasks && params.tasks) {
		for (let i = 0; i < params.tasks.length; i++) {
			const task = params.tasks[i]!;
			if (!agents.find((agent) => agent.name === task.agent)) {
				return {
					content: [{ type: "text", text: `Unknown agent: ${task.agent} (task ${i + 1})` }],
					isError: true,
					details: { mode: "parallel" as const, results: [] },
				};
			}
		}
	}

	if (hasChain && params.chain) {
		if (params.chain.length === 0) {
			return {
				content: [{ type: "text", text: "Chain must have at least one step" }],
				isError: true,
				details: { mode: "chain" as const, results: [] },
			};
		}
		const firstStep = params.chain[0] as ChainStep;
		if (isParallelStep(firstStep)) {
			const missingTaskIndex = firstStep.parallel.findIndex((t) => !t.task);
			if (missingTaskIndex !== -1) {
				return {
					content: [{ type: "text", text: `First parallel step: task ${missingTaskIndex + 1} must have a task (no previous output to reference)` }],
					isError: true,
					details: { mode: "chain" as const, results: [] },
				};
			}
		} else if (isDynamicParallelStep(firstStep)) {
			return {
				content: [{ type: "text", text: "First step in chain cannot be dynamic fanout; expand.from requires a prior structured named output" }],
				isError: true,
				details: { mode: "chain" as const, results: [] },
			};
		} else if (!(firstStep as SequentialStep).task && !params.task && !allowClarifyTaskPrompt) {
			return {
				content: [{ type: "text", text: "First step in chain must have a task" }],
				isError: true,
				details: { mode: "chain" as const, results: [] },
			};
		}
		for (let i = 0; i < params.chain.length; i++) {
			const step = params.chain[i] as ChainStep;
			const stepAgents = getStepAgents(step);
			for (const agentName of stepAgents) {
				if (!agents.find((a) => a.name === agentName)) {
					return {
						content: [{ type: "text", text: `Unknown agent: ${agentName} (step ${i + 1})` }],
						isError: true,
						details: { mode: "chain" as const, results: [] },
					};
				}
			}
			if (isParallelStep(step) && step.parallel.length === 0) {
				return {
					content: [{ type: "text", text: `Parallel step ${i + 1} must have at least one task` }],
					isError: true,
					details: { mode: "chain" as const, results: [] },
				};
			}
		}
	}

	return null;
}

// ── Mode detection ──────────────────────────────────────────────────────────

export function getRequestedModeLabel(params: SubagentParamsLike): Details["mode"] {
	if ((params.chain?.length ?? 0) > 0) return "chain";
	if ((params.tasks?.length ?? 0) > 0) return "parallel";
	if (params.agent) return "single";
	return "single";
}

// ── Context handling ────────────────────────────────────────────────────────

export function applyAgentDefaultContext(params: SubagentParamsLike, agents: AgentConfig[]): SubagentParamsLike {
	if (params.context !== undefined) return params;
	const byName = new Map(agents.map((agent) => [agent.name, agent]));
	const names: string[] = [];
	if (params.agent) names.push(params.agent);
	for (const task of params.tasks ?? []) names.push(task.agent);
	for (const step of params.chain ?? []) names.push(...getStepAgents(step));
	return names.some((name) => byName.get(name)?.defaultContext === "fork")
		? { ...params, context: "fork" }
		: params;
}

// ── Error formatting ────────────────────────────────────────────────────────

export function buildRequestedModeError(params: SubagentParamsLike, message: string): AgentToolResult<Details> {
	return withForkContext(
		{
			content: [{ type: "text", text: message }],
			isError: true,
			details: { mode: getRequestedModeLabel(params), results: [] },
		},
		params.context,
	);
}

export function toExecutionErrorResult(params: SubagentParamsLike, error: unknown): AgentToolResult<Details> {
	const message = error instanceof Error ? error.message : String(error);
	return withForkContext(
		{
			content: [{ type: "text", text: message }],
			isError: true,
			details: { mode: getRequestedModeLabel(params), results: [] },
		},
		params.context,
	);
}

export function buildParallelModeError(message: string): AgentToolResult<Details> {
	return {
		content: [{ type: "text", text: message }],
		isError: true,
		details: { mode: "parallel" as const, results: [] },
	};
}

// ── Count expansion ─────────────────────────────────────────────────────────

export function expandTopLevelTaskCounts(tasks: TaskParam[]): { tasks?: TaskParam[]; error?: string } {
	const expanded: TaskParam[] = [];
	for (let taskIndex = 0; taskIndex < tasks.length; taskIndex++) {
		const task = tasks[taskIndex]!;
		const rawCount = (task as TaskParam & { count?: unknown }).count;
		if (rawCount !== undefined && (typeof rawCount !== "number" || !Number.isInteger(rawCount) || rawCount < 1)) {
			return { error: `tasks[${taskIndex}].count must be an integer >= 1` };
		}
		const { count, ...concreteTask } = task;
		for (let repeat = 0; repeat < (rawCount ?? 1); repeat++) {
			expanded.push({ ...concreteTask });
		}
	}
	return { tasks: expanded };
}

export function expandChainParallelCounts(chain: ChainStep[]): { chain?: ChainStep[]; error?: string } {
	const expandedChain: ChainStep[] = [];
	for (let stepIndex = 0; stepIndex < chain.length; stepIndex++) {
		const step = chain[stepIndex]!;
		if (!isParallelStep(step)) {
			expandedChain.push(step);
			continue;
		}
		const expandedParallel = [];
		for (let taskIndex = 0; taskIndex < step.parallel.length; taskIndex++) {
			const task = step.parallel[taskIndex]!;
			const rawCount = (task as typeof task & { count?: unknown }).count;
			if (rawCount !== undefined && (typeof rawCount !== "number" || !Number.isInteger(rawCount) || rawCount < 1)) {
				return { error: `chain[${stepIndex}].parallel[${taskIndex}].count must be an integer >= 1` };
			}
			const { count, ...concreteTask } = task;
			for (let repeat = 0; repeat < (rawCount ?? 1); repeat++) {
				expandedParallel.push({ ...concreteTask });
			}
		}
		expandedChain.push({ ...step, parallel: expandedParallel });
	}
	return { chain: expandedChain };
}

export function normalizeRepeatedParallelCounts(params: SubagentParamsLike): { params?: SubagentParamsLike; error?: AgentToolResult<Details> } {
	if (params.tasks) {
		const expandedTasks = expandTopLevelTaskCounts(params.tasks);
		if (expandedTasks.error) {
			return { error: buildRequestedModeError(params, expandedTasks.error) };
		}
		return { params: { ...params, tasks: expandedTasks.tasks } };
	}
	if (params.chain) {
		const expandedChain = expandChainParallelCounts(params.chain);
		if (expandedChain.error) {
			return { error: buildRequestedModeError(params, expandedChain.error) };
		}
		return { params: { ...params, chain: expandedChain.chain } };
	}
	return { params };
}

// ── Fork context ────────────────────────────────────────────────────────────

export function withForkContext(
	result: AgentToolResult<Details>,
	context: SubagentParamsLike["context"],
): AgentToolResult<Details> {
	if (context !== "fork" || !result.details) return result;
	return {
		...result,
		details: {
			...result.details,
			context: "fork",
		},
	};
}

// ── Chain session files ─────────────────────────────────────────────────────

export function collectChainSessionFiles(
	chain: ChainStep[],
	sessionFileForIndex: (idx?: number) => string | undefined,
): (string | undefined)[] {
	const sessionFiles: (string | undefined)[] = [];
	let flatIndex = 0;
	for (const step of chain) {
		if (isParallelStep(step)) {
			for (let i = 0; i < step.parallel.length; i++) {
				sessionFiles.push(sessionFileForIndex(flatIndex));
				flatIndex++;
			}
			continue;
		}
		if (isDynamicParallelStep(step)) {
			sessionFiles.push(undefined);
			continue;
		}
		sessionFiles.push(sessionFileForIndex(flatIndex));
		flatIndex++;
	}
	return sessionFiles;
}

export function wrapChainTasksForFork(chain: ChainStep[], context: SubagentParamsLike["context"], wrapForkTask: (task: string) => string): ChainStep[] {
	if (context !== "fork") return chain;
	return chain.map((step, stepIndex) => {
		if (isParallelStep(step)) {
			return {
				...step,
				parallel: step.parallel.map((task) => ({
					...task,
					task: wrapForkTask(task.task ?? "{previous}"),
				})),
			};
		}
		if (isDynamicParallelStep(step)) {
			return {
				...step,
				parallel: {
					...step.parallel,
					task: wrapForkTask(step.parallel.task ?? "{previous}"),
				},
			};
		}
		const sequential = step as SequentialStep;
		return {
			...sequential,
			task: wrapForkTask(sequential.task ?? (stepIndex === 0 ? "{task}" : "{previous}")),
		};
	});
}

// ── Parallel worktree helpers ───────────────────────────────────────────────

export function resolveParallelTaskCwd(
	task: TaskParam,
	paramsCwd: string,
	worktreeSetup: { worktrees: Array<{ agentCwd: string }> } | undefined,
	index: number,
): string {
	if (worktreeSetup) return worktreeSetup.worktrees[index]!.agentCwd;
	return resolveChildCwd(paramsCwd, task.cwd);
}

export function findDuplicateParallelOutputPath(input: {
	tasks: TaskParam[];
	behaviors: (ResolvedStepBehavior | undefined)[];
	paramsCwd: string;
	ctxCwd: string;
	worktreeSetup?: { worktrees: Array<{ agentCwd: string }> };
}): string | undefined {
	const seen = new Map<string, { index: number; agent: string }>();
	for (let index = 0; index < input.tasks.length; index++) {
		const behavior = input.behaviors[index];
		if (!behavior?.output) continue;
		const task = input.tasks[index]!;
		const taskCwd = resolveParallelTaskCwd(task, input.paramsCwd, input.worktreeSetup, index);
		const outputPath = resolveSingleOutputPath(behavior.output, input.ctxCwd, taskCwd);
		if (!outputPath) continue;
		const previous = seen.get(outputPath);
		if (previous) {
			return `Parallel tasks ${previous.index + 1} (${previous.agent}) and ${index + 1} (${task.agent}) resolve output to the same path: ${outputPath}. Use distinct output paths.`;
		}
		seen.set(outputPath, { index, agent: task.agent });
	}
	return undefined;
}

export function createParallelWorktreeSetup(
	enabled: boolean | undefined,
	cwd: string,
	runId: string,
	tasks: TaskParam[],
	setupHook: ExtensionConfig["worktreeSetupHook"],
	setupHookTimeoutMs: ExtensionConfig["worktreeSetupHookTimeoutMs"],
): { setup?: WorktreeSetup; errorResult?: AgentToolResult<Details> } {
	if (!enabled) return {};
	try {
		return {
			setup: createWorktrees(cwd, runId, tasks.length, {
				agents: tasks.map((task) => task.agent),
				setupHook: setupHook
					? { hookPath: setupHook, timeoutMs: setupHookTimeoutMs }
					: undefined,
			}),
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { errorResult: buildParallelModeError(message) };
	}
}

export function buildParallelWorktreeTaskCwdError(
	tasks: ReadonlyArray<{ agent: string; cwd?: string }>,
	sharedCwd: string,
): string | undefined {
	const conflict = findWorktreeTaskCwdConflict(tasks, sharedCwd);
	if (!conflict) return undefined;
	return formatWorktreeTaskCwdConflict(conflict, sharedCwd);
}

export function buildChainWorktreeTaskCwdError(chain: ChainStep[], sharedCwd: string): string | undefined {
	for (let stepIndex = 0; stepIndex < chain.length; stepIndex++) {
		const step = chain[stepIndex]!;
		if (!isParallelStep(step) || !step.worktree) continue;
		const stepCwd = resolveChildCwd(sharedCwd, step.cwd);
		const conflict = findWorktreeTaskCwdConflict(step.parallel, stepCwd);
		if (!conflict) continue;
		const detail = formatWorktreeTaskCwdConflict(conflict, stepCwd);
		return `parallel chain step ${stepIndex + 1}: ${detail}`;
	}
	return undefined;
}

/** Merge successful worktree branches back into the source branch. */
export async function mergeWorktreeResults(
	repoRoot: string,
	worktreeSetup: WorktreeSetup,
	results: SingleResult[],
	options?: MergeResolverOptions,
	parentModel?: string,
): Promise<Array<{ index: number; result: MergeResolutionResult | null }>> {
	const mergeResults: Array<{ index: number; result: MergeResolutionResult | null }> = [];
	const sourceBranch = getCurrentBranch(repoRoot);

	for (let i = 0; i < results.length; i++) {
		const result = results[i]!;
		if (result.exitCode !== 0) {
			mergeResults.push({ index: i, result: null });
			continue;
		}

		const wt = worktreeSetup.worktrees[i];
		if (!wt) {
			mergeResults.push({ index: i, result: null });
			continue;
		}

		try {
			const { execSync } = await import("node:child_process");
			let filesModified: string[] = [];
			try {
				const base = execSync(
					`git merge-base ${sourceBranch} ${wt.branch}`,
					{ cwd: repoRoot, encoding: "utf-8" },
				).trim();
				filesModified = execSync(
					`git diff --name-only ${base} ${wt.branch}`,
					{ cwd: repoRoot, encoding: "utf-8" },
				).trim().split("\n").filter(Boolean);
			} catch { /* best effort */ }

			const mergeResult = await resolveMerge(
				repoRoot,
				wt.branch,
				sourceBranch,
				filesModified,
				parentModel ? { ...options, aiModel: options?.aiModel ?? parentModel } : options,
			);
			mergeResults.push({ index: i, result: mergeResult });
		} catch {
			mergeResults.push({ index: i, result: null });
		}
	}

	return mergeResults;
}

function getCurrentBranch(repoRoot: string): string {
	try {
		const { execSync } = require("node:child_process");
		return execSync("git rev-parse --abbrev-ref HEAD", {
			cwd: repoRoot, encoding: "utf-8",
		}).trim();
	} catch {
		return "main";
	}
}

export function buildParallelWorktreeSuffix(
	worktreeSetup: WorktreeSetup | undefined,
	artifactsDir: string,
	tasks: TaskParam[],
): string {
	if (!worktreeSetup) return "";
	const diffsDir = path.join(artifactsDir, "worktree-diffs");
	const diffs = diffWorktrees(worktreeSetup, tasks.map((task) => task.agent), diffsDir);
	return formatWorktreeDiffSummary(diffs);
}
