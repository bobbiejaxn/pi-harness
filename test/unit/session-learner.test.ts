/**
 * Tests for the Session Learner — mid-session self-learning from completed runs.
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { SessionLearner } from "../../src/shared/session-learner.ts";
import type { SingleResult } from "../../src/shared/types.ts";

function makeResult(overrides: Partial<SingleResult> & { agent: string }): SingleResult {
	return {
		task: "test task",
		exitCode: 0,
		usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, cost: 0.01, turns: 1 },
		...overrides,
	};
}

function failedResult(agent: string, error: string, cost = 0.005): SingleResult {
	return makeResult({
		agent,
		exitCode: 1,
		error,
		usage: { input: 50, output: 25, cacheRead: 0, cacheWrite: 0, cost, turns: 1 },
	});
}

function successResult(agent: string, cost = 0.01, durationMs = 5000): SingleResult {
	return makeResult({
		agent,
		exitCode: 0,
		usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, cost, turns: 1 },
		progressSummary: { durationMs, toolCount: 3, tokens: 150 },
		model: "zai/glm-5",
	});
}

function resultWithModelAttempts(agent: string, attempts: Array<{ model: string; success: boolean; cost: number }>): SingleResult {
	return makeResult({
		agent,
		exitCode: attempts.some(a => a.success) ? 0 : 1,
		usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, cost: attempts.reduce((s, a) => s + a.cost, 0), turns: 1 },
		modelAttempts: attempts.map(a => ({
			model: a.model,
			success: a.success,
			usage: { input: 50, output: 25, cacheRead: 0, cacheWrite: 0, cost: a.cost },
		})),
		model: attempts.find(a => a.success)?.model ?? attempts[0]?.model,
	});
}

describe("SessionLearner — observe", () => {
	it("records a single successful run", () => {
		const learner = new SessionLearner();
		learner.observe(successResult("scout", 0.02, 3000));
		const hint = learner.suggest("scout", "do stuff");
		assert.equal(hint.previousRunCount, 1);
		assert.equal(hint.hasConfidence, false); // need ≥2
		assert.equal(hint.estimatedCost, 0.02);
		assert.equal(hint.estimatedDurationMs, 3000);
	});

	it("accumulates cost across multiple runs", () => {
		const learner = new SessionLearner();
		learner.observe(successResult("scout", 0.01, 1000));
		learner.observe(successResult("scout", 0.03, 3000));
		learner.observe(successResult("scout", 0.02, 2000));
		const hint = learner.suggest("scout", "task");
		assert.equal(hint.previousRunCount, 3);
		assert.equal(hint.hasConfidence, true);
		assert.ok(Math.abs(hint.estimatedCost - 0.02) < 0.001); // avg of 0.01, 0.03, 0.02
	});

	it("tracks consecutive failures", () => {
		const learner = new SessionLearner();
		learner.observe(failedResult("scout", "err1"));
		learner.observe(failedResult("scout", "err2"));
		learner.observe(failedResult("scout", "err3"));
		const hint = learner.suggest("scout", "task");
		assert.equal(hint.skipRetry, true); // 3 consecutive failures
	});

	it("resets consecutive failures on success", () => {
		const learner = new SessionLearner();
		learner.observe(failedResult("scout", "err1"));
		learner.observe(failedResult("scout", "err2"));
		learner.observe(successResult("scout")); // resets
		learner.observe(failedResult("scout", "err3"));
		const hint = learner.suggest("scout", "task");
		assert.equal(hint.skipRetry, false); // only 1 consecutive failure
	});

	it("tracks independent agents separately", () => {
		const learner = new SessionLearner();
		learner.observe(successResult("scout", 0.01));
		learner.observe(successResult("worker", 0.05));
		learner.observe(successResult("scout", 0.02));
		const scoutHint = learner.suggest("scout", "task");
		const workerHint = learner.suggest("worker", "task");
		assert.equal(scoutHint.previousRunCount, 2);
		assert.equal(workerHint.previousRunCount, 1);
		assert.ok(Math.abs(scoutHint.estimatedCost - 0.015) < 0.001);
		assert.ok(Math.abs(workerHint.estimatedCost - 0.05) < 0.001);
	});

	it("handles model attempts tracking", () => {
		const learner = new SessionLearner();
		learner.observe(resultWithModelAttempts("scout", [
			{ model: "zai/glm-5", success: false, cost: 0.01 },
			{ model: "deepseek-v4-flash:cloud", success: true, cost: 0.02 },
		]));
		const hint = learner.suggest("scout", "task");
		assert.ok(hint.preferredModel); // should prefer the successful model
	});
});

describe("SessionLearner — suggest", () => {
	it("returns empty hint for unknown agent", () => {
		const learner = new SessionLearner();
		const hint = learner.suggest("unknown", "task");
		assert.equal(hint.estimatedCost, 0);
		assert.equal(hint.previousRunCount, 0);
		assert.equal(hint.hasConfidence, false);
		assert.equal(hint.preferredModel, null);
		assert.equal(hint.skipRetry, false);
		assert.equal(hint.shouldEscalate, false);
	});

	it("computes suggested timeout from durations", () => {
		const learner = new SessionLearner();
		// Need ≥3 durations for p95
		for (let i = 0; i < 5; i++) {
			learner.observe(successResult("scout", 0.01, 1000 + i * 1000));
		}
		const hint = learner.suggest("scout", "task");
		assert.ok(hint.suggestedTimeoutMs !== null);
		assert.ok(hint.suggestedTimeoutMs! > 0);
		// p95 * 1.5 should be well above the max observed duration
		assert.ok(hint.suggestedTimeoutMs! >= 5000 * 1.5);
	});

	it("uses max duration × 2 when <3 data points", () => {
		const learner = new SessionLearner();
		learner.observe(successResult("scout", 0.01, 3000));
		learner.observe(successResult("scout", 0.01, 5000));
		const hint = learner.suggest("scout", "task");
		assert.ok(hint.suggestedTimeoutMs !== null);
		assert.equal(hint.suggestedTimeoutMs, 10000); // 5000 * 2
	});

	it("flags escalation when >50% failure rate with ≥3 runs", () => {
		const learner = new SessionLearner();
		learner.observe(successResult("scout"));
		learner.observe(failedResult("scout", "err"));
		learner.observe(failedResult("scout", "err"));
		// 2/3 = 66% failure rate
		const hint = learner.suggest("scout", "task");
		assert.equal(hint.shouldEscalate, true);
		assert.ok(hint.escalationReason?.includes("scout"));
		assert.ok(hint.escalationReason?.includes("67%"));
	});

	it("does not escalate when failure rate ≤50%", () => {
		const learner = new SessionLearner();
		learner.observe(successResult("scout"));
		learner.observe(successResult("scout"));
		learner.observe(failedResult("scout", "err"));
		// 1/3 = 33% failure rate
		const hint = learner.suggest("scout", "task");
		assert.equal(hint.shouldEscalate, false);
	});

	it("does not escalate with <3 runs", () => {
		const learner = new SessionLearner();
		learner.observe(failedResult("scout", "err"));
		learner.observe(failedResult("scout", "err"));
		// 2/2 = 100% but only 2 runs
		const hint = learner.suggest("scout", "task");
		assert.equal(hint.shouldEscalate, false);
	});

	it("identifies models to avoid (0% success, ≥2 attempts)", () => {
		const learner = new SessionLearner();
		learner.observe(resultWithModelAttempts("scout", [
			{ model: "bad-model", success: false, cost: 0.01 },
		]));
		learner.observe(resultWithModelAttempts("scout", [
			{ model: "bad-model", success: false, cost: 0.01 },
		]));
		const hint = learner.suggest("scout", "task");
		assert.ok(hint.avoidModels.includes("bad-model"));
	});

	it("prefers model with highest success rate", () => {
		const learner = new SessionLearner();
		// model-a: 1 success, 1 fail (50%)
		learner.observe(resultWithModelAttempts("scout", [
			{ model: "model-a", success: true, cost: 0.01 },
		]));
		learner.observe(resultWithModelAttempts("scout", [
			{ model: "model-a", success: false, cost: 0.01 },
		]));
		// model-b: 2 successes (100%)
		learner.observe(resultWithModelAttempts("scout", [
			{ model: "model-b", success: true, cost: 0.02 },
		]));
		learner.observe(resultWithModelAttempts("scout", [
			{ model: "model-b", success: true, cost: 0.02 },
		]));
		const hint = learner.suggest("scout", "task");
		assert.equal(hint.preferredModel, "model-b");
	});
});

describe("SessionLearner — summary", () => {
	it("produces summary for multiple agents", () => {
		const learner = new SessionLearner();
		learner.observe(successResult("scout", 0.01, 3000));
		learner.observe(successResult("scout", 0.02, 5000));
		learner.observe(failedResult("worker", "err", 0.05));
		learner.observe(successResult("worker", 0.04, 8000));

		const s = learner.summary();
		assert.equal(s.totalRuns, 4);
		assert.equal(s.agents.length, 2);

		// Sorted by run count descending
		assert.equal(s.agents[0]!.agent, "scout");
		assert.equal(s.agents[0]!.runs, 2);
		assert.equal(s.agents[1]!.agent, "worker");
		assert.equal(s.agents[1]!.runs, 2);
	});

	it("generates recommendations for problematic agents", () => {
		const learner = new SessionLearner();
		for (let i = 0; i < 4; i++) {
			learner.observe(failedResult("scout", "timeout"));
		}
		const s = learner.summary();
		assert.ok(s.recommendations.length > 0);
		assert.ok(s.recommendations.some(r => r.includes("scout")));
	});

	it("generates cost warning for expensive agents", () => {
		const learner = new SessionLearner();
		for (let i = 0; i < 4; i++) {
			learner.observe(successResult("scout", 0.15));
		}
		const s = learner.summary();
		assert.ok(s.recommendations.some(r => r.includes("💰")));
	});

	it("generates slow agent warning", () => {
		const learner = new SessionLearner();
		for (let i = 0; i < 4; i++) {
			learner.observe(successResult("scout", 0.01, 150_000)); // 2.5 min
		}
		const s = learner.summary();
		assert.ok(s.recommendations.some(r => r.includes("⏱️")));
	});
});

describe("SessionLearner — reset", () => {
	it("reset() clears all learning", () => {
		const learner = new SessionLearner();
		learner.observe(successResult("scout"));
		learner.observe(successResult("worker"));
		learner.reset();
		const hint = learner.suggest("scout", "task");
		assert.equal(hint.previousRunCount, 0);
		assert.equal(hint.hasConfidence, false);
		const s = learner.summary();
		assert.equal(s.totalRuns, 0);
		assert.equal(s.agents.length, 0);
	});
});
