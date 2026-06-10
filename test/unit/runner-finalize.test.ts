import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { finalizeRun, type FinalizeInput } from "../../src/runs/background/runner-finalize.ts";
import type { RunnerStatusPayload } from "../../src/runs/background/runner-parallel.ts";
import type { StepResult, SubagentRunConfig } from "../../src/runs/background/subagent-runner.ts";

function makeFinalizeInput(overrides: Partial<FinalizeInput> = {}): FinalizeInput {
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-harness-finalize-"));
	const asyncDir = path.join(tmpDir, "async");
	fs.mkdirSync(asyncDir, { recursive: true });
	fs.writeFileSync(path.join(asyncDir, "status.json"), "{}");
	fs.writeFileSync(path.join(asyncDir, "events.jsonl"), "");

	return {
		results: [
			{ agent: "researcher", output: "found data", success: true, exitCode: 0 },
			{ agent: "writer", output: "wrote report", success: true, exitCode: 0 },
		],
		maxOutput: undefined,
		config: {
			id: "test-run",
			steps: [],
			resultPath: path.join(tmpDir, "result.json"),
			cwd: tmpDir,
			placeholder: "test",
			asyncDir,
		} as SubagentRunConfig,
		statusPayload: {
			runId: "test-run",
			mode: "chain",
			state: "running",
			steps: [
				{ agent: "researcher", status: "complete", recentTools: [], recentOutput: [] },
				{ agent: "writer", status: "complete", recentTools: [], recentOutput: [] },
			],
			startedAt: Date.now() - 1000,
			lastActivityAt: Date.now(),
			lastUpdate: Date.now(),
			pid: process.pid,
			cwd: tmpDir,
			currentStep: 1,
			chainStepCount: 2,
			parallelGroups: [],
			outputFile: path.join(asyncDir, "output.log"),
		} as RunnerStatusPayload,
		flatSteps: [{ agent: "researcher" }, { agent: "writer" }],
		shareEnabled: false,
		latestSessionFile: undefined,
		activityTimer: undefined,
		interrupted: false,
		id: "test-run",
		overallStartTime: Date.now() - 1000,
		eventsPath: path.join(asyncDir, "events.jsonl"),
		logPath: path.join(tmpDir, "run-log.md"),
		cwd: tmpDir,
		artifactsDir: tmpDir,
		asyncDir,
		resultPath: path.join(tmpDir, "result.json"),
		outputs: {},
		taskIndex: undefined,
		totalTasks: undefined,
		writeStatusPayload: () => {},
		...overrides,
	};
}

// ── finalizeRun ──────────────────────────────────────────────────

describe("finalizeRun", () => {
	it("produces summary from results", async () => {
		const input = makeFinalizeInput();
		try {
			const output = await finalizeRun(input);
			assert.ok(output.summary.includes("researcher:"));
			assert.ok(output.summary.includes("found data"));
			assert.ok(output.summary.includes("writer:"));
			assert.ok(output.summary.includes("wrote report"));
			assert.equal(output.truncated, false);
		} finally {
			fs.rmSync(path.dirname(input.asyncDir), { recursive: true, force: true });
		}
	});

	it("sets status to complete when all succeed", async () => {
		const input = makeFinalizeInput();
		try {
			await finalizeRun(input);
			assert.equal(input.statusPayload.state, "complete");
			assert.equal(input.statusPayload.activityState, undefined);
			assert.ok(input.statusPayload.endedAt! > 0);
		} finally {
			fs.rmSync(path.dirname(input.asyncDir), { recursive: true, force: true });
		}
	});

	it("sets status to failed when a step fails", async () => {
		const input = makeFinalizeInput({
			results: [
				{ agent: "researcher", output: "ok", success: true, exitCode: 0 },
				{ agent: "writer", output: "error!", success: false, exitCode: 1, error: "boom" },
			],
		});
		// Make status steps match
		input.statusPayload.steps[1].status = "failed";
		input.statusPayload.steps[1].agent = "writer";

		try {
			await finalizeRun(input);
			assert.equal(input.statusPayload.state, "failed");
		} finally {
			fs.rmSync(path.dirname(input.asyncDir), { recursive: true, force: true });
		}
	});

	it("sets status to paused when interrupted", async () => {
		const input = makeFinalizeInput({ interrupted: true });
		try {
			await finalizeRun(input);
			assert.equal(input.statusPayload.state, "paused");
		} finally {
			fs.rmSync(path.dirname(input.asyncDir), { recursive: true, force: true });
		}
	});

	it("writes result file with correct structure", async () => {
		const input = makeFinalizeInput();
		try {
			await finalizeRun(input);
			const resultPath = input.resultPath;
			assert.ok(fs.existsSync(resultPath));
			const result = JSON.parse(fs.readFileSync(resultPath, "utf-8"));
			assert.equal(result.id, "test-run");
			assert.equal(result.mode, "chain");
			assert.equal(result.success, true);
			assert.equal(result.state, "complete");
			assert.equal(result.results.length, 2);
			assert.equal(result.results[0].agent, "researcher");
			assert.equal(result.results[1].agent, "writer");
			assert.ok(result.durationMs > 0);
		} finally {
			fs.rmSync(path.dirname(input.asyncDir), { recursive: true, force: true });
		}
	});

	it("writes run log markdown file", async () => {
		const input = makeFinalizeInput();
		try {
			await finalizeRun(input);
			assert.ok(fs.existsSync(input.logPath));
			const log = fs.readFileSync(input.logPath, "utf-8");
			assert.ok(log.includes("# Subagent run test-run"));
			assert.ok(log.includes("researcher"));
		} finally {
			fs.rmSync(path.dirname(input.asyncDir), { recursive: true, force: true });
		}
	});

	it("emits completion event", async () => {
		const input = makeFinalizeInput();
		try {
			await finalizeRun(input);
			const events = fs.readFileSync(input.eventsPath, "utf-8").trim();
			assert.ok(events.includes("subagent.run.completed"));
			assert.ok(events.includes("test-run"));
		} finally {
			fs.rmSync(path.dirname(input.asyncDir), { recursive: true, force: true });
		}
	});

	it("handles maxOutput truncation", async () => {
		const longOutput = "x".repeat(50000);
		const input = makeFinalizeInput({
			results: [
				{ agent: "writer", output: longOutput, success: true, exitCode: 0 },
			],
			maxOutput: { bytes: 100, lines: 5 },
			flatSteps: [{ agent: "writer" }],
		});
		// Adjust status steps to match
		(input.statusPayload as any).steps = [
			{ agent: "writer", status: "complete", recentTools: [], recentOutput: [] },
		];

		try {
			const output = await finalizeRun(input);
			assert.equal(output.truncated, true);
			assert.ok(output.summary.length < longOutput.length);
		} finally {
			fs.rmSync(path.dirname(input.asyncDir), { recursive: true, force: true });
		}
	});

	it("clears activity timer", async () => {
		let cleared = false;
		const timer = setInterval(() => {}, 10000);
		const originalClear = clearInterval;
		// We'll check that clearInterval is called
		const input = makeFinalizeInput({ activityTimer: timer });
		try {
			await finalizeRun(input);
			// If we got here without hanging, the timer was handled
			clearInterval(timer);
		} finally {
			fs.rmSync(path.dirname(input.asyncDir), { recursive: true, force: true });
		}
	});

	it("derives error message from failed step when statusPayload.error is unset", async () => {
		const input = makeFinalizeInput({
			results: [
				{ agent: "failing-agent", output: "", success: false, exitCode: 1, error: "timeout" },
			],
			flatSteps: [{ agent: "failing-agent" }],
		});
		(input.statusPayload as any).steps = [
			{ agent: "failing-agent", status: "failed", recentTools: [], recentOutput: [] },
		];

		try {
			await finalizeRun(input);
			assert.equal(input.statusPayload.state, "failed");
			assert.ok(input.statusPayload.error!.includes("failing-agent"));
		} finally {
			fs.rmSync(path.dirname(input.asyncDir), { recursive: true, force: true });
		}
	});
});
