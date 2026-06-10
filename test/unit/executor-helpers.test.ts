import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import {
	resolveRequestedCwd,
	rememberForegroundRun,
} from "../../src/runs/foreground/executor-helpers.ts";
import type { SubagentState } from "../../src/shared/types.ts";

// ── resolveRequestedCwd ──────────────────────────────────────────

describe("resolveRequestedCwd", () => {
	it("returns runtimeCwd when no requestedCwd", () => {
		assert.equal(resolveRequestedCwd("/project", undefined), "/project");
	});

	it("returns runtimeCwd when requestedCwd is empty string", () => {
		assert.equal(resolveRequestedCwd("/project", ""), "/project");
	});

	it("resolves relative path against runtimeCwd", () => {
		const result = resolveRequestedCwd("/project", "src/lib");
		assert.equal(result, path.resolve("/project", "src/lib"));
	});

	it("handles absolute path", () => {
		const result = resolveRequestedCwd("/project", "/tmp/work");
		assert.equal(result, "/tmp/work");
	});

	it("handles parent directory traversal", () => {
		const result = resolveRequestedCwd("/project/src", "../test");
		assert.equal(result, path.resolve("/project/src", "../test"));
	});
});

// ── rememberForegroundRun ────────────────────────────────────────

describe("rememberForegroundRun", () => {
	it("stores run in foregroundRuns map", () => {
		const state: Partial<SubagentState> = { foregroundRuns: new Map() };
		const results = [{ agent: "researcher", output: "done", success: true }];

		rememberForegroundRun(state as SubagentState, {
			runId: "run-123",
			mode: "single",
			cwd: "/project",
			results,
		});

		const stored = state.foregroundRuns!.get("run-123");
		assert.ok(stored);
		assert.equal(stored.runId, "run-123");
		assert.equal(stored.mode, "single");
		assert.equal(stored.cwd, "/project");
		assert.equal(stored.children.length, 1);
		assert.equal(stored.children[0].agent, "researcher");
	});

	it("stores multiple children for parallel mode", () => {
		const state: Partial<SubagentState> = { foregroundRuns: new Map() };
		const results = [
			{ agent: "researcher", output: "a", success: true },
			{ agent: "writer", output: "b", success: true },
		];

		rememberForegroundRun(state as SubagentState, {
			runId: "run-parallel",
			mode: "parallel",
			cwd: "/project",
			results,
		});

		const stored = state.foregroundRuns!.get("run-parallel");
		assert.ok(stored);
		assert.equal(stored.children.length, 2);
		assert.equal(stored.children[0].agent, "researcher");
		assert.equal(stored.children[1].agent, "writer");
	});

	it("stores up to 50 runs and evicts oldest", () => {
		const state: Partial<SubagentState> = { foregroundRuns: new Map() };

		// Add 51 runs
		for (let i = 0; i < 51; i++) {
			rememberForegroundRun(state as SubagentState, {
				runId: `run-${i}`,
				mode: "single",
				cwd: "/project",
				results: [],
			});
		}

		// Should have evicted the oldest
		assert.equal(state.foregroundRuns!.size, 50);
		assert.ok(!state.foregroundRuns!.has("run-0"));
		assert.ok(state.foregroundRuns!.has("run-50"));
	});
});
