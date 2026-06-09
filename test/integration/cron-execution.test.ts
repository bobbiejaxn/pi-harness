/**
 * Integration test for the Cron scheduler.
 *
 * Tests actual timer-based execution, DLQ persistence, and clean shutdown.
 * Uses real file I/O (tmpdir) — no mocks.
 */

import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { Cron } from "../../src/cron/cron.ts";
import type { CronJob, CronContext } from "../../src/cron/cron.ts";

let tmpDir: string;
let dlqDir: string;

beforeEach(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cron-integration-"));
	dlqDir = path.join(tmpDir, "dlq");
});

afterEach(() => {
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeCron() {
	return new Cron({
		recorder: { emit: () => {}, handleEvent: () => {}, install: () => {}, uninstall: () => {} } as any,
		dlqDir,
		log: (_level: string, _msg: string) => {},
	});
}

describe("Cron integration", () => {
	it("runs a job on interval and tracks status", async () => {
		const cron = makeCron();
		let runCount = 0;
		cron.register({
			name: "counter",
			intervalMs: 100,
			run: async () => { runCount++; },
		});
		cron.start();
		await new Promise((r) => setTimeout(r, 350));
		await cron.stop();

		assert.ok(runCount >= 2, `Expected >=2 runs, got ${runCount}`);
		const jobs = cron.status();
		assert.equal(jobs.length, 1);
	});

	it("writes failed jobs to DLQ", async () => {
		const cron = makeCron();
		cron.register({
			name: "failing",
			intervalMs: 100_000,
			run: async () => { throw new Error("boom"); },
		});
		await assert.rejects(
			() => cron.runOnce("failing"),
			(err) => {
				assert.ok(err instanceof Error);
				assert.equal(err.message, "boom");
				return true;
			},
		);

		const dlqFiles = fs.readdirSync(dlqDir);
		assert.equal(dlqFiles.length, 1);
		assert.ok(dlqFiles[0]!.includes("failing"));

		const lines = fs.readFileSync(path.join(dlqDir, dlqFiles[0]!), "utf-8").trim().split("\n");
		assert.equal(lines.length, 1);
		const entry = JSON.parse(lines[0]!);
		assert.equal(entry.job, "failing");
		assert.equal(entry.error, "boom");
	});

	it("recovers after failure — next run succeeds", async () => {
		const cron = makeCron();
		let callCount = 0;
		cron.register({
			name: "flaky",
			intervalMs: 100_000,
			run: async () => {
				callCount++;
				if (callCount === 1) throw new Error("first fails");
			},
		});

		// First run fails
		await assert.rejects(
			() => cron.runOnce("flaky"),
			{ message: "first fails" },
		);
		// Second run succeeds
		await cron.runOnce("flaky");

		const jobs = cron.status();
		const job = jobs.find((j) => j.name === "flaky")!;
		assert.equal(job.consecutiveFailures, 0);
		assert.equal(callCount, 2);
	});

	it("stops cleanly after start", async () => {
		const cron = makeCron();
		cron.register({ name: "noop", intervalMs: 100_000, run: async () => {} });
		cron.start();
		await cron.stop();
		// Double stop is idempotent
		await cron.stop();
	});

	it("stops gracefully when a job is mid-run", async () => {
		const cron = makeCron();
		let started = false;
		let resolved = false;
		cron.register({
			name: "slow",
			intervalMs: 100_000,
			runOnStart: true,
			run: async () => {
				started = true;
				await new Promise((r) => setTimeout(r, 200));
				resolved = true;
			},
		});
		cron.start();
		// Give the job time to start
		await new Promise((r) => setTimeout(r, 50));
		assert.ok(started, "Job should have started");
		// Stop should wait for the job to finish
		await cron.stop();
		assert.ok(resolved, "Job should have completed before stop returned");
	});
});
