/**
 * Convex adapter — typed persistence layer for pi-harness.
 *
 * Two backends:
 *   1. **Convex** — if `convexUrl` is provided, reads/writes go to Convex
 *      via HTTP API. Requires no runtime `convex` package import.
 *   2. **Local JSONL** — if `storageDir` is provided (or no convexUrl),
 *      reads/writes go to per-table .jsonl files. Ideal for testing, CI,
 *      and offline work.
 *
 * Usage:
 * ```ts
 * const store = new ConvexAdapter({ storageDir: "/tmp/pi-harness-store" });
 * await store.recordEvent({ type: "deploy", detail: "shipped v2", ... });
 * const events = await store.queryEvents({ type: "deploy" });
 * ```
 *
 * The Convex HTTP API path is intentionally minimal — just enough to
 * persist and query the 5 tables pi-harness needs. A full Convex backend
 * with mutations/queries is a separate deployment concern.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import {
	type ConvexEvent,
	type ConvexFact,
	type ConvexLesson,
	type ConvexMemory,
	type ConvexRun,
	type EventFilter,
	type FactFilter,
	type LessonFilter,
	type MemoryFilter,
	type RunFilter,
} from "./convex-types.ts";

// ── JSONL storage backend ───────────────────────────────────────────────────

function ensureDir(dir: string): void {
	fs.mkdirSync(dir, { recursive: true });
}

function readJsonl<T>(filePath: string): T[] {
	try {
		const data = fs.readFileSync(filePath, "utf-8");
		return data.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as T);
	} catch {
		return [];
	}
}

function appendJsonl<T>(filePath: string, record: T): void {
	ensureDir(path.dirname(filePath));
	fs.appendFileSync(filePath, JSON.stringify(record) + "\n", "utf-8");
}

function writeJsonl<T>(filePath: string, records: T[]): void {
	ensureDir(path.dirname(filePath));
	fs.writeFileSync(filePath, records.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf-8");
}

/**
 * Generic filter matcher. Handles:
 *   - Direct field equality (key → record.key)
 *   - `since`/`until` → mapped to `tsField` parameter
 *   - `minConfidence` → record.confidence
 *   - `keyPrefix` → record.key startsWith
 *   - `tags` → all filter tags present in record.tags
 *   - `appliesTo` → record.appliesTo includes value or ["all"]
 */
function matchesFilter<T>(
	record: T,
	filter: Record<string, unknown>,
	tsField = "ts",
): boolean {
	for (const [key, value] of Object.entries(filter)) {
		if (value === undefined || value === null) continue;
		if (key === "limit") continue;

		const rec = record as Record<string, unknown>;

		if (key === "since") {
			const ts = rec[tsField];
			if (typeof ts === "number" && typeof value === "number" && ts < value) return false;
			continue;
		}
		if (key === "until") {
			const ts = rec[tsField];
			if (typeof ts === "number" && typeof value === "number" && ts > value) return false;
			continue;
		}
		if (key === "minConfidence") {
			if (typeof rec.confidence === "number" && typeof value === "number" && rec.confidence < value) return false;
			continue;
		}
		if (key === "keyPrefix") {
			if (typeof rec.key === "string" && typeof value === "string" && !rec.key.startsWith(value)) return false;
			continue;
		}
		if (key === "tags") {
			if (Array.isArray(rec.tags) && Array.isArray(value)) {
				if (!(value as unknown[]).every((tag) => (rec.tags as unknown[]).includes(tag))) return false;
			}
			continue;
		}
		if (key === "appliesTo") {
			const arr = rec.appliesTo;
			if (Array.isArray(arr)) {
				if (!(arr as string[]).includes(value as string) && !(arr as string[]).includes("all")) return false;
			}
			continue;
		}

		// Direct field equality
		if (rec[key] !== value) return false;
	}
	return true;
}

// ── Convex HTTP client (minimal) ────────────────────────────────────────────

interface ConvexHttpOptions {
	convexUrl: string;
}

async function convexQuery<T>(
	convexUrl: string,
	functionName: string,
	args: Record<string, unknown>,
): Promise<T> {
	const url = `${convexUrl}/api/query`;
	const resp = await fetch(url, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ path: functionName, args }),
	});
	if (!resp.ok) {
		throw new Error(`Convex query ${functionName} failed: HTTP ${resp.status}`);
	}
	const data = await resp.json() as { value?: T };
	return data.value as T;
}

async function convexMutation<T>(
	convexUrl: string,
	functionName: string,
	args: Record<string, unknown>,
): Promise<T> {
	const url = `${convexUrl}/api/mutation`;
	const resp = await fetch(url, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ path: functionName, args }),
	});
	if (!resp.ok) {
		throw new Error(`Convex mutation ${functionName} failed: HTTP ${resp.status}`);
	}
	const data = await resp.json() as { value?: T };
	return data.value as T;
}

// ── Adapter ─────────────────────────────────────────────────────────────────

export interface ConvexAdapterOptions {
	/** Convex deployment URL (e.g. https://happy-abc.convex.cloud). If set, uses Convex backend. */
	convexUrl?: string;
	/** Local directory for JSONL storage. Required if no convexUrl. */
	storageDir?: string;
}

export class ConvexAdapter {
	private readonly convexUrl: string | undefined;
	private readonly storageDir: string | undefined;
	private readonly useConvex: boolean;

	constructor(options: ConvexAdapterOptions) {
		this.convexUrl = options.convexUrl?.replace(/\/+$/, "");
		this.storageDir = options.storageDir;
		this.useConvex = !!this.convexUrl;
		if (!this.useConvex && !this.storageDir) {
			throw new Error("ConvexAdapter requires either convexUrl or storageDir");
		}
	}

	// ── Helpers ──────────────────────────────────────────────────────────

	private filePath(table: string): string {
		return path.join(this.storageDir!, `${table}.jsonl`);
	}

	private readTable<T>(table: string): T[] {
		return readJsonl<T>(this.filePath(table));
	}

	private appendTable<T>(table: string, record: T): void {
		appendJsonl(this.filePath(table), record);
	}

	private writeTable<T>(table: string, records: T[]): void {
		writeJsonl(this.filePath(table), records);
	}

	// ── Events ───────────────────────────────────────────────────────────

	async recordEvent(event: Omit<ConvexEvent, "id">): Promise<string> {
		const id = crypto.randomUUID();
		const record: ConvexEvent = { ...event, id };
		if (this.useConvex) {
			await convexMutation(this.convexUrl!, "events:create", { ...record });
		} else {
			this.appendTable("events", record);
		}
		return id;
	}

	async queryEvents(filter?: EventFilter): Promise<ConvexEvent[]> {
		if (this.useConvex) {
			return convexQuery<ConvexEvent[]>(this.convexUrl!, "events:list", filter ?? {});
		}
		let records = this.readTable<ConvexEvent>("events");
		if (filter) {
			const f: Record<string, unknown> = {};
			if (filter.type) f.type = filter.type;
			if (filter.project) f.project = filter.project;
			if (filter.severity) f.severity = filter.severity;
			if (filter.since) f.since = filter.since;
			if (filter.until) f.until = filter.until;
			records = records.filter((r) => matchesFilter(r, f, "ts"));
		}
		records.sort((a, b) => b.ts - a.ts);
		if (filter?.limit) records = records.slice(0, filter.limit);
		return records;
	}

	// ── Lessons ──────────────────────────────────────────────────────────

	async storeLesson(lesson: Omit<ConvexLesson, "id">): Promise<string> {
		const id = crypto.randomUUID();
		const record: ConvexLesson = { ...lesson, id };
		if (this.useConvex) {
			await convexMutation(this.convexUrl!, "lessons:create", { ...record });
		} else {
			this.appendTable("lessons", record);
		}
		return id;
	}

	async queryLessons(filter?: LessonFilter): Promise<ConvexLesson[]> {
		if (this.useConvex) {
			return convexQuery<ConvexLesson[]>(this.convexUrl!, "lessons:list", filter ?? {});
		}
		let records = this.readTable<ConvexLesson>("lessons");
		if (filter) {
			const f: Record<string, unknown> = {};
			if (filter.severity) f.severity = filter.severity;
			if (filter.context) f.context = filter.context;
			if (filter.since) f.since = filter.since;
			if (filter.tags) f.tags = filter.tags;
			if (filter.appliesTo) f.appliesTo = filter.appliesTo;
			records = records.filter((r) => matchesFilter(r, f, "learnedAt"));
		}
		records.sort((a, b) => b.learnedAt - a.learnedAt);
		if (filter?.limit) records = records.slice(0, filter.limit);
		return records;
	}

	// ── Memories ─────────────────────────────────────────────────────────

	async storeMemory(memory: Omit<ConvexMemory, "id">): Promise<string> {
		const id = crypto.randomUUID();
		const record: ConvexMemory = { ...memory, id };
		if (this.useConvex) {
			await convexMutation(this.convexUrl!, "memories:create", { ...record });
		} else {
			this.appendTable("memories", record);
		}
		return id;
	}

	async queryMemories(filter?: MemoryFilter): Promise<ConvexMemory[]> {
		if (this.useConvex) {
			return convexQuery<ConvexMemory[]>(this.convexUrl!, "memories:list", filter ?? {});
		}
		let records = this.readTable<ConvexMemory>("memories");
		if (filter) {
			const f: Record<string, unknown> = {};
			if (filter.agent) f.agent = filter.agent;
			if (filter.project) f.project = filter.project;
			if (filter.category) f.category = filter.category;
			if (filter.keyPrefix) f.keyPrefix = filter.keyPrefix;
			if (filter.minConfidence) f.minConfidence = filter.minConfidence;
			records = records.filter((r) => matchesFilter(r, f, "updatedAt"));
		}
		records.sort((a, b) => b.updatedAt - a.updatedAt);
		if (filter?.limit) records = records.slice(0, filter.limit);
		return records;
	}

	// ── Facts ────────────────────────────────────────────────────────────

	async storeFact(fact: Omit<ConvexFact, "id">): Promise<string> {
		const id = crypto.randomUUID();
		const record: ConvexFact = { ...fact, id };
		if (this.useConvex) {
			await convexMutation(this.convexUrl!, "facts:create", { ...record });
		} else {
			this.appendTable("facts", record);
		}
		return id;
	}

	async queryFacts(filter?: FactFilter): Promise<ConvexFact[]> {
		if (this.useConvex) {
			return convexQuery<ConvexFact[]>(this.convexUrl!, "facts:list", filter ?? {});
		}
		let records = this.readTable<ConvexFact>("facts");
		if (filter) {
			const f: Record<string, unknown> = {};
			if (filter.key) f.key = filter.key;
			if (filter.project) f.project = filter.project;
			if (filter.since) f.since = filter.since;
			records = records.filter((r) => matchesFilter(r, f, "checkedAt"));
		}
		records.sort((a, b) => b.checkedAt - a.checkedAt);
		if (filter?.limit) records = records.slice(0, filter.limit);
		return records;
	}

	// ── Runs ─────────────────────────────────────────────────────────────

	async recordRun(run: Omit<ConvexRun, "id">): Promise<string> {
		const id = crypto.randomUUID();
		const record: ConvexRun = { ...run, id };
		if (this.useConvex) {
			await convexMutation(this.convexUrl!, "runs:create", { ...record });
		} else {
			this.appendTable("runs", record);
		}
		return id;
	}

	async updateRun(runId: string, patch: Partial<ConvexRun>): Promise<void> {
		if (this.useConvex) {
			await convexMutation(this.convexUrl!, "runs:update", { runId, ...patch });
			return;
		}
		const records = this.readTable<ConvexRun>("runs");
		const index = records.findIndex((r) => r.runId === runId);
		if (index === -1) throw new Error(`Run ${runId} not found`);
		records[index] = { ...records[index]!, ...patch };
		this.writeTable("runs", records);
	}

	async queryRuns(filter?: RunFilter): Promise<ConvexRun[]> {
		if (this.useConvex) {
			return convexQuery<ConvexRun[]>(this.convexUrl!, "runs:list", filter ?? {});
		}
		let records = this.readTable<ConvexRun>("runs");
		if (filter) {
			const f: Record<string, unknown> = {};
			if (filter.runId) f.runId = filter.runId;
			if (filter.project) f.project = filter.project;
			if (filter.status) f.status = filter.status;
			if (filter.trigger) f.trigger = filter.trigger;
			if (filter.since) f.since = filter.since;
			records = records.filter((r) => matchesFilter(r, f, "startedAt"));
		}
		records.sort((a, b) => b.startedAt - a.startedAt);
		if (filter?.limit) records = records.slice(0, filter.limit);
		return records;
	}

	// ── Lifecycle ────────────────────────────────────────────────────────

	/** Close the adapter. For local JSONL, this is a no-op. For Convex, it may flush. */
	async close(): Promise<void> {
		// JSONL is sync write-through; nothing to flush.
		// Convex HTTP is stateless; nothing to close.
	}
}
