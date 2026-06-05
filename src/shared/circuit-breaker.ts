/**
 * Circuit Breaker — prevents dispatching to failing agents with exponential backoff.
 *
 * Tracks consecutive failures per agent and "trips" the breaker when the threshold
 * is exceeded. A tripped breaker blocks dispatch to that agent for a cooldown period.
 * After cooldown, one probe attempt is allowed (half-open state). If it succeeds,
 * the breaker resets. If it fails, cooldown doubles.
 *
 * ## States
 *
 * ```
 * CLOSED ──── failure count >= threshold ────→ OPEN
 *   ↑                                           │
 *   │ probe succeeds                            │ cooldown expires
 *   │                                           ↓
 *   └──────────────────────────────────── HALF_OPEN
 *                                                 │
 *                      probe fails → back to OPEN (cooldown doubles)
 * ```
 *
 * ## Usage
 *
 * ```ts
 * const breaker = new CircuitBreaker({ failureThreshold: 3, cooldownMs: 30_000 });
 *
 * // Before dispatching:
 * if (breaker.isBlocked("scout")) {
 *   const state = breaker.getState("scout");
 *   throw new Error(`Agent "scout" is circuit-broken: ${state.blockReason}`);
 * }
 *
 * // After each run:
 * if (result.exitCode === 0) breaker.recordSuccess("scout");
 * else breaker.recordFailure("scout", result.error ?? "unknown");
 *
 * // For dashboards:
 * const summary = breaker.summary();
 * ```
 */

// ── Types ────────────────────────────────────────────────────────────────────

/** Configuration for the circuit breaker. */
export interface CircuitBreakerConfig {
	/** Number of consecutive failures before tripping. Default: 3. */
	failureThreshold?: number;
	/** Initial cooldown in ms after the breaker trips. Default: 30_000 (30s). */
	cooldownMs?: number;
	/** Maximum cooldown in ms (caps exponential backoff). Default: 300_000 (5 min). */
	maxCooldownMs?: number;
	/** Multiplier for cooldown backoff. Default: 2. */
	backoffMultiplier?: number;
}

/** State of the breaker for a specific agent. */
export type BreakerState = "closed" | "open" | "half_open";

/** Detailed state info for a specific agent. */
export interface AgentBreakerState {
	/** Agent name. */
	agent: string;
	/** Current state of the breaker. */
	state: BreakerState;
	/** Consecutive failure count. */
	consecutiveFailures: number;
	/** Total failure count (resets on close). */
	totalFailures: number;
	/** Total success count (resets on close). */
	totalSuccesses: number;
	/** Current cooldown duration in ms. */
	currentCooldownMs: number;
	/** When the breaker opened (timestamp ms). null if closed. */
	openedAt: number | null;
	/** When the cooldown expires (timestamp ms). null if closed. */
	cooldownExpiresAt: number | null;
	/** Last error that contributed to opening the breaker. */
	lastError: string | null;
	/** Human-readable reason if currently blocked. */
	blockReason: string | null;
}

/** Summary of all agents' breaker states. */
export interface CircuitBreakerSummary {
	/** Agents currently blocked (open state). */
	blocked: Array<{ agent: string; reason: string; retryAfterMs: number }>;
	/** Agents in half-open state (probe allowed). */
	halfOpen: string[];
	/** Agents that are healthy (closed). */
	healthy: string[];
}

// ── Internal ─────────────────────────────────────────────────────────────────

const DEFAULT_FAILURE_THRESHOLD = 3;
const DEFAULT_COOLDOWN_MS = 30_000;
const DEFAULT_MAX_COOLDOWN_MS = 300_000;
const DEFAULT_BACKOFF_MULTIPLIER = 2;

interface AgentBreaker {
	agent: string;
	state: BreakerState;
	consecutiveFailures: number;
	totalFailures: number;
	totalSuccesses: number;
	currentCooldownMs: number;
	openedAt: number | null;
	lastError: string | null;
}

// ── Circuit Breaker ──────────────────────────────────────────────────────────

export class CircuitBreaker {
	private readonly failureThreshold: number;
	private readonly cooldownMs: number;
	private readonly maxCooldownMs: number;
	private readonly backoffMultiplier: number;
	private readonly breakers = new Map<string, AgentBreaker>();

	constructor(config: CircuitBreakerConfig = {}) {
		this.failureThreshold = config.failureThreshold ?? DEFAULT_FAILURE_THRESHOLD;
		this.cooldownMs = config.cooldownMs ?? DEFAULT_COOLDOWN_MS;
		this.maxCooldownMs = config.maxCooldownMs ?? DEFAULT_MAX_COOLDOWN_MS;
		this.backoffMultiplier = config.backoffMultiplier ?? DEFAULT_BACKOFF_MULTIPLIER;
	}

	/**
	 * Check if an agent is currently blocked by the circuit breaker.
	 * Returns true if the breaker is OPEN and cooldown hasn't expired.
	 */
	isBlocked(agent: string): boolean {
		const breaker = this.breakers.get(agent);
		if (!breaker || breaker.state === "closed") return false;

		if (breaker.state === "open") {
			const now = Date.now();
			const expiresAt = breaker.openedAt! + breaker.currentCooldownMs;
			if (now >= expiresAt) {
				// Cooldown expired → half-open (allow one probe)
				breaker.state = "half_open";
				return false;
			}
			return true;
		}

		// half_open → allow the probe attempt
		return false;
	}

	/**
	 * Record a successful run. Resets the breaker to closed.
	 */
	recordSuccess(agent: string): void {
		const breaker = this.getOrCreate(agent);
		breaker.consecutiveFailures = 0;
		breaker.totalSuccesses++;

		if (breaker.state === "half_open") {
			// Probe succeeded → close the breaker
			breaker.state = "closed";
			breaker.currentCooldownMs = this.cooldownMs;
			breaker.openedAt = null;
			breaker.lastError = null;
		} else if (breaker.state === "open") {
			// Shouldn't happen (should be blocked), but reset gracefully
			breaker.state = "closed";
			breaker.consecutiveFailures = 0;
			breaker.openedAt = null;
			breaker.lastError = null;
		}
	}

	/**
	 * Record a failed run. Increments failure counter, trips breaker if threshold reached.
	 */
	recordFailure(agent: string, error: string): void {
		const breaker = this.getOrCreate(agent);
		breaker.consecutiveFailures++;
		breaker.totalFailures++;
		breaker.lastError = error;

		if (breaker.state === "half_open") {
			// Probe failed → re-open with doubled cooldown
			breaker.state = "open";
			breaker.currentCooldownMs = Math.min(
				breaker.currentCooldownMs * this.backoffMultiplier,
				this.maxCooldownMs,
			);
			breaker.openedAt = Date.now();
		} else if (breaker.consecutiveFailures >= this.failureThreshold) {
			// Threshold reached → trip the breaker
			breaker.state = "open";
			breaker.openedAt = Date.now();
			if (breaker.currentCooldownMs === this.cooldownMs) {
				// First trip → use base cooldown
			} else {
				breaker.currentCooldownMs = Math.min(
					breaker.currentCooldownMs * this.backoffMultiplier,
					this.maxCooldownMs,
				);
			}
		}
	}

	/**
	 * Record a run result (success or failure) based on exit code.
	 */
	record(agent: string, exitCode: number, error?: string): void {
		if (exitCode === 0 && !error) {
			this.recordSuccess(agent);
		} else {
			this.recordFailure(agent, error ?? `exit ${exitCode}`);
		}
	}

	/**
	 * Get detailed state for a specific agent.
	 */
	getState(agent: string): AgentBreakerState {
		const breaker = this.getOrCreate(agent);
		const now = Date.now();
		const cooldownExpiresAt = breaker.openedAt
			? breaker.openedAt + breaker.currentCooldownMs
			: null;

		// Check if half-open transition should happen
		let effectiveState = breaker.state;
		if (breaker.state === "open" && cooldownExpiresAt && now >= cooldownExpiresAt) {
			effectiveState = "half_open";
		}

		const isCurrentlyBlocked = effectiveState === "open";
		const blockReason = isCurrentlyBlocked
			? `Agent "${agent}" circuit-broken: ${breaker.consecutiveFailures} consecutive failures (threshold: ${this.failureThreshold}). Last error: ${breaker.lastError ?? "unknown"}. Retry after ${Math.round((cooldownExpiresAt! - now) / 1000)}s.`
			: null;

		return {
			agent,
			state: effectiveState,
			consecutiveFailures: breaker.consecutiveFailures,
			totalFailures: breaker.totalFailures,
			totalSuccesses: breaker.totalSuccesses,
			currentCooldownMs: breaker.currentCooldownMs,
			openedAt: breaker.openedAt,
			cooldownExpiresAt,
			lastError: breaker.lastError,
			blockReason,
		};
	}

	/**
	 * Get a summary of all agents' breaker states.
	 */
	summary(): CircuitBreakerSummary {
		const blocked: CircuitBreakerSummary["blocked"] = [];
		const halfOpen: string[] = [];
		const healthy: string[] = [];

		for (const [agent] of this.breakers) {
			const state = this.getState(agent);
			if (state.state === "open") {
				blocked.push({
					agent,
					reason: state.blockReason ?? "circuit open",
					retryAfterMs: state.cooldownExpiresAt ? state.cooldownExpiresAt - Date.now() : 0,
				});
			} else if (state.state === "half_open") {
				halfOpen.push(agent);
			} else {
				healthy.push(agent);
			}
		}

		return { blocked, halfOpen, healthy };
	}

	/**
	 * Reset the breaker for a specific agent.
	 */
	reset(agent: string): void {
		this.breakers.delete(agent);
	}

	/**
	 * Reset all breakers. Called on session_start.
	 */
	resetAll(): void {
		this.breakers.clear();
	}

	// ── Internal ──────────────────────────────────────────────────────

	private getOrCreate(agent: string): AgentBreaker {
		let breaker = this.breakers.get(agent);
		if (!breaker) {
			breaker = {
				agent,
				state: "closed",
				consecutiveFailures: 0,
				totalFailures: 0,
				totalSuccesses: 0,
				currentCooldownMs: this.cooldownMs,
				openedAt: null,
				lastError: null,
			};
			this.breakers.set(agent, breaker);
		}
		return breaker;
	}
}
