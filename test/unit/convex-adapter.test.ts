/**
 * Unit tests for the Convex adapter with local JSONL storage.
 *
 * Tests exercise all 5 tables (events, lessons, memories, facts, runs)
 * using the local JSONL backend — no Convex deployment needed.
 */

import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { ConvexAdapter } from "../../src/convex/convex-adapter.ts";
import type { ConvexEvent, ConvexLesson, ConvexMemory, ConvexFact, ConvexRun } from "../../src/convex/convex-types.ts";

let tmpDir: string;

beforeEach(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "convex-test-"));
});

afterEach(() => {
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeStore(): ConvexAdapter {
	return new ConvexAdapter({ storageDir: tmpDir });
}

// ── Constructor validation ──────────────────────────────────────────────────

describe("ConvexAdapter constructor", () => {
	it("throws if neither convexUrl nor storageDir is provided", () => {
		assert.throws(
			() => new ConvexAdapter({}),
			/requires either convexUrl or storageDir/,
		);
	});

	it("accepts storageDir", () => {
		const store = new ConvexAdapter({ storageDir: tmpDir });
		assert.ok(store);
	});
});

// ── Events ──────────────────────────────────────────────────────────────────

describe("ConvexAdapter events", () => {
	it("records and queries an event", async () => {
		const store = makeStore();
		const id = await store.recordEvent({
			type: "deploy",
			project: "pi-harness",
			agent: "ceo",
			detail: "Deployed v2",
			severity: "info",
			ts: Date.now(),
		});
		assert.ok(id);

		const events = await store.queryEvents();
		assert.equal(events.length, 1);
		assert.equal(events[0]!.type, "deploy");
		assert.equal(events[0]!.project, "pi-harness");
		assert.equal(events[0]!.id, id);
	});

	it("filters events by type", async () => {
		const store = makeStore();
		await store.recordEvent({ type: "deploy", detail: "d1", severity: "info", ts: 100 });
		await store.recordEvent({ type: "alert", detail: "a1", severity: "warning", ts: 200 });

		const deploys = await store.queryEvents({ type: "deploy" });
		assert.equal(deploys.length, 1);
		assert.equal(deploys[0]!.type, "deploy");
	});

	it("filters events by severity", async () => {
		const store = makeStore();
		await store.recordEvent({ type: "incident", detail: "i1", severity: "critical", ts: 100 });
		await store.recordEvent({ type: "ship", detail: "s1", severity: "info", ts: 200 });

		const critical = await store.queryEvents({ severity: "critical" });
		assert.equal(critical.length, 1);
		assert.equal(critical[0]!.severity, "critical");
	});

	it("filters events by time range", async () => {
		const store = makeStore();
		await store.recordEvent({ type: "deploy", detail: "d1", severity: "info", ts: 100 });
		await store.recordEvent({ type: "deploy", detail: "d2", severity: "info", ts: 200 });
		await store.recordEvent({ type: "deploy", detail: "d3", severity: "info", ts: 300 });

		const filtered = await store.queryEvents({ since: 150, until: 250 });
		assert.equal(filtered.length, 1);
		assert.equal(filtered[0]!.detail, "d2");
	});

	it("limits results", async () => {
		const store = makeStore();
		for (let i = 0; i < 10; i++) {
			await store.recordEvent({ type: "alert", detail: `a${i}`, severity: "info", ts: 100 + i });
		}
		const limited = await store.queryEvents({ limit: 3 });
		assert.equal(limited.length, 3);
	});

	it("sorts events by ts descending (newest first)", async () => {
		const store = makeStore();
		await store.recordEvent({ type: "deploy", detail: "old", severity: "info", ts: 100 });
		await store.recordEvent({ type: "deploy", detail: "new", severity: "info", ts: 999 });

		const events = await store.queryEvents();
		assert.equal(events[0]!.detail, "new");
		assert.equal(events[1]!.detail, "old");
	});
});

// ── Lessons ─────────────────────────────────────────────────────────────────

describe("ConvexAdapter lessons", () => {
	it("stores and queries a lesson", async () => {
		const store = makeStore();
		const id = await store.storeLesson({
			text: "Never deploy on Friday",
			tags: ["deploy", "process"],
			severity: "warning",
			learnedAt: Date.now(),
			appliesTo: ["all"],
		});
		assert.ok(id);

		const lessons = await store.queryLessons();
		assert.equal(lessons.length, 1);
		assert.equal(lessons[0]!.text, "Never deploy on Friday");
	});

	it("filters by tags (all must match)", async () => {
		const store = makeStore();
		await store.storeLesson({ text: "l1", tags: ["deploy", "docker"], severity: "info", learnedAt: 100, appliesTo: ["all"] });
		await store.storeLesson({ text: "l2", tags: ["deploy"], severity: "info", learnedAt: 200, appliesTo: ["all"] });

		const filtered = await store.queryLessons({ tags: ["deploy", "docker"] });
		assert.equal(filtered.length, 1);
		assert.equal(filtered[0]!.text, "l1");
	});

	it("filters by context", async () => {
		const store = makeStore();
		await store.storeLesson({ text: "l1", tags: [], severity: "info", learnedAt: 100, appliesTo: ["all"], context: "docker" });
		await store.storeLesson({ text: "l2", tags: [], severity: "info", learnedAt: 200, appliesTo: ["all"], context: "react" });

		const docker = await store.queryLessons({ context: "docker" });
		assert.equal(docker.length, 1);
		assert.equal(docker[0]!.context, "docker");
	});
});

// ── Memories ────────────────────────────────────────────────────────────────

describe("ConvexAdapter memories", () => {
	it("stores and queries a memory", async () => {
		const store = makeStore();
		await store.storeMemory({
			agent: "ceo",
			project: "pi-harness",
			category: "preference",
			key: "model",
			value: "claude-4",
			confidence: 0.9,
			source: "session",
			createdAt: Date.now(),
			updatedAt: Date.now(),
			accessCount: 0,
		});

		const memories = await store.queryMemories();
		assert.equal(memories.length, 1);
		assert.equal(memories[0]!.key, "model");
		assert.equal(memories[0]!.value, "claude-4");
	});

	it("filters by agent and category", async () => {
		const store = makeStore();
		await store.storeMemory({ agent: "ceo", category: "preference", key: "k1", value: "v1", confidence: 0.9, source: "session", createdAt: 100, updatedAt: 100, accessCount: 0 });
		await store.storeMemory({ agent: "worker", category: "pattern", key: "k2", value: "v2", confidence: 0.8, source: "inferred", createdAt: 200, updatedAt: 200, accessCount: 0 });

		const ceoPrefs = await store.queryMemories({ agent: "ceo", category: "preference" });
		assert.equal(ceoPrefs.length, 1);
		assert.equal(ceoPrefs[0]!.agent, "ceo");
	});

	it("filters by keyPrefix", async () => {
		const store = makeStore();
		await store.storeMemory({ agent: "a", category: "preference", key: "deploy.strategy", value: "blue-green", confidence: 0.9, source: "human", createdAt: 100, updatedAt: 100, accessCount: 0 });
		await store.storeMemory({ agent: "a", category: "preference", key: "model.preferred", value: "claude-4", confidence: 0.9, source: "human", createdAt: 100, updatedAt: 100, accessCount: 0 });

		const deployMemories = await store.queryMemories({ keyPrefix: "deploy" });
		assert.equal(deployMemories.length, 1);
		assert.equal(deployMemories[0]!.key, "deploy.strategy");
	});

	it("filters by minConfidence", async () => {
		const store = makeStore();
		await store.storeMemory({ agent: "a", category: "preference", key: "k1", value: "v1", confidence: 0.5, source: "inferred", createdAt: 100, updatedAt: 100, accessCount: 0 });
		await store.storeMemory({ agent: "a", category: "preference", key: "k2", value: "v2", confidence: 0.9, source: "human", createdAt: 200, updatedAt: 200, accessCount: 0 });

		const high = await store.queryMemories({ minConfidence: 0.8 });
		assert.equal(high.length, 1);
		assert.equal(high[0]!.confidence, 0.9);
	});
});

// ── Facts ───────────────────────────────────────────────────────────────────

describe("ConvexAdapter facts", () => {
	it("stores and queries a fact", async () => {
		const store = makeStore();
		await store.storeFact({
			key: "stack.language",
			value: "TypeScript",
			source: "grounded-audit",
			checkedAt: Date.now(),
		});

		const facts = await store.queryFacts();
		assert.equal(facts.length, 1);
		assert.equal(facts[0]!.key, "stack.language");
		assert.equal(facts[0]!.value, "TypeScript");
	});

	it("filters by key", async () => {
		const store = makeStore();
		await store.storeFact({ key: "stack.language", value: "TypeScript", source: "manual", checkedAt: 100 });
		await store.storeFact({ key: "deploy.url", value: "https://example.com", source: "manual", checkedAt: 200 });

		const lang = await store.queryFacts({ key: "stack.language" });
		assert.equal(lang.length, 1);
		assert.equal(lang[0]!.value, "TypeScript");
	});
});

// ── Runs ────────────────────────────────────────────────────────────────────

describe("ConvexAdapter runs", () => {
	it("records and queries a run", async () => {
		const store = makeStore();
		await store.recordRun({
			runId: "r1",
			trigger: "manual",
			project: "pi-harness",
			status: "running",
			startedAt: Date.now(),
		});

		const runs = await store.queryRuns();
		assert.equal(runs.length, 1);
		assert.equal(runs[0]!.runId, "r1");
		assert.equal(runs[0]!.status, "running");
	});

	it("updates a run", async () => {
		const store = makeStore();
		await store.recordRun({ runId: "r1", trigger: "cron", status: "running", startedAt: 100 });

		await store.updateRun("r1", { status: "completed", completedAt: 200, successCount: 5 });

		const runs = await store.queryRuns({ runId: "r1" });
		assert.equal(runs.length, 1);
		assert.equal(runs[0]!.status, "completed");
		assert.equal(runs[0]!.completedAt, 200);
		assert.equal(runs[0]!.successCount, 5);
	});

	it("throws when updating non-existent run", async () => {
		const store = makeStore();
		await assert.rejects(
			() => store.updateRun("nonexistent", { status: "completed" }),
			/not found/,
		);
	});

	it("filters by status and trigger", async () => {
		const store = makeStore();
		await store.recordRun({ runId: "r1", trigger: "manual", status: "completed", startedAt: 100 });
		await store.recordRun({ runId: "r2", trigger: "cron", status: "running", startedAt: 200 });
		await store.recordRun({ runId: "r3", trigger: "cron", status: "completed", startedAt: 300 });

		const cronCompleted = await store.queryRuns({ trigger: "cron", status: "completed" });
		assert.equal(cronCompleted.length, 1);
		assert.equal(cronCompleted[0]!.runId, "r3");
	});

	it("sorts runs by startedAt descending", async () => {
		const store = makeStore();
		await store.recordRun({ runId: "r1", trigger: "manual", status: "completed", startedAt: 100 });
		await store.recordRun({ runId: "r2", trigger: "manual", status: "completed", startedAt: 999 });

		const runs = await store.queryRuns();
		assert.equal(runs[0]!.runId, "r2");
		assert.equal(runs[1]!.runId, "r1");
	});
});

// ── Cross-table / persistence ───────────────────────────────────────────────

describe("ConvexAdapter persistence", () => {
	it("persists data across adapter instances", async () => {
		const store1 = makeStore();
		await store1.recordEvent({ type: "ship", detail: "v1", severity: "info", ts: 100 });

		// Create a new adapter pointing to the same dir.
		const store2 = new ConvexAdapter({ storageDir: tmpDir });
		const events = await store2.queryEvents();
		assert.equal(events.length, 1);
		assert.equal(events[0]!.detail, "v1");
	});

	it("tables are independent", async () => {
		const store = makeStore();
		await store.recordEvent({ type: "alert", detail: "e1", severity: "info", ts: 100 });
		await store.storeLesson({ text: "l1", tags: [], severity: "info", learnedAt: 100, appliesTo: ["all"] });
		await store.storeFact({ key: "k1", value: "v1", source: "manual", checkedAt: 100 });

		assert.equal((await store.queryEvents()).length, 1);
		assert.equal((await store.queryLessons()).length, 1);
		assert.equal((await store.queryFacts()).length, 1);
	});
});
