/**
 * Unit tests for allowed-agents-guard module
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	checkAllowedAgent,
	resolveParentAgentName,
} from "../../src/shared/allowed-agents-guard.ts";

const makeAgent = (name: string, agents?: string[]) =>
	({ name, agents, systemPrompt: "", source: "user" as const }) as any;

describe("allowed-agents-guard", () => {
	describe("checkAllowedAgent", () => {
		it("allows all when no parent agent", () => {
			const result = checkAllowedAgent(undefined, "worker", []);
			assert.equal(result.allowed, true);
		});

		it("allows all when parent has no agents field", () => {
			const agents = [makeAgent("orchestrator")];
			const result = checkAllowedAgent("orchestrator", "worker", agents);
			assert.equal(result.allowed, true);
		});

		it("allows when child is in agents list", () => {
			const agents = [makeAgent("orchestrator", ["worker", "scout"])];
			const result = checkAllowedAgent("orchestrator", "worker", agents);
			assert.equal(result.allowed, true);
		});

		it("blocks when child is NOT in agents list", () => {
			const agents = [makeAgent("orchestrator", ["worker", "scout"])];
			const result = checkAllowedAgent("orchestrator", "unknown", agents);
			assert.equal(result.allowed, false);
			assert.ok(result.reason?.includes("orchestrator"));
			assert.ok(result.reason?.includes("worker"));
			assert.ok(result.reason?.includes("unknown"));
		});

		it("allows when parent not found in agent list", () => {
			const result = checkAllowedAgent("missing-parent", "worker", []);
			assert.equal(result.allowed, true);
		});

		it("allows when agents field is empty array", () => {
			const agents = [makeAgent("orchestrator", [])];
			const result = checkAllowedAgent("orchestrator", "worker", agents);
			assert.equal(result.allowed, true);
		});
	});

	describe("resolveParentAgentName", () => {
		it("returns env var when set", () => {
			assert.equal(resolveParentAgentName({ PI_TRACE_AGENT_NAME: "orchestrator" }), "orchestrator");
		});

		it("returns undefined when not set", () => {
			assert.equal(resolveParentAgentName({}), undefined);
		});
	});
});
