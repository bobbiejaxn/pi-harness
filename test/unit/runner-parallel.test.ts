import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
	markParallelGroupSetupFailure,
	markParallelGroupRunning,
	prepareParallelTaskRun,
	appendParallelWorktreeSummary,
	ensureParallelProgressFile,
	type RunnerStatusPayload,
} from "../../src/runs/background/runner-parallel.ts";
import type { RunnerStatusStep } from "../../src/runs/background/subagent-runner.ts";

function makeStatusPayload(overrides: Partial<RunnerStatusPayload> = {}): RunnerStatusPayload {
	return {
		runId: "test-run",
		mode: "parallel",
		state: "running",
		lastActivityAt: Date.now(),
		startedAt: Date.now(),
		lastUpdate: Date.now(),
		pid: process.pid,
		cwd: "/tmp",
		currentStep: 0,
		chainStepCount: 1,
		parallelGroups: [],
		steps: [],
		outputFile: "/tmp/output.log",
		...overrides,
	} as RunnerStatusPayload;
}

function makeStep(overrides: Partial<RunnerStatusStep> = {}): RunnerStatusStep {
	return {
		agent: "test-agent",
		status: "pending",
		recentTools: [],
		recentOutput: [],
		...overrides,
	} as RunnerStatusStep;
}

// ── markParallelGroupSetupFailure ────────────────────────────────

describe("markParallelGroupSetupFailure", () => {
	it("marks all parallel tasks as failed", () => {
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-harness-parallel-"));
		const statusPath = path.join(tmpDir, "status.json");
		const eventsPath = path.join(tmpDir, "events.jsonl");
		fs.writeFileSync(eventsPath, "");

		const steps: RunnerStatusStep[] = [
			makeStep({ agent: "agent-a" }),
			makeStep({ agent: "agent-b" }),
		];
		const statusPayload = makeStatusPayload({ steps });
		const results: Array<{ agent: string; output: string; success: boolean; exitCode: number }> = [];

		const now = Date.now();
		markParallelGroupSetupFailure({
			statusPayload,
			results: results as any,
			group: { parallel: [{ agent: "agent-a" }, { agent: "agent-b" }] } as any,
			groupStartFlatIndex: 0,
			setupError: "worktree setup failed",
			failedAt: now,
			statusPath,
			eventsPath,
			asyncDir: tmpDir,
			runId: "test-run",
			stepIndex: 0,
		});

		assert.equal(steps[0].status, "failed");
		assert.equal(steps[1].status, "failed");
		assert.equal(steps[0].exitCode, 1);
		assert.equal(steps[1].exitCode, 1);
		assert.equal(results.length, 2);
		assert.equal(results[0].agent, "agent-a");
		assert.equal(results[0].success, false);
		assert.equal(results[1].agent, "agent-b");

		// Status file should be written
		const statusContent = JSON.parse(fs.readFileSync(statusPath, "utf-8"));
		assert.equal(statusContent.currentStep, 0);

		// Events file should have the completion event
		const events = fs.readFileSync(eventsPath, "utf-8").trim();
		assert.ok(events.includes("subagent.parallel.completed"));

		fs.rmSync(tmpDir, { recursive: true, force: true });
	});
});

// ── markParallelGroupRunning ─────────────────────────────────────

describe("markParallelGroupRunning", () => {
	it("resets all parallel tasks to pending", () => {
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-harness-parallel-"));
		const statusPath = path.join(tmpDir, "status.json");
		const eventsPath = path.join(tmpDir, "events.jsonl");
		fs.writeFileSync(eventsPath, "");

		const steps: RunnerStatusStep[] = [
			makeStep({ agent: "agent-a", status: "failed", error: "old error" }),
			makeStep({ agent: "agent-b", status: "complete", startedAt: 123 }),
		];
		const statusPayload = makeStatusPayload({ steps });

		const now = Date.now();
		markParallelGroupRunning({
			statusPayload,
			group: { parallel: [{ agent: "agent-a" }, { agent: "agent-b" }] } as any,
			groupStartFlatIndex: 0,
			groupStartTime: now,
			statusPath,
			eventsPath,
			asyncDir: tmpDir,
			runId: "test-run",
			stepIndex: 0,
		});

		assert.equal(steps[0].status, "pending");
		assert.equal(steps[0].error, undefined);
		assert.equal(steps[0].startedAt, undefined);
		assert.equal(steps[1].status, "pending");
		assert.equal(steps[1].startedAt, undefined);

		// Events file should have the started event
		const events = fs.readFileSync(eventsPath, "utf-8").trim();
		assert.ok(events.includes("subagent.parallel.started"));
		assert.ok(events.includes("agent-a"));
		assert.ok(events.includes("agent-b"));

		fs.rmSync(tmpDir, { recursive: true, force: true });
	});
});

// ── prepareParallelTaskRun ──────────────────────────────────────

describe("prepareParallelTaskRun", () => {
	it("returns original task and cwd when no worktree", () => {
		const task = { agent: "researcher", task: "do research" } as any;
		const result = prepareParallelTaskRun(task, "/project", undefined, 0);
		assert.equal(result.taskForRun, task);
		assert.equal(result.taskCwd, "/project");
	});

	it("returns worktree cwd when worktree is set", () => {
		const task = { agent: "researcher", task: "do research", cwd: "/project" } as any;
		const worktreeSetup = {
			worktrees: [{ agentCwd: "/tmp/worktree-0" }, { agentCwd: "/tmp/worktree-1" }],
		} as any;
		const result = prepareParallelTaskRun(task, "/project", worktreeSetup, 1);
		assert.equal(result.taskCwd, "/tmp/worktree-1");
		assert.equal(result.taskForRun.cwd, undefined);
	});
});

// ── appendParallelWorktreeSummary ───────────────────────────────

describe("appendParallelWorktreeSummary", () => {
	it("returns previousOutput unchanged when no worktree", () => {
		const result = appendParallelWorktreeSummary(
			"original output",
			undefined,
			"/tmp",
			0,
			{ parallel: [] } as any,
		);
		assert.equal(result, "original output");
	});
});

// ── ensureParallelProgressFile ──────────────────────────────────

describe("ensureParallelProgressFile", () => {
	it("creates progress.md when a task references it", () => {
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-harness-progress-"));
		try {
			const group = {
				parallel: [
					{ agent: "writer", task: "Update progress at: " + path.join(tmpDir, "progress.md") },
				],
			} as any;

			ensureParallelProgressFile(tmpDir, group);

			assert.ok(fs.existsSync(path.join(tmpDir, "progress.md")));
		} finally {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		}
	});

	it("does not create file when no task references progress.md", () => {
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-harness-progress-"));
		try {
			const group = {
				parallel: [{ agent: "writer", task: "Just write code" }],
			} as any;

			ensureParallelProgressFile(tmpDir, group);

			assert.ok(!fs.existsSync(path.join(tmpDir, "progress.md")));
		} finally {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		}
	});
});
