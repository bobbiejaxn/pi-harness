import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
	tokenUsageFromAttempts,
	appendRecentStepOutput,
	resetStepLiveDetail,
	formatDuration,
	writeRunLog,
	emptyUsage,
} from "../../src/runs/background/runner-utils.ts";
import type { ChildEvent, RunnerStatusStep } from "../../src/runs/background/runner-utils.ts";
import type { ModelAttempt } from "../../src/shared/types.ts";

// ── tokenUsageFromAttempts ───────────────────────────────────────

describe("tokenUsageFromAttempts", () => {
	it("returns null for undefined", () => {
		assert.equal(tokenUsageFromAttempts(undefined), null);
	});

	it("returns null for empty array", () => {
		assert.equal(tokenUsageFromAttempts([]), null);
	});

	it("sums token usage across attempts", () => {
		const attempts: ModelAttempt[] = [
			{ model: "a", usage: { input: 100, output: 50 } },
			{ model: "b", usage: { input: 200, output: 75 } },
		];
		const result = tokenUsageFromAttempts(attempts);
		assert.deepEqual(result, { input: 300, output: 125, total: 425 });
	});

	it("returns null when all attempts have zero usage", () => {
		const attempts: ModelAttempt[] = [
			{ model: "a", usage: { input: 0, output: 0 } },
		];
		assert.equal(tokenUsageFromAttempts(attempts), null);
	});

	it("handles missing usage gracefully", () => {
		const attempts: ModelAttempt[] = [
			{ model: "a" },
			{ model: "b", usage: { input: 10, output: 5 } },
		];
		assert.deepEqual(tokenUsageFromAttempts(attempts), { input: 10, output: 5, total: 15 });
	});
});

// ── appendRecentStepOutput ───────────────────────────────────────

describe("appendRecentStepOutput", () => {
	it("appends non-empty lines to recentOutput", () => {
		const step: Partial<RunnerStatusStep> = {};
		appendRecentStepOutput(step as RunnerStatusStep, ["hello", "world"]);
		assert.deepEqual(step.recentOutput, ["hello", "world"]);
	});

	it("skips empty/whitespace-only lines", () => {
		const step: Partial<RunnerStatusStep> = { recentOutput: [] };
		appendRecentStepOutput(step as RunnerStatusStep, ["  ", "", "content"]);
		assert.deepEqual(step.recentOutput, ["content"]);
	});

	it("trims to 50 entries max", () => {
		const step: Partial<RunnerStatusStep> = { recentOutput: [] };
		const lines = Array.from({ length: 60 }, (_, i) => `line-${i}`);
		appendRecentStepOutput(step as RunnerStatusStep, lines);
		assert.equal(step.recentOutput!.length, 50);
		// Should keep the latest 50
		assert.equal(step.recentOutput![0], "line-10");
		assert.equal(step.recentOutput![49], "line-59");
	});

	it("does nothing when all lines are empty", () => {
		const step: Partial<RunnerStatusStep> = {};
		appendRecentStepOutput(step as RunnerStatusStep, ["", "  "]);
		assert.equal(step.recentOutput, undefined);
	});
});

// ── resetStepLiveDetail ──────────────────────────────────────────

describe("resetStepLiveDetail", () => {
	it("clears all live detail fields", () => {
		const step: Partial<RunnerStatusStep> = {
			currentTool: "write_file",
			currentToolArgs: { path: "/tmp/x" },
			currentToolStartedAt: Date.now(),
			currentPath: "/tmp/x",
			recentTools: ["read_file"],
			recentOutput: ["old output"],
		};
		resetStepLiveDetail(step as RunnerStatusStep);
		assert.equal(step.currentTool, undefined);
		assert.equal(step.currentToolArgs, undefined);
		assert.equal(step.currentToolStartedAt, undefined);
		assert.equal(step.currentPath, undefined);
		assert.deepEqual(step.recentTools, []);
		assert.deepEqual(step.recentOutput, []);
	});
});

// ── formatDuration ──────────────────────────────────────────────

describe("formatDuration", () => {
	it("formats milliseconds", () => {
		assert.equal(formatDuration(500), "500ms");
	});

	it("formats seconds", () => {
		assert.equal(formatDuration(1500), "1.5s");
		assert.equal(formatDuration(30000), "30.0s");
	});

	it("formats minutes and seconds", () => {
		assert.equal(formatDuration(90000), "1m30s");
		assert.equal(formatDuration(3661000), "61m1s");
	});

	it("formats exact minute", () => {
		assert.equal(formatDuration(60000), "1m0s");
	});
});

// ── writeRunLog ─────────────────────────────────────────────────

describe("writeRunLog", () => {
	it("writes a markdown run log", () => {
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-harness-log-"));
		const logPath = path.join(tmpDir, "run.md");
		try {
			writeRunLog(logPath, {
				id: "test-run-1",
				mode: "chain",
				cwd: "/project",
				startedAt: 1700000000000,
				endedAt: 1700000060000,
				steps: [
					{ agent: "researcher", status: "complete", durationMs: 30000 },
					{ agent: "writer", status: "complete", durationMs: 30000 },
				],
				summary: "Task completed successfully.",
				truncated: false,
			});

			const content = fs.readFileSync(logPath, "utf-8");
			assert.ok(content.includes("# Subagent run test-run-1"));
			assert.ok(content.includes("**Mode:** chain"));
			assert.ok(content.includes("| 1 | researcher | complete |"));
			assert.ok(content.includes("Task completed successfully."));
		} finally {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		}
	});

	it("marks truncated output", () => {
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-harness-log-"));
		const logPath = path.join(tmpDir, "run.md");
		try {
			writeRunLog(logPath, {
				id: "run-2",
				mode: "single",
				cwd: "/tmp",
				startedAt: 1000,
				endedAt: 2000,
				steps: [],
				summary: "big output",
				truncated: true,
			});

			const content = fs.readFileSync(logPath, "utf-8");
			assert.ok(content.includes("_Output truncated_"));
		} finally {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		}
	});
});

// ── emptyUsage ──────────────────────────────────────────────────

describe("emptyUsage", () => {
	it("returns zeroed usage", () => {
		const usage = emptyUsage();
		assert.equal(usage.input, 0);
		assert.equal(usage.output, 0);
		assert.equal(usage.turns, 0);
		assert.equal(usage.cost, 0);
	});
});
