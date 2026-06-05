/**
 * Structured subagent lifecycle events.
 *
 * Emits canonical events via `pi.events` so external consumers (like
 * pi-agent-observability) can track subagent runs in real-time.
 *
 * Inspired by pi-agent-observability's ObsEvent taxonomy, adapted for
 * the subagent execution lifecycle.
 *
 * ## Event types
 *
 * | Event | When emitted |
 * |-------|-------------|
 * | `subagent.run_start` | A subagent run begins (before spawn) |
 * | `subagent.run_end` | A subagent run completes (success or failure) |
 * | `subagent.run_retry` | A retriable error triggered a retry |
 * | `subagent.cost_checkpoint` | Per-run cost crossed a threshold |
 * | `subagent.budget_exhausted` | Session budget exceeded, call skipped |
 * | `subagent.timeout` | Run killed by cascading timeout |
 * | `subagent.manifest_written` | Per-run manifest JSON persisted to disk |
 *
 * ## Usage
 *
 * ```ts
 * pi.events.on("subagent.run_start", (payload: SubagentRunStartPayload) => {
 *   console.log(`Run ${payload.runId} started: ${payload.agent} — ${payload.task}`);
 * });
 * ```
 */

import type { Usage } from "./types.ts";

// ── Event type constants ─────────────────────────────────────────────────────

/** Emitted when a subagent run begins, before the child process is spawned. */
export const SUBAGENT_RUN_START_EVENT = "subagent.run_start";
/** Emitted when a subagent run completes, whether success or failure. */
export const SUBAGENT_RUN_END_EVENT = "subagent.run_end";
/** Emitted when a retriable error causes the run to be retried. */
export const SUBAGENT_RUN_RETRY_EVENT = "subagent.run_retry";
/** Emitted when per-run cost crosses a checkpoint threshold (25%, 50%, 75%, 100%). */
export const SUBAGENT_COST_CHECKPOINT_EVENT = "subagent.cost_checkpoint";
/** Emitted when session budget is exhausted and a subagent call is skipped. */
export const SUBAGENT_BUDGET_EXHAUSTED_EVENT = "subagent.budget_exhausted";
/** Emitted when a run is killed by the cascading timeout timer. */
export const SUBAGENT_TIMEOUT_EVENT = "subagent.timeout";
/** Emitted after a per-run manifest JSON is written to `.pi/traces/runs/`. */
export const SUBAGENT_MANIFEST_WRITTEN_EVENT = "subagent.manifest_written";

// ── Event Payloads ───────────────────────────────────────────────────────────

/** Payload for `subagent.run_start`. */
export interface SubagentRunStartPayload {
	/** Unique run ID (UUID). */
	runId: string;
	/** Execution mode. */
	mode: "single" | "parallel" | "chain";
	/** Agent name being spawned. */
	agent: string;
	/** The task prompt. */
	task: string;
	/** Current spawn depth (0 = top-level). */
	depth: number;
	/** Working directory for the run. */
	cwd: string;
	/** Whether this is an async (background) run. */
	async: boolean;
	/** Trace run ID for observability correlation. */
	traceRunId?: string;
	/** Name of the parent agent that initiated this run. */
	parentAgent?: string;
}

/** Payload for `subagent.run_end`. */
export interface SubagentRunEndPayload {
	runId: string;
	mode: "single" | "parallel" | "chain";
	agent: string;
	/** Process exit code. 0 = success. */
	exitCode: number;
	/** Token usage and cost for this run. */
	usage: Usage;
	/** Wall-clock duration in milliseconds. */
	durationMs: number;
	/** Whether the run completed without error. */
	success: boolean;
	/** Error message if the run failed. */
	error?: string;
	/** Number of tool calls made during the run. */
	toolCount?: number;
	/** Number of LLM turns in the run. */
	turnCount?: number;
	/** Model used (e.g. "zai/glm-5"). */
	model?: string;
	traceRunId?: string;
}

/** Payload for `subagent.run_retry`. */
export interface SubagentRunRetryPayload {
	runId: string;
	agent: string;
	/** Current retry attempt (1-based). */
	attempt: number;
	/** Maximum retries configured. */
	maxRetries: number;
	/** Delay in ms before this retry attempt. */
	delayMs: number;
	/** Human-readable reason for the retry (e.g. "503 Service Unavailable"). */
	reason: string;
	traceRunId?: string;
}

/** Payload for `subagent.cost_checkpoint`. Emitted at 25%, 50%, 75%, 100% of per-run limit. */
export interface SubagentCostCheckpointPayload {
	runId: string;
	agent: string;
	/** Cumulative cost for this run so far. */
	runCost: number;
	/** Per-run cost limit. */
	runLimit: number;
	/** Cumulative cost for the entire session. */
	sessionCost: number;
	/** Session budget limit. */
	sessionBudget: number;
	traceRunId?: string;
}

/** Payload for `subagent.budget_exhausted`. Emitted when session budget is exceeded. */
export interface SubagentBudgetExhaustedPayload {
	/** Total session spend so far. */
	sessionCost: number;
	/** Configured session budget cap. */
	sessionBudget: number;
	/** Agent name that was skipped. */
	skippedAgent: string;
	traceRunId?: string;
}

/** Payload for `subagent.timeout`. Emitted when a run is killed by the cascade timer. */
export interface SubagentTimeoutPayload {
	runId: string;
	agent: string;
	/** Spawn depth of the killed run. */
	depth: number;
	/** Timeout duration in ms that was exceeded. */
	timeoutMs: number;
	traceRunId?: string;
}

/** Payload for `subagent.manifest_written`. Emitted after manifest JSON is persisted. */
export interface SubagentManifestWrittenPayload {
	runId: string;
	/** Absolute path to the manifest JSON file. */
	manifestPath: string;
	traceRunId?: string;
}

// ── Per-turn cost rollup ────────────────────────────────────────────────────

/** Cost and usage for a single LLM turn within a subagent run. */
export interface TurnCostRollup {
	/** 0-based turn index within the run. */
	turnIndex: number;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	model?: string;
	stopReason?: string;
}

/**
 * Accumulate per-turn cost rollups from message_end events.
 * If a rollup for the given `turnIndex` already exists, merges the usage into it.
 * Otherwise appends a new rollup entry.
 * @returns The mutated rollups array (same reference).
 */
export function accumulateTurnCost(
	rollups: TurnCostRollup[],
	turnIndex: number,
	usage: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; cost?: number },
	model?: string,
	stopReason?: string,
): TurnCostRollup[] {
	const existing = rollups.find((r) => r.turnIndex === turnIndex);
	if (existing) {
		existing.input += usage.input ?? 0;
		existing.output += usage.output ?? 0;
		existing.cacheRead += usage.cacheRead ?? 0;
		existing.cacheWrite += usage.cacheWrite ?? 0;
		existing.cost += usage.cost ?? 0;
		if (model) existing.model = model;
		if (stopReason) existing.stopReason = stopReason;
	} else {
		rollups.push({
			turnIndex,
			input: usage.input ?? 0,
			output: usage.output ?? 0,
			cacheRead: usage.cacheRead ?? 0,
			cacheWrite: usage.cacheWrite ?? 0,
			cost: usage.cost ?? 0,
			model,
			stopReason,
		});
	}
	return rollups;
}

/**
 * Sum all turn rollups into a single Usage-like total.
 * Useful for computing aggregate cost/token counts across all turns.
 */
export function sumTurnRollups(rollups: TurnCostRollup[]): Usage {
	return rollups.reduce(
		(acc, r) => {
			acc.input += r.input;
			acc.output += r.output;
			acc.cacheRead += r.cacheRead;
			acc.cacheWrite += r.cacheWrite;
			acc.cost += r.cost;
			return acc;
		},
		{ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: rollups.length },
	);
}
