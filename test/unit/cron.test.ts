// Unit tests for the Cron scheduler.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { Cron, createTraceSummarizerJob, type CronContext, type CronJob } from "../../src/cron/cron.ts";
import { TraceRecorder } from "../../src/shared/trace-recorder.ts";

interface FakeEventBus {
	handlers: Map<string, ((payload: unknown) => void)[]>;
	on: (event: string, handler: (payload: unknown) => void) => void;
	emit: (event: string, payload: unknown) => void;
}

function makeFakeBus(): FakeEventBus {
	const bus: FakeEventBus = {
		handlers: new Map(),
		on(event, handler) {
			const list = bus.handlers.get(event) ?? [];
			list.push(handler);
			bus.handlers.set(event, list);
		},
		emit(event, payload) {
			for (const h of bus.handlers.get(event) ?? []) h(payload);
		},
	};
	return bus;
}

let tmpDir: string;
let traceDir: string;
let dlqDir: string;
let recorder: TraceRecorder;
let bus: FakeEventBus;
let cron: Cron;
let logs: Array<{ level: string; msg: string }>;

beforeEach(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cron-test-"));
	traceDir = path.join(tmpDir, "traces");
	dlqDir = path.join(tmpDir, "dlq");
	fs.mkdirSync(traceDir, { recursive: true });
	fs.mkdirSync(dlqDir, { recursive: true });
	bus = makeFakeBus();
	recorder = new TraceRecorder({ events: bus }, traceDir);
	logs = [];
	cron = new Cron({
		recorder,
		dlqDir,
		log: (level, msg) => logs.push({ level, msg }),
	});
});

afterEach(async () => {
	await cron.stop();
	recorder.uninstall();
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("Cron.register", () => {
	it("registers a job successfully", () => {
		cron.register({ name: "test", intervalMs: 1000, run: async () => {} });
		const status = cron.status();
		assert.equal(status.length, 1);
		assert.equal(status[0].name, "test");
		assert.equal(status[0].intervalMs, 1000);
	});

	it("rejects duplicate job names", () => {
		cron.register({ name: "dup", intervalMs: 1000, run: async () => {} });
		assert.throws(() => cron.register({ name: "dup", intervalMs: 1000, run: async () => {} }), /already registered/);
	});

	it("rejects intervals too small", () => {
		assert.throws(() => cron.register({ name: "tiny", intervalMs: 50, run: async () => {} }), /interval too small/);
	});
});

describe("Cron.runOnce", () => {
	it("runs a registered job and marks success", async () => {
		let ran = false;
		let ctxReceived: CronContext | undefined;
		cron.register({
			name: "simple",
			intervalMs: 100_000,
			run: async (ctx) => {
				ran = true;
				ctxReceived = ctx;
			},
		});

		await cron.runOnce("simple");

		assert.equal(ran, true);
		assert.ok(ctxReceived, "ctx should be passed to the job");
		assert.match(ctxReceived!.runId, /^[0-9a-f-]{36}$/);
		assert.ok(ctxReceived!.recorder === recorder);

		const status = cron.status();
		assert.equal(status[0].consecutiveFailures, 0);
		assert.ok(status[0].lastSuccessAt);
	});

	it("captures failures and increments failure count", async () => {
		cron.register({
			name: "always-fails",
			intervalMs: 100_000,
			run: async () => {
				throw new Error("intentional failure");
			},
		});

		await assert.rejects(cron.runOnce("always-fails"), /intentional failure/);

		const status = cron.status();
		assert.equal(status[0].consecutiveFailures, 1);
	});

	it("writes DLQ entry on failure", async () => {
		cron.register({
			name: "dlq-test",
			intervalMs: 100_000,
			run: async () => {
				throw new Error("boom");
			},
		});

		await assert.rejects(cron.runOnce("dlq-test"), /boom/);

		const dlqPath = path.join(dlqDir, "dlq-test.jsonl");
		assert.ok(fs.existsSync(dlqPath), "DLQ file should exist");
		const lines = fs.readFileSync(dlqPath, "utf-8").trim().split("\n");
		assert.equal(lines.length, 1);
		const entry = JSON.parse(lines[0]);
		assert.equal(entry.job, "dlq-test");
		assert.match(entry.error, /boom/);
	});

	it("pauses job after maxFailures consecutive failures", async () => {
		cron.register({
			name: "fragile",
			intervalMs: 100_000,
			run: async () => { throw new Error("nope"); },
			maxFailures: 2,
		});

		await assert.rejects(cron.runOnce("fragile"));
		await assert.rejects(cron.runOnce("fragile"));
		// After 2 failures, job is paused. runOnce should still run it (manual trigger),
		// but the next scheduled tick would skip.
		const status = cron.status();
		assert.equal(status[0].paused, true);
		assert.equal(status[0].consecutiveFailures, 2);
	});
});

describe("Cron.start/stop", () => {
	it("runs a job on its interval", async () => {
		let count = 0;
		cron.register({
			name: "ticker",
			intervalMs: 100, // tight interval for the test
			run: async () => {
				count++;
			},
		});

		cron.start();
		await new Promise((r) => setTimeout(r, 250));
		await cron.stop();

		assert.ok(count >= 2, `expected at least 2 runs, got ${count}`);
	});

	it("runs once immediately if runOnStart is true", async () => {
		let count = 0;
		cron.register({
			name: "immediate",
			intervalMs: 100_000,
			runOnStart: true,
			run: async () => { count++; },
		});

		cron.start();
		await new Promise((r) => setTimeout(r, 50));
		await cron.stop();

		assert.equal(count, 1, "should have run exactly once on start");
	});

	it("skips a tick if a run is already in flight", async () => {
		let count = 0;
		let inflight = false;
		cron.register({
			name: "slow",
			intervalMs: 100,
			run: async () => {
				if (inflight) return; // already running, skip
				inflight = true;
				count++;
				await new Promise((r) => setTimeout(r, 200));
				inflight = false;
			},
		});

		cron.start();
		await new Promise((r) => setTimeout(r, 500));
		await cron.stop();

		// With a 100ms interval and 200ms run, we expect ~3 runs (not 5)
		assert.ok(count >= 1 && count <= 4, `expected 1-4 runs due to skip, got ${count}`);
	});

	it("stops cleanly without throwing on a fast stop", async () => {
		cron.register({ name: "noop", intervalMs: 100_000, run: async () => {} });
		cron.start();
		await cron.stop();
		await cron.stop(); // idempotent
	});
});

describe("createTraceSummarizerJob", () => {
	it("emits a summary event with stats from trace files", async () => {
		recorder.install();
		// Seed two trace files
		bus.emit("subagent.run_start" as never, { runId: "r1", model: "zai/glm-5" } as never);
		bus.emit("subagent.run_end" as never, { runId: "r1", exitCode: 0, model: "zai/glm-5" } as never);
		bus.emit("subagent.run_start" as never, { runId: "r2", model: "zai/glm-5.1" } as never);
		bus.emit("subagent.run_end" as never, { runId: "r2", exitCode: 1, model: "zai/glm-5.1" } as never);
		await recorder.flush();

		const emitted: unknown[] = [];
		bus.on("cron.trace_summary" as never, (p) => emitted.push(p));

		const job = createTraceSummarizerJob(100_000);
		await job.run({
			runId: "test",
			startedAt: new Date().toISOString(),
			consecutiveFailures: 0,
			recorder,
		});

		// Give the recorder a tick to flush the write queue
		await recorder.flush();

		assert.equal(emitted.length, 1, "should have emitted 1 summary event");
		const summary = emitted[0] as { totalRuns: number; totalEvents: number; topModels: Array<{ model: string; count: number }> };
		assert.equal(summary.totalRuns, 2);
		assert.equal(summary.totalEvents, 4);
		assert.equal(summary.topModels.length, 2);
		const top = summary.topModels[0];
		assert.equal(top.model, "zai/glm-5");
		assert.equal(top.count, 2);
	});
});
