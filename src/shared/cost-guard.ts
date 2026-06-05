/**
 * Cost guard for subagent runs.
 *
 * Tracks cumulative spend per-run and per-session, killing child processes
 * when thresholds are exceeded. Inspired by ivi's production cost controls.
 *
 * ## Config
 *
 * ```json
 * { "cost": { "maxPerRun": 0.50, "maxSessionBudget": 3.00 } }
 * ```
 *
 * ## Env overrides (take precedence over config)
 *
 * - `PI_SUBAGENT_MAX_COST` — per-run cost limit (e.g. `"0.50"`)
 * - `PI_SESSION_MAX_COST` — session budget (e.g. `"3.00"`)
 *
 * ## How it works
 *
 * 1. `resolveCostGuardConfig()` reads config + env, returns resolved limits
 * 2. `SessionCostTracker` accumulates cost across all runs in a session
 * 3. `checkRunCostLimit()` is called on every `message_end` event in execution.ts
 * 4. When exceeded, execution.ts sends SIGTERM → SIGKILL to the child process
 */

/** User-facing config shape (optional fields, merged with defaults). */
export interface CostGuardConfig {
	/** Maximum spend per single subagent run. Default: Infinity (no limit). */
	maxPerRun?: number;
	/** Maximum cumulative spend across all subagent runs in a session. Default: Infinity (no limit). */
	maxSessionBudget?: number;
}

/** Fully resolved config with defaults applied. All values are guaranteed numbers. */
export interface ResolvedCostGuardConfig {
	maxPerRun: number;
	maxSessionBudget: number;
}

/** Default config: no limits (Infinity). Cost guards are opt-in. */
export const DEFAULT_COST_GUARD: ResolvedCostGuardConfig = {
	maxPerRun: Infinity,
	maxSessionBudget: Infinity,
};

/**
 * Resolve cost guard config from user config and env vars.
 * Env vars take precedence over config values.
 * Falls back to DEFAULT_COST_GUARD (Infinity) if neither is set.
 */
export function resolveCostGuardConfig(
	config: CostGuardConfig | undefined,
	env: NodeJS.ProcessEnv = process.env,
): ResolvedCostGuardConfig {
	const envPerRun = parseFloat(env.PI_SUBAGENT_MAX_COST ?? "");
	const envSession = parseFloat(env.PI_SESSION_MAX_COST ?? "");

	return {
		maxPerRun:
			Number.isFinite(envPerRun) && envPerRun > 0
				? envPerRun
				: config?.maxPerRun ?? DEFAULT_COST_GUARD.maxPerRun,
		maxSessionBudget:
			Number.isFinite(envSession) && envSession > 0
				? envSession
				: config?.maxSessionBudget ?? DEFAULT_COST_GUARD.maxSessionBudget,
	};
}

/**
 * Tracks cumulative spend across all subagent runs in a session.
 * Single-threaded by design (Node.js event loop).
 *
 * Call `add()` after each run completes. Check `isExhausted` before starting new runs.
 * The `onBudgetExceeded` callback fires once when the session budget is first exceeded.
 */
export class SessionCostTracker {
	private total = 0;
	private readonly maxBudget: number;
	private readonly onBudgetExceeded?: (total: number, max: number) => void;

	constructor(maxBudget: number, onBudgetExceeded?: (total: number, max: number) => void) {
		this.maxBudget = maxBudget;
		this.onBudgetExceeded = onBudgetExceeded;
	}

	/** Add cost from a completed run. Returns new total. */
	add(cost: number): number {
		this.total += cost;
		if (this.total > this.maxBudget && this.onBudgetExceeded) {
			this.onBudgetExceeded(this.total, this.maxBudget);
		}
		return this.total;
	}

	/** Current cumulative spend across all runs. */
	get cumulative(): number {
		return this.total;
	}

	/** Whether the session budget has been exceeded. No new runs should start. */
	get isExhausted(): boolean {
		return this.total >= this.maxBudget;
	}

	/** Remaining budget before exhaustion. */
	get remaining(): number {
		return Math.max(0, this.maxBudget - this.total);
	}

	/** Reset tracker to zero (used on session reset). */
	reset(): void {
		this.total = 0;
	}
}

/**
 * Check if a per-run cost limit has been exceeded.
 * Called on every `message_end` event in execution.ts.
 * @returns Object with `exceeded` flag, current `cost`, and `limit`.
 */
export function checkRunCostLimit(
	cost: number,
	limit: number,
): { exceeded: boolean; cost: number; limit: number } {
	return {
		exceeded: Number.isFinite(limit) && cost >= limit,
		cost,
		limit,
	};
}

/** Format a cost value for display (e.g. `"$0.0042"`). */
export function formatCost(cost: number): string {
	return `$${cost.toFixed(4)}`;
}
