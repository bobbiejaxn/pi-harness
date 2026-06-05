/**
 * Unit tests for cost-guard module
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	resolveCostGuardConfig,
	SessionCostTracker,
	checkRunCostLimit,
	formatCost,
	DEFAULT_COST_GUARD,
} from "../../src/shared/cost-guard.ts";

describe("cost-guard", () => {
	describe("resolveCostGuardConfig", () => {
		it("returns defaults when no config or env", () => {
			const result = resolveCostGuardConfig(undefined, {});
			assert.equal(result.maxPerRun, Infinity);
			assert.equal(result.maxSessionBudget, Infinity);
		});

		it("uses config values when provided", () => {
			const result = resolveCostGuardConfig(
				{ maxPerRun: 0.5, maxSessionBudget: 3.0 },
				{},
			);
			assert.equal(result.maxPerRun, 0.5);
			assert.equal(result.maxSessionBudget, 3.0);
		});

		it("env overrides config", () => {
			const result = resolveCostGuardConfig(
				{ maxPerRun: 0.5, maxSessionBudget: 3.0 },
				{ PI_SUBAGENT_MAX_COST: "1.00", PI_SESSION_MAX_COST: "10.00" },
			);
			assert.equal(result.maxPerRun, 1.0);
			assert.equal(result.maxSessionBudget, 10.0);
		});

		it("ignores non-numeric env values", () => {
			const result = resolveCostGuardConfig(
				{ maxPerRun: 0.5 },
				{ PI_SUBAGENT_MAX_COST: "not-a-number" },
			);
			assert.equal(result.maxPerRun, 0.5);
		});

		it("ignores zero and negative env values", () => {
			const result = resolveCostGuardConfig(undefined, {
				PI_SUBAGENT_MAX_COST: "0",
				PI_SESSION_MAX_COST: "-5",
			});
			assert.equal(result.maxPerRun, Infinity);
			assert.equal(result.maxSessionBudget, Infinity);
		});
	});

	describe("SessionCostTracker", () => {
		it("starts at zero", () => {
			const tracker = new SessionCostTracker(3.0);
			assert.equal(tracker.cumulative, 0);
			assert.equal(tracker.isExhausted, false);
			assert.equal(tracker.remaining, 3.0);
		});

		it("accumulates costs", () => {
			const tracker = new SessionCostTracker(3.0);
			tracker.add(0.5);
			tracker.add(0.3);
			assert.equal(tracker.cumulative, 0.8);
			assert.equal(tracker.remaining, 2.2);
		});

		it("detects exhaustion", () => {
			const tracker = new SessionCostTracker(1.0);
			tracker.add(0.6);
			assert.equal(tracker.isExhausted, false);
			tracker.add(0.5);
			assert.equal(tracker.isExhausted, true);
			assert.equal(tracker.remaining, 0);
		});

		it("fires callback on budget exceeded", () => {
			let exceeded = false;
			const tracker = new SessionCostTracker(1.0, (total, max) => {
				exceeded = true;
				assert.equal(total, 1.1);
				assert.equal(max, 1.0);
			});
			tracker.add(1.1);
			assert.equal(exceeded, true);
		});

		it("reset clears state", () => {
			const tracker = new SessionCostTracker(1.0);
			tracker.add(0.8);
			tracker.reset();
			assert.equal(tracker.cumulative, 0);
			assert.equal(tracker.isExhausted, false);
		});

		it("handles Infinity budget", () => {
			const tracker = new SessionCostTracker(Infinity);
			tracker.add(1000000);
			assert.equal(tracker.isExhausted, false);
			assert.equal(tracker.remaining, Infinity);
		});
	});

	describe("checkRunCostLimit", () => {
		it("not exceeded when under limit", () => {
			const result = checkRunCostLimit(0.3, 0.5);
			assert.equal(result.exceeded, false);
		});

		it("exceeded when at or over limit", () => {
			const result = checkRunCostLimit(0.5, 0.5);
			assert.equal(result.exceeded, true);
		});

		it("never exceeded with Infinity limit", () => {
			const result = checkRunCostLimit(999, Infinity);
			assert.equal(result.exceeded, false);
		});
	});

	describe("formatCost", () => {
		it("formats to 4 decimal places", () => {
			assert.equal(formatCost(0.5), "$0.5000");
			assert.equal(formatCost(0.123456), "$0.1235");
			assert.equal(formatCost(0), "$0.0000");
		});
	});
});
