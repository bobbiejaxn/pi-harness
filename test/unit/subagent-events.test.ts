/**
 * Unit tests for subagent-events module
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	accumulateTurnCost,
	sumTurnRollups,
	type TurnCostRollup,
} from "../../src/shared/subagent-events.ts";

describe("subagent-events", () => {
	describe("accumulateTurnCost", () => {
		it("creates new rollup for new turn", () => {
			const rollups = accumulateTurnCost([], 0, {
				input: 100,
				output: 50,
				cacheRead: 10,
				cacheWrite: 5,
				cost: 0.01,
			});
			assert.equal(rollups.length, 1);
			assert.equal(rollups[0].turnIndex, 0);
			assert.equal(rollups[0].input, 100);
			assert.equal(rollups[0].cost, 0.01);
		});

		it("accumulates into existing turn", () => {
			let rollups = accumulateTurnCost([], 0, { input: 100, output: 50 });
			rollups = accumulateTurnCost(rollups, 0, { input: 50, output: 25 });
			assert.equal(rollups.length, 1);
			assert.equal(rollups[0].input, 150);
			assert.equal(rollups[0].output, 75);
		});

		it("handles multiple turns", () => {
			let rollups = accumulateTurnCost([], 0, { input: 100 });
			rollups = accumulateTurnCost(rollups, 1, { input: 200 });
			rollups = accumulateTurnCost(rollups, 2, { input: 150 });
			assert.equal(rollups.length, 3);
			assert.equal(rollups[0].input, 100);
			assert.equal(rollups[1].input, 200);
			assert.equal(rollups[2].input, 150);
		});

		it("captures model and stop reason", () => {
			const rollups = accumulateTurnCost([], 0, { cost: 0.01 }, "claude-sonnet-4", "stop");
			assert.equal(rollups[0].model, "claude-sonnet-4");
			assert.equal(rollups[0].stopReason, "stop");
		});
	});

	describe("sumTurnRollups", () => {
		it("sums empty array", () => {
			const total = sumTurnRollups([]);
			assert.equal(total.input, 0);
			assert.equal(total.output, 0);
			assert.equal(total.cost, 0);
			assert.equal(total.turns, 0);
		});

		it("sums multiple rollups", () => {
			const rollups: TurnCostRollup[] = [
				{ turnIndex: 0, input: 100, output: 50, cacheRead: 10, cacheWrite: 5, cost: 0.01 },
				{ turnIndex: 1, input: 200, output: 100, cacheRead: 20, cacheWrite: 10, cost: 0.02 },
				{ turnIndex: 2, input: 150, output: 75, cacheRead: 15, cacheWrite: 8, cost: 0.015 },
			];
			const total = sumTurnRollups(rollups);
			assert.equal(total.input, 450);
			assert.equal(total.output, 225);
			assert.equal(total.cacheRead, 45);
			assert.equal(total.cacheWrite, 23);
			assert.equal(total.cost, 0.045);
			assert.equal(total.turns, 3);
		});
	});
});
