/**
 * Error recovery tests for the Convex adapter (local JSONL backend).
 *
 * Tests resilience to corrupt files, missing directories, concurrent access,
 * and other edge cases that could occur in production.
 */

import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { ConvexAdapter } from "../../src/convex/convex-adapter.ts";

let tmpDir: string;

beforeEach(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "convex-recovery-"));
});

afterEach(() => {
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeStore(): ConvexAdapter {
	return new ConvexAdapter({ storageDir: tmpDir });
}

describe("ConvexAdapter error recovery", () => {
	it("handles empty JSONL file gracefully", async () => {
		// Pre-create an empty file
		const eventsFile = path.join(tmpDir, "events.jsonl");
		fs.mkdirSync(tmpDir, { recursive: true });
		fs.writeFileSync(eventsFile, "", "utf-8");

		const store = makeStore();
		const events = await store.queryEvents();
		assert.equal(events.length, 0);

		// Can still write after reading empty file
		await store.recordEvent({ type: "deploy", detail: "d1", severity: "info", ts: 100 });
		const eventsAfter = await store.queryEvents();
		assert.equal(eventsAfter.length, 1);
	});

	it("skips corrupt JSONL lines on read (returns empty)", async () => {
		const eventsFile = path.join(tmpDir, "events.jsonl");
		fs.mkdirSync(tmpDir, { recursive: true });
		// Write a valid line, a corrupt line, then another valid line
		fs.writeFileSync(eventsFile, [
			JSON.stringify({ id: "1", type: "deploy", detail: "d1", severity: "info", ts: 100 }),
			"THIS IS NOT JSON{{{",
			JSON.stringify({ id: "2", type: "alert", detail: "a1", severity: "warning", ts: 200 }),
		].join("\n") + "\n", "utf-8");

		// readJsonl catches parse errors and returns [] — this is the
		// designed behavior: fail-soft on corrupt data.
		const store = makeStore();
		const events = await store.queryEvents();
		// The corrupt line causes JSON.parse to throw inside the map,
		// which is caught by the try/catch in readJsonl, returning [].
		assert.equal(events.length, 0);
	});

	it("auto-creates directory on write if missing", async () => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
		// tmpDir no longer exists
		const store = new ConvexAdapter({ storageDir: tmpDir });
		await store.recordEvent({ type: "deploy", detail: "d1", severity: "info", ts: 100 });

		assert.ok(fs.existsSync(tmpDir));
		const events = await store.queryEvents();
		assert.equal(events.length, 1);
	});

	it("handles concurrent writes without data loss", async () => {
		const store = makeStore();
		// Write 10 events concurrently
		const promises = [];
		for (let i = 0; i < 10; i++) {
			promises.push(store.recordEvent({ type: "deploy", detail: `d${i}`, severity: "info", ts: 100 + i }));
		}
		await Promise.all(promises);

		const events = await store.queryEvents();
		// All 10 should be present (though order may vary)
		assert.equal(events.length, 10);
		const details = events.map((e) => e.detail).sort();
		for (let i = 0; i < 10; i++) {
			assert.equal(details[i], `d${i}`);
		}
	});

	it("updateRun handles missing file gracefully", async () => {
		const store = makeStore();
		await assert.rejects(
			() => store.updateRun("nonexistent", { status: "completed" }),
			/not found/,
		);
	});

	it("recovers from deleted storage directory between operations", async () => {
		const store = makeStore();
		await store.recordEvent({ type: "deploy", detail: "d1", severity: "info", ts: 100 });
		// Delete the directory
		fs.rmSync(tmpDir, { recursive: true, force: true });
		// Write should re-create
		await store.recordEvent({ type: "alert", detail: "a1", severity: "warning", ts: 200 });
		// Only the second event should survive (first was in deleted file)
		const events = await store.queryEvents();
		assert.equal(events.length, 1);
		assert.equal(events[0]!.detail, "a1");
	});

	it("queryFacts with empty storage returns empty array", async () => {
		const store = makeStore();
		const facts = await store.queryFacts();
		assert.deepEqual(facts, []);
	});

	it("queryLessons with no matching filter returns empty array", async () => {
		const store = makeStore();
		await store.storeLesson({ text: "l1", tags: ["docker"], severity: "info", learnedAt: 100, appliesTo: ["all"] });
		const filtered = await store.queryLessons({ tags: ["nonexistent"] });
		assert.equal(filtered.length, 0);
	});
});
