// Unit tests for the trace recorder.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { TraceRecorder } from "../../src/shared/trace-recorder.ts";
import {
	SUBAGENT_RUN_END_EVENT,
	SUBAGENT_RUN_START_EVENT,
} from "../../src/shared/subagent-events.ts";

interface FakeEventBus {
	handlers: Map<string, ((payload: unknown) => void)[]>;
	on: (event: string, handler: (payload: unknown) => void) => void;
	off: (event: string, handler: (payload: unknown) => void) => void;
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
		off(event, handler) {
			const list = bus.handlers.get(event) ?? [];
			bus.handlers.set(event, list.filter((h) => h !== handler));
		},
		emit(event, payload) {
			for (const h of bus.handlers.get(event) ?? []) h(payload);
		},
	};
	return bus;
}

let tmpDir: string;
let recorder: TraceRecorder;
let bus: FakeEventBus;

beforeEach(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "trace-recorder-test-"));
	bus = makeFakeBus();
	recorder = new TraceRecorder({ events: bus }, tmpDir);
});

afterEach(async () => {
	await recorder.flush();
	recorder.uninstall();
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("TraceRecorder", () => {
	it("creates the trace directory on install", () => {
		assert.equal(fs.existsSync(tmpDir), true);
		recorder.install();
		// install() is idempotent and ensures the dir exists.
		assert.equal(fs.existsSync(tmpDir), true);
	});

	it("writes events to per-trace JSONL files", async () => {
		recorder.install();

		bus.emit(SUBAGENT_RUN_START_EVENT, {
			runId: "test-1",
			mode: "single",
			agent: "worker",
			task: "Echo TEST",
			depth: 0,
			cwd: "/tmp",
			async: false,
		});
		bus.emit(SUBAGENT_RUN_END_EVENT, {
			runId: "test-1",
			mode: "single",
			agent: "worker",
			exitCode: 0,
			usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: 0.01 },
			durationMs: 1000,
			success: true,
		});

		await recorder.flush();

		const filePath = path.join(tmpDir, "test-1.jsonl");
		assert.equal(fs.existsSync(filePath), true, "trace file should exist");

		const lines = fs.readFileSync(filePath, "utf-8")
			.split("\n")
			.filter((l) => l.trim());
		assert.equal(lines.length, 2, "should have 2 events");

		const parsed = lines.map((l) => JSON.parse(l));
		assert.equal(parsed[0].type, SUBAGENT_RUN_START_EVENT);
		assert.equal(parsed[1].type, SUBAGENT_RUN_END_EVENT);
		assert.equal(parsed[0].payload.runId, "test-1");
	});

	it("uses traceRunId when present to bucket events", async () => {
		recorder.install();

		bus.emit(SUBAGENT_RUN_START_EVENT, {
			runId: "child-1",
			traceRunId: "parent-trace",
			mode: "single",
			agent: "worker",
			task: "do work",
			depth: 1,
			cwd: "/tmp",
			async: false,
		});

		await recorder.flush();
		const filePath = path.join(tmpDir, "parent-trace.jsonl");
		assert.equal(fs.existsSync(filePath), true);
	});

	it("serializes writes per file to prevent interleaving", async () => {
		recorder.install();

		// Fire 100 events rapidly. Each should be on its own line.
		for (let i = 0; i < 100; i++) {
			bus.emit(SUBAGENT_RUN_START_EVENT, { runId: "burst", seq: i });
		}
		await recorder.flush();

		const lines = recorder.read("burst");
		assert.equal(lines.length, 100, "should have 100 events");
		for (let i = 0; i < 100; i++) {
			assert.equal((lines[i].payload as { seq: number }).seq, i, `event ${i} should be in order`);
		}
	});

	it("read() returns parsed trace lines", async () => {
		recorder.install();
		bus.emit(SUBAGENT_RUN_START_EVENT, { runId: "r-read", mode: "single" });
		bus.emit(SUBAGENT_RUN_END_EVENT, { runId: "r-read", exitCode: 0 });
		await recorder.flush();

		const lines = recorder.read("r-read");
		assert.equal(lines.length, 2);
		assert.equal(lines[0].type, SUBAGENT_RUN_START_EVENT);
		assert.match(lines[0].ts, /^\d{4}-\d{2}-\d{2}T/);
	});

	it("listRuns() returns IDs of all trace files", async () => {
		recorder.install();
		bus.emit(SUBAGENT_RUN_START_EVENT, { runId: "run-a" });
		bus.emit(SUBAGENT_RUN_START_EVENT, { runId: "run-b" });
		bus.emit(SUBAGENT_RUN_START_EVENT, { runId: "run-c" });
		await recorder.flush();

		const runs = recorder.listRuns();
		assert.equal(runs.length, 3);
		assert.ok(runs.includes("run-a"));
		assert.ok(runs.includes("run-b"));
		assert.ok(runs.includes("run-c"));
	});

	it("cleanup() removes files older than retention", async () => {
		recorder.install();

		// Create a fresh trace
		bus.emit(SUBAGENT_RUN_START_EVENT, { runId: "fresh" });
		await recorder.flush();

		// Create an old trace by backdating its mtime
		bus.emit(SUBAGENT_RUN_START_EVENT, { runId: "stale" });
		await recorder.flush();
		const stalePath = path.join(tmpDir, "stale.jsonl");
		const oldMtime = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
		fs.utimesSync(stalePath, oldMtime, oldMtime);

		const deleted = recorder.cleanup(14);
		assert.equal(deleted, 1, "should delete exactly 1 stale file");
		assert.equal(fs.existsSync(stalePath), false);
		assert.equal(fs.existsSync(path.join(tmpDir, "fresh.jsonl")), true);
	});

	it("sanitizes runId in the file path to prevent traversal", async () => {
		recorder.install();
		bus.emit(SUBAGENT_RUN_START_EVENT, { runId: "../../etc/passwd" });
		await recorder.flush();

		// Dots and slashes are both replaced with underscores by the sanitizer,
		// so "../../etc/passwd" becomes "______etc_passwd" (6 underscores + etc + _ + passwd).
		const expectedFile = path.join(tmpDir, "______etc_passwd.jsonl");
		assert.equal(fs.existsSync(expectedFile), true, "sanitized file should exist in trace dir");
		// Verify no file was written outside traceDir
		assert.equal(fs.existsSync(path.join(tmpDir, "..", "passwd.jsonl")), false);
	});

	it("uninstall() removes handlers so events are not received", async () => {
		recorder.install();
		recorder.uninstall();

		bus.emit(SUBAGENT_RUN_START_EVENT, { runId: "after-uninstall" });
		await recorder.flush();

		const lines = recorder.read("after-uninstall");
		assert.equal(lines.length, 0, "should not record events after uninstall");
	});

	it("is idempotent on install/uninstall", () => {
		recorder.install();
		recorder.install(); // no-op
		recorder.uninstall();
		recorder.uninstall(); // no-op
		// No error thrown = success
	});
});
