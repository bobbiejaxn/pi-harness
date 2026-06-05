/**
 * Session Learner — mid-session self-learning from completed subagent runs.
 *
 * Observes every completed run within a session and produces actionable
 * recommendations for subsequent runs. Pure in-memory — no persistence.
 * Resets when the session ends.
 *
 * ## What it learns
 *
 * | Signal | Source | Produces |
 * |--------|--------|----------|
 * | Cost per agent | `result.usage.cost` | Predicted cost for next run of same agent |
 * | Duration per agent | `result.progressSummary.durationMs` | Suggested timeout |
 * | Model success rate | `result.modelAttempts` | Model preference ranking per agent |
 * | Failure patterns | `result.exitCode` + `result.error` | Retry recommendations, escalation flags |
 * | Tool usage patterns | `result.toolCalls` | Agent-task affinity hints |
 *
 * ## Usage
 *
 * ```ts
 * const learner = new SessionLearner();
 *
 * // After each run completes:
 * learner.observe(result);
 *
 * // Before starting a new run:
 * const hint = learner.suggest("scout", "list files in src/");
 * // hint.estimatedCost, hint.suggestedTimeout, hint.preferredModel, hint.skipRetry
 * ```
 *
 * ## Integration points
 *
 * - `execution.ts`: call `learner.observe(result)` after each runSingleAttempt
 * - `subagent-executor.ts`: call `learner.suggest(agent, task)` before each runSync
 * - `extension/index.ts`: create the learner, reset on session_start
 */

import type { SingleResult, Usage } from "./types.ts";

// ── Types ────────────────────────────────────────────────────────────────────

/** Per-agent statistics accumulated across all runs in a session. */
interface AgentStats {
	/** Agent name. */
	agent: string;
	/** Number of completed runs. */
	runCount: number;
	/** Number of successful runs (exitCode 0, no error). */
	successCount: number;
	/** Number of failed runs. */
	failCount: number;
	/** Total cost across all runs. */
	totalCost: number;
	/** Total input tokens. */
	totalInputTokens: number;
	/** Total output tokens. */
	totalOutputTokens: number;
	/** All observed durations in ms. */
	durations: number[];
	/** Model → { successes, failures } tracking. */
	modelResults: Map<string, { success: number; fail: number; totalCost: number }>;
	/** Model → average duration ms. */
	modelDurations: Map<string, number[]>;
	/** Last error message for this agent (reset on success). */
	lastError: string | null;
	/** Consecutive failure count (reset on success). */
	consecutiveFailures: number;
	/** Timestamps of recent runs (for cooldown detection). */
	recentRunTimestamps: number[];
}

/** A learning hint produced for an upcoming run. */
export interface RunHint {
	/** Predicted cost based on historical average. 0 if no data. */
	estimatedCost: number;
	/** Estimated duration in ms based on historical average. 0 if no data. */
	estimatedDurationMs: number;
	/** Suggested timeout in ms (p95 of historical durations + 50% buffer). null if no data. */
	suggestedTimeoutMs: number | null;
	/** Best-performing model for this agent (highest success rate, then lowest cost). null if no data. */
	preferredModel: string | null;
	/** Models to avoid (0% success rate with ≥2 attempts). */
	avoidModels: string[];
	/** Whether to skip retry for this agent (3+ consecutive failures). */
	skipRetry: boolean;
	/** Whether to escalate to the user (agent has failed >50% of runs). */
	shouldEscalate: boolean;
	/** Human-readable reason if shouldEscalate is true. */
	escalationReason: string | null;
	/** Number of previous runs with this agent in this session. */
	previousRunCount: number;
	/** Whether the learner has enough data to be useful (≥2 runs). */
	hasConfidence: boolean;
}

/** Summary of all session learning, for dashboards and reports. */
export interface SessionLearningSummary {
	totalRuns: number;
	totalCost: number;
	agents: Array<{
		agent: string;
		runs: number;
		successRate: number;
		avgCost: number;
		avgDurationMs: number;
		bestModel: string | null;
	}>;
	recommendations: string[];
}

// ── Learner ───────────────────────────────────────────────────────────────────

export class SessionLearner {
	private readonly agentStats = new Map<string, AgentStats>();
	private totalRuns = 0;

	/** Record a completed run's result. Call this after every subagent run completes. */
	observe(result: SingleResult): void {
		this.totalRuns++;

		const stats = this.getOrCreateStats(result.agent);
		stats.runCount++;
		stats.recentRunTimestamps.push(Date.now());

		// Keep only last 20 timestamps
		if (stats.recentRunTimestamps.length > 20) {
			stats.recentRunTimestamps = stats.recentRunTimestamps.slice(-20);
		}

		const succeeded = result.exitCode === 0 && !result.error;

		if (succeeded) {
			stats.successCount++;
			stats.consecutiveFailures = 0;
			stats.lastError = null;
		} else {
			stats.failCount++;
			stats.consecutiveFailures++;
			stats.lastError = result.error ?? `exit ${result.exitCode}`;
		}

		// Cost and token accumulation
		stats.totalCost += result.usage.cost;
		stats.totalInputTokens += result.usage.input;
		stats.totalOutputTokens += result.usage.output;

		// Duration
		const durationMs = result.progressSummary?.durationMs ?? 0;
		if (durationMs > 0) {
			stats.durations.push(durationMs);
			// Keep last 50 durations for memory efficiency
			if (stats.durations.length > 50) stats.durations = stats.durations.slice(-50);
		}

		// Model-level tracking
		const modelAttempts = result.modelAttempts ?? [];
		if (modelAttempts.length > 0) {
			for (const attempt of modelAttempts) {
				const modelKey = attempt.model;
				let mr = stats.modelResults.get(modelKey);
				if (!mr) {
					mr = { success: 0, fail: 0, totalCost: 0 };
					stats.modelResults.set(modelKey, mr);
				}
				if (attempt.success) mr.success++;
				else mr.fail++;
				mr.totalCost += attempt.usage?.cost ?? 0;

				// Duration per model
				if (attempt.usage && durationMs > 0) {
					let md = stats.modelDurations.get(modelKey);
					if (!md) {
						md = [];
						stats.modelDurations.set(modelKey, md);
					}
					md.push(durationMs);
					if (md.length > 50) stats.modelDurations.set(modelKey, md.slice(-50));
				}
			}
		} else if (result.model) {
			// Single model, no fallback — record it
			const modelKey = result.model;
			let mr = stats.modelResults.get(modelKey);
			if (!mr) {
				mr = { success: 0, fail: 0, totalCost: 0 };
				stats.modelResults.set(modelKey, mr);
			}
			if (succeeded) mr.success++;
			else mr.fail++;
			mr.totalCost += result.usage.cost;
		}
	}

	/**
	 * Get a learning hint for an upcoming run.
	 * Returns predicted cost, suggested timeout, model preferences, and escalation flags.
	 */
	suggest(agent: string, _task: string): RunHint {
		const stats = this.agentStats.get(agent);

		const empty: RunHint = {
			estimatedCost: 0,
			estimatedDurationMs: 0,
			suggestedTimeoutMs: null,
			preferredModel: null,
			avoidModels: [],
			skipRetry: false,
			shouldEscalate: false,
			escalationReason: null,
			previousRunCount: 0,
			hasConfidence: false,
		};

		if (!stats || stats.runCount === 0) return empty;

		const hasConfidence = stats.runCount >= 2;

		// Estimated cost: average of all runs
		const estimatedCost = stats.runCount > 0 ? stats.totalCost / stats.runCount : 0;

		// Estimated duration: average of observed durations
		const estimatedDurationMs = stats.durations.length > 0
			? stats.durations.reduce((a, b) => a + b, 0) / stats.durations.length
			: 0;

		// Suggested timeout: p95 of durations + 50% buffer
		const suggestedTimeoutMs = stats.durations.length >= 3
			? this.percentile(stats.durations, 95) * 1.5
			: stats.durations.length >= 1
				? Math.max(...stats.durations) * 2
				: null;

		// Model preference: highest success rate, then lowest cost
		const preferredModel = this.bestModel(stats);

		// Models to avoid: 0% success with ≥2 attempts
		const avoidModels: string[] = [];
		for (const [model, mr] of stats.modelResults) {
			if (mr.success === 0 && mr.fail >= 2) {
				avoidModels.push(model);
			}
		}

		// Skip retry: 3+ consecutive failures
		const skipRetry = stats.consecutiveFailures >= 3;

		// Escalation: >50% failure rate with ≥3 runs
		const failureRate = stats.runCount > 0 ? stats.failCount / stats.runCount : 0;
		const shouldEscalate = stats.runCount >= 3 && failureRate > 0.5;
		const escalationReason = shouldEscalate
			? `Agent "${agent}" has ${(failureRate * 100).toFixed(0)}% failure rate (${stats.failCount}/${stats.runCount} runs). Last error: ${stats.lastError ?? "unknown"}`
			: null;

		return {
			estimatedCost,
			estimatedDurationMs,
			suggestedTimeoutMs,
			preferredModel,
			avoidModels,
			skipRetry,
			shouldEscalate,
			escalationReason,
			previousRunCount: stats.runCount,
			hasConfidence,
		};
	}

	/** Get a summary of all learning in this session. Useful for dashboards. */
	summary(): SessionLearningSummary {
		const agents: SessionLearningSummary["agents"] = [];

		for (const [name, stats] of this.agentStats) {
			agents.push({
				agent: name,
				runs: stats.runCount,
				successRate: stats.runCount > 0 ? stats.successCount / stats.runCount : 0,
				avgCost: stats.runCount > 0 ? stats.totalCost / stats.runCount : 0,
				avgDurationMs: stats.durations.length > 0
					? stats.durations.reduce((a, b) => a + b, 0) / stats.durations.length
					: 0,
				bestModel: this.bestModel(stats),
			});
		}

		// Sort by run count descending
		agents.sort((a, b) => b.runs - a.runs);

		const recommendations = this.generateRecommendations();

		return {
			totalRuns: this.totalRuns,
			totalCost: agents.reduce((sum, a) => sum + a.avgCost * a.runs, 0),
			agents,
			recommendations,
		};
	}

	/** Reset all learning. Called on session_start. */
	reset(): void {
		this.agentStats.clear();
		this.totalRuns = 0;
	}

	// ── Internal helpers ────────────────────────────────────────────────

	private getOrCreateStats(agent: string): AgentStats {
		let stats = this.agentStats.get(agent);
		if (!stats) {
			stats = {
				agent,
				runCount: 0,
				successCount: 0,
				failCount: 0,
				totalCost: 0,
				totalInputTokens: 0,
				totalOutputTokens: 0,
				durations: [],
				modelResults: new Map(),
				modelDurations: new Map(),
				lastError: null,
				consecutiveFailures: 0,
				recentRunTimestamps: [],
			};
			this.agentStats.set(agent, stats);
		}
		return stats;
	}

	private percentile(values: number[], p: number): number {
		if (values.length === 0) return 0;
		const sorted = [...values].sort((a, b) => a - b);
		const idx = Math.ceil((p / 100) * sorted.length) - 1;
		return sorted[Math.max(0, idx)]!;
	}

	private bestModel(stats: AgentStats): string | null {
		if (stats.modelResults.size === 0) return null;

		let best: string | null = null;
		let bestScore = -1;

		for (const [model, mr] of stats.modelResults) {
			const total = mr.success + mr.fail;
			if (total === 0) continue;

			const successRate = mr.success / total;
			const avgCost = total > 0 ? mr.totalCost / total : Infinity;

			// Score: 70% success rate weight + 30% cost efficiency (lower cost = higher score)
			// Normalize cost: cap at 1.0, invert so lower cost = higher score
			const costScore = avgCost > 0 ? Math.min(1, 0.01 / avgCost) : 1;
			const score = successRate * 0.7 + costScore * 0.3;

			if (score > bestScore) {
				bestScore = score;
				best = model;
			}
		}

		return best;
	}

	private generateRecommendations(): string[] {
		const recs: string[] = [];

		for (const [name, stats] of this.agentStats) {
			// High failure rate
			if (stats.runCount >= 3) {
				const failureRate = stats.failCount / stats.runCount;
				if (failureRate > 0.5) {
					recs.push(`⚠️ "${name}" has ${(failureRate * 100).toFixed(0)}% failure rate (${stats.failCount}/${stats.runCount}). Consider switching agent or model.`);
				}
			}

			// Consecutive failures
			if (stats.consecutiveFailures >= 3) {
				recs.push(`🔴 "${name}" has ${stats.consecutiveFailures} consecutive failures. Last: ${stats.lastError ?? "unknown"}`);
			}

			// Cost outlier
			if (stats.runCount >= 3) {
				const avgCost = stats.totalCost / stats.runCount;
				if (avgCost > 0.10) {
					recs.push(`💰 "${name}" averages ${avgCost.toFixed(4)}/run. Consider cost limits.`);
				}
			}

			// Slow agent
			if (stats.durations.length >= 3) {
				const avgDuration = stats.durations.reduce((a, b) => a + b, 0) / stats.durations.length;
				if (avgDuration > 120_000) { // >2 minutes
					recs.push(`⏱️ "${name}" averages ${(avgDuration / 1000).toFixed(0)}s per run. Consider timeout tuning.`);
				}
			}
		}

		return recs;
	}
}
