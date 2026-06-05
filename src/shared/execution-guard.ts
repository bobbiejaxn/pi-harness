/**
 * Execution Guard — real-time stuck-agent detection during child process runs.
 *
 * Observes the JSON line protocol stream from a child `pi` process and detects
 * three stuck patterns that static timeouts miss:
 *
 * 1. **Turn limit** — agent loops endlessly across turns without finishing.
 *    Kills after N turns (default 50).
 *
 * 2. **Repetition detection** — agent calls the same tool with the same args
 *    repeatedly, stuck in a loop. Kills after N identical calls (default 3).
 *
 * 3. **Stall detection** — agent produces no output for a configurable period.
 *    Kills if no event arrives within the stall window (default 120s).
 *
 * ## Why this exists alongside cascading timeouts
 *
 * The cascading timeout kills the process after a wall-clock limit (e.g. 15 min).
 * But an agent can loop for 14 minutes making tool calls every 30 seconds and
 * never trigger it — it looks "active" but is stuck in a circle.
 *
 * The execution guard catches *semantic* stuckness, not just *temporal* stuckness.
 *
 * ## Usage
 *
 * ```ts
 * const guard = new ExecutionGuard({
 *   maxTurns: 50,
 *   maxRepetitions: 3,
 *   stallTimeoutMs: 120_000,
 * });
 *
 * // In the stream processing loop:
 * const action = guard.processEvent(evt);
 * if (action?.type === "kill") {
 *   proc.kill("SIGTERM");
 * }
 *
 * // Start stall timer after process spawns
 * guard.startStallTimer(() => proc.kill("SIGTERM"));
 *
 * // Clean up on process exit
 * guard.destroy();
 * ```
 */

// ── Types ────────────────────────────────────────────────────────────────────

/** Configuration for the execution guard. All fields optional — sensible defaults. */
export interface ExecutionGuardConfig {
	/** Maximum turns before kill. Default: 50. Set to 0 to disable. */
	maxTurns?: number;
	/** Maximum identical tool calls before kill. Default: 3. Set to 0 to disable. */
	maxRepetitions?: number;
	/** Milliseconds with no event before kill. Default: 120_000 (2 min). Set to 0 to disable. */
	stallTimeoutMs?: number;
}

/** A structured event from the child's JSON line protocol. */
export interface StreamEvent {
	type?: string;
	toolName?: string;
	args?: unknown;
	message?: {
		role?: string;
		stopReason?: string;
	};
	[key: string]: unknown;
}

/** Action returned by the guard after processing an event. */
export type GuardAction =
	| { type: "kill"; reason: string }
	| { type: "warn"; reason: string };

/** Reason the guard killed (or would kill) the process. */
export type KillReason = "turn_limit" | "repetition" | "stall";

/** Snapshot of the guard's state, for diagnostics and logging. */
export interface ExecutionGuardState {
	/** Number of turns observed. */
	turnCount: number;
	/** Last N tool calls seen (name + args hash). */
	recentToolCalls: Array<{ tool: string; argsHash: string; timestamp: number }>;
	/** Timestamp of the last event received. */
	lastEventAt: number | null;
	/** Whether the guard has triggered a kill. */
	killedBy: KillReason | null;
	/** Whether the guard is active (not destroyed). */
	active: boolean;
}

// ── Internal ─────────────────────────────────────────────────────────────────

const DEFAULT_MAX_TURNS = 50;
const DEFAULT_MAX_REPETITIONS = 3;
const DEFAULT_STALL_TIMEOUT_MS = 120_000;

/** Simple hash for tool call args — used for repetition detection. */
function hashArgs(args: unknown): string {
	if (args === undefined || args === null) return "";
	if (typeof args === "string") return args;
	try {
		return JSON.stringify(args);
	} catch {
		return String(args);
	}
}

// ── Execution Guard ──────────────────────────────────────────────────────────

export class ExecutionGuard {
	private readonly maxTurns: number;
	private readonly maxRepetitions: number;
	private readonly stallTimeoutMs: number;

	private turnCount = 0;
	private readonly recentToolCalls: Array<{ tool: string; argsHash: string; timestamp: number }> = [];
	private lastEventAt: number | null = null;
	private killedBy: KillReason | null = null;
	private active = true;

	private stallTimer: ReturnType<typeof setTimeout> | null = null;
	private stallKillFn: (() => void) | null = null;

	constructor(config: ExecutionGuardConfig = {}) {
		this.maxTurns = config.maxTurns ?? DEFAULT_MAX_TURNS;
		this.maxRepetitions = config.maxRepetitions ?? DEFAULT_MAX_REPETITIONS;
		this.stallTimeoutMs = config.stallTimeoutMs ?? DEFAULT_STALL_TIMEOUT_MS;
	}

	/**
	 * Process a stream event. Call this for every JSON line from the child.
	 * Returns a kill action if the guard detects a stuck pattern.
	 */
	processEvent(evt: StreamEvent): GuardAction | null {
		if (!this.active || this.killedBy) return null;

		this.lastEventAt = Date.now();
		this.resetStallTimer();

		// ── Turn counting ────────────────────────────────────────────
		// A "turn" is one assistant message_end (the model produced a response).
		if (evt.type === "message_end" && evt.message?.role === "assistant") {
			this.turnCount++;

			if (this.maxTurns > 0 && this.turnCount > this.maxTurns) {
				return this.kill("turn_limit",
					`Turn limit exceeded: ${this.turnCount} turns (max: ${this.maxTurns}). Agent is looping without finishing.`);
			}
		}

		// ── Repetition detection ─────────────────────────────────────
		if (evt.type === "tool_execution_start" && evt.toolName) {
			const argsHash = hashArgs(evt.args);

			this.recentToolCalls.push({
				tool: evt.toolName,
				argsHash,
				timestamp: Date.now(),
			});

			// Keep last 20 tool calls for windowed analysis
			if (this.recentToolCalls.length > 20) {
				this.recentToolCalls.splice(0, this.recentToolCalls.length - 20);
			}

			if (this.maxRepetitions > 0) {
				const repetitions = this.recentToolCalls.filter(
					(tc) => tc.tool === evt.toolName && tc.argsHash === argsHash,
				).length;

				if (repetitions >= this.maxRepetitions) {
					return this.kill("repetition",
						`Repetition detected: "${evt.toolName}" called ${repetitions}× with identical args. Agent is stuck in a loop.`);
				}
			}
		}

		return null;
	}

	/**
	 * Start the stall timer. Call this after the child process spawns.
	 * The timer resets on every event. If no event arrives within
	 * stallTimeoutMs, the kill function is called.
	 */
	startStallTimer(killFn: () => void): void {
		if (this.stallTimeoutMs <= 0) return;
		this.stallKillFn = killFn;
		this.resetStallTimer();
	}

	/**
	 * Get a snapshot of the guard's current state.
	 * Useful for diagnostics and logging.
	 */
	getState(): ExecutionGuardState {
		return {
			turnCount: this.turnCount,
			recentToolCalls: [...this.recentToolCalls],
			lastEventAt: this.lastEventAt,
			killedBy: this.killedBy,
			active: this.active,
		};
	}

	/**
	 * Clean up timers. Call this when the child process exits.
	 */
	destroy(): void {
		this.active = false;
		if (this.stallTimer) {
			clearTimeout(this.stallTimer);
			this.stallTimer = null;
		}
		this.stallKillFn = null;
	}

	// ── Internal ──────────────────────────────────────────────────────

	private kill(reason: KillReason, message: string): GuardAction {
		this.killedBy = reason;
		this.destroy();
		return { type: "kill", reason: message };
	}

	private resetStallTimer(): void {
		if (this.stallTimer) {
			clearTimeout(this.stallTimer);
		}
		if (this.stallTimeoutMs <= 0 || !this.stallKillFn || !this.active) return;

		this.stallTimer = setTimeout(() => {
			if (!this.active || this.killedBy) return;
			const elapsed = this.lastEventAt ? Date.now() - this.lastEventAt : 0;
			const killFn = this.stallKillFn;
			this.kill("stall",
				`Stall detected: no activity for ${Math.round(elapsed / 1000)}s (limit: ${Math.round(this.stallTimeoutMs / 1000)}s). Agent is unresponsive.`);
			killFn?.();
		}, this.stallTimeoutMs);
	}
}
