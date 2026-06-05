/**
 * Integration tests for subagent event emission wiring.
 *
 * Tests that the SessionCostTracker, cascading timeout, retry logic,
 * and trace propagation modules work together correctly when composed.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	SessionCostTracker,
	checkRunCostLimit,
	resolveCostGuardConfig,
	formatCost,
} from "../../src/shared/cost-guard.ts";
import {
	shouldRetry,
	isRetriable,
	resolveRetryConfig,
	backoffMs,
} from "../../src/shared/retry-logic.ts";
import {
	resolveTimeout,
	resolveTimeoutConfig,
	formatTimeout,
} from "../../src/shared/cascading-timeout.ts";
import {
	resolveTraceRunId,
	buildTraceEnv,
	resolveSpawnDepth,
	writeRunManifest,
} from "../../src/shared/trace-propagation.ts";
import {
	accumulateTurnCost,
	sumTurnRollups,
	SUBAGENT_RUN_START_EVENT,
	SUBAGENT_RUN_END_EVENT,
	SUBAGENT_BUDGET_EXHAUSTED_EVENT,
	SUBAGENT_TIMEOUT_EVENT,
	SUBAGENT_RUN_RETRY_EVENT,
	SUBAGENT_COST_CHECKPOINT_EVENT,
	type TurnCostRollup,
} from "../../src/shared/subagent-events.ts";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

describe("integration: cost guard + session budget + events", () => {
	it("tracker emits budget_exhausted event via callback", () => {
		const events: Array<{ type: string; sessionCost: number; sessionBudget: number }> = [];
		const tracker = new SessionCostTracker(1.0, (total, max) => {
			events.push({
				type: SUBAGENT_BUDGET_EXHAUSTED_EVENT,
				sessionCost: total,
				sessionBudget: max,
			});
		});

		tracker.add(0.3);
		assert.equal(events.length, 0);
		tracker.add(0.8);
		assert.equal(events.length, 1);
		assert.equal(events[0]!.type, "subagent.budget_exhausted");
		assert.equal(events[0]!.sessionCost, 1.1);
		assert.equal(events[0]!.sessionBudget, 1.0);
	});

	it("cost guard + retry compose: non-retriable cost failure is not retried", () => {
		const tracker = new SessionCostTracker(10.0);
		const costCheck = checkRunCostLimit(0.6, 0.5);
		assert.ok(costCheck.exceeded);

		// Cost exceeded should NOT be retried — it's a logical failure, not transient
		const retryDecision = shouldRetry(
			`Cost limit ($0.5000) reached: $0.6000`,
			1,
		);
		assert.equal(retryDecision, null, "Cost limit errors should not be retried");
	});

	it("full session lifecycle: budget accumulates across multiple runs", () => {
		const tracker = new SessionCostTracker(3.0);
		let exhausted = false;

		const guardedTracker = new SessionCostTracker(3.0, () => { exhausted = true; });

		// Simulate 5 runs
		guardedTracker.add(0.5);
		guardedTracker.add(0.8);
		guardedTracker.add(0.7);
		guardedTracker.add(1.1);
		assert.equal(guardedTracker.isExhausted, true);
		assert.ok(exhausted);
	});
});

describe("integration: timeout + trace depth", () => {
	it("timeout decreases with depth while trace env propagates depth", () => {
		const timeoutConfig = resolveTimeoutConfig(undefined, {});
		const traceRunId = resolveTraceRunId({ PI_TRACE_RUN_ID: "test-lifecycle-run" });

		// Depth 0
		const env0 = buildTraceEnv(traceRunId, "orchestrator", 0);
		const timeout0 = resolveTimeout(0, timeoutConfig);
		assert.equal(env0.PI_TRACE_SPAWN_DEPTH, "1");
		assert.equal(timeout0, 15 * 60 * 1000);

		// Depth 1
		const depth1 = parseInt(env0.PI_TRACE_SPAWN_DEPTH!, 10);
		const env1 = buildTraceEnv(traceRunId, "worker", depth1);
		const timeout1 = resolveTimeout(depth1, timeoutConfig);
		assert.equal(env1.PI_TRACE_SPAWN_DEPTH, "2");
		assert.equal(timeout1, 10 * 60 * 1000);

		// Depth 2
		const depth2 = parseInt(env1.PI_TRACE_SPAWN_DEPTH!, 10);
		const env2 = buildTraceEnv(traceRunId, "scout", depth2);
		const timeout2 = resolveTimeout(depth2, timeoutConfig);
		assert.equal(env2.PI_TRACE_SPAWN_DEPTH, "3");
		assert.equal(timeout2, 5 * 60 * 1000);
	});

	it("config resolved together: cost + retry + timeout from same source", () => {
		const env = {
			PI_SUBAGENT_MAX_COST: "0.50",
			PI_SESSION_MAX_COST: "3.00",
			PI_SUBAGENT_TIMEOUT_MS: "120000",
			PI_SUBAGENT_MAX_RETRIES: "3",
		};

		const costConfig = resolveCostGuardConfig(undefined, env);
		const timeoutConfig = resolveTimeoutConfig(undefined, env);
		const retryConfig = resolveRetryConfig(undefined, env);

		assert.equal(costConfig.maxPerRun, 0.5);
		assert.equal(costConfig.maxSessionBudget, 3.0);
		assert.equal(timeoutConfig.cascadeEnabled, false); // env override disables cascade
		assert.equal(timeoutConfig.baseMs, 120000);
		assert.equal(retryConfig.maxRetries, 3);
	});
});

describe("integration: turn cost rollup + manifest writing", () => {
	it("accumulates turns and writes manifest", () => {
		const rollups: TurnCostRollup[] = [];
		accumulateTurnCost(rollups, 0, { input: 100, output: 50, cost: 0.01 }, "model-a", "stop");
		accumulateTurnCost(rollups, 1, { input: 200, output: 100, cost: 0.02 }, "model-a", "stop");
		accumulateTurnCost(rollups, 2, { input: 150, output: 75, cost: 0.015 }, "model-b", "toolUse");

		const total = sumTurnRollups(rollups);
		assert.equal(total.input, 450);
		assert.equal(total.output, 225);
		assert.equal(total.cost, 0.045);
		assert.equal(total.turns, 3);

		// Write manifest
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-integration-test-"));
		try {
			const manifestPath = writeRunManifest(tmpDir, {
				runId: "integration-test-run",
				timestamp: new Date().toISOString(),
				mode: "chain",
				agent: "planner",
				taskCount: 3,
				successCount: 3,
				failCount: 0,
				totalCost: total.cost,
				totalTokens: { input: total.input, output: total.output },
				tasks: [
					{ agent: "scout", exitCode: 0, cost: 0.01 },
					{ agent: "planner", exitCode: 0, cost: 0.02 },
					{ agent: "worker", exitCode: 0, cost: 0.015 },
				],
			});

			assert.ok(manifestPath);
			const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
			assert.equal(manifest.totalCost, 0.045);
			assert.equal(manifest.tasks.length, 3);
			assert.equal(manifest.mode, "chain");
		} finally {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		}
	});
});

describe("integration: event type constants are unique strings", () => {
	it("all event types are distinct", () => {
		const eventTypes = [
			SUBAGENT_RUN_START_EVENT,
			SUBAGENT_RUN_END_EVENT,
			SUBAGENT_RUN_RETRY_EVENT,
			SUBAGENT_COST_CHECKPOINT_EVENT,
			SUBAGENT_BUDGET_EXHAUSTED_EVENT,
			SUBAGENT_TIMEOUT_EVENT,
		];
		const unique = new Set(eventTypes);
		assert.equal(unique.size, eventTypes.length, "All event types must be unique");
	});

	it("event types follow subagent.* namespace convention", () => {
		const eventTypes = [
			SUBAGENT_RUN_START_EVENT,
			SUBAGENT_RUN_END_EVENT,
			SUBAGENT_RUN_RETRY_EVENT,
			SUBAGENT_COST_CHECKPOINT_EVENT,
			SUBAGENT_BUDGET_EXHAUSTED_EVENT,
			SUBAGENT_TIMEOUT_EVENT,
		];
		for (const type of eventTypes) {
			assert.ok(type.startsWith("subagent."), `Event type "${type}" should start with "subagent."`);
		}
	});
});
