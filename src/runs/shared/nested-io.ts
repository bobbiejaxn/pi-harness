/**
 * Nested event I/O — file read/write for control requests and results.
 * Extracted from nested-events.ts. No circular dependencies.
 */

import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type {
	NestedRoute,
	NestedEventRecord,
	NestedControlRequestRecord,
	NestedControlResultRecord,
} from "./nested-events.ts";

const MAX_EVENT_BYTES = 64 * 1024;

// ── Local helpers (duplicated from nested-events.ts to avoid circular imports) ──

function clampNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function stringValue(value: unknown, max = 512): string | undefined {
	return typeof value === "string" && value.length > 0 ? value.slice(0, max) : undefined;
}

function isSafeNestedId(value: unknown): value is string {
	return typeof value === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(value);
}

function assertSafeId(label: string, value: string): void {
	if (!/^[a-zA-Z0-9_-]{1,128}$/.test(value)) throw new Error(`Invalid nested ${label}: ${value}`);
}

function containedPath(base: string, candidate: string): boolean {
	const resolvedBase = path.resolve(base);
	const resolvedCandidate = path.resolve(candidate);
	return resolvedCandidate === resolvedBase || resolvedCandidate.startsWith(`${resolvedBase}${path.sep}`);
}

function validateRouteShape(route: NestedRoute): void {
	if (!route.rootRunId || !route.eventSink || !route.controlInbox) {
		throw new Error("Invalid nested route: missing required fields");
	}
}

// ── Write helpers ───────────────────────────────────────────────────────────

function writeRouteRecord(dir: string, ts: number, payload: object): string {
	const content = `${JSON.stringify(payload)}\n`;
	if (Buffer.byteLength(content, "utf-8") > MAX_EVENT_BYTES) throw new Error("Nested route record exceeds the maximum size.");
	fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
	const name = `${String(ts).padStart(13, "0")}-${randomUUID()}.json`;
	const tmp = path.join(dir, `.${name}.tmp`);
	const finalPath = path.join(dir, name);
	fs.writeFileSync(tmp, content, { mode: 0o600 });
	fs.renameSync(tmp, finalPath);
	return finalPath;
}

// ── Record parsing (local to this module) ───────────────────────────────────

function parseRecord(content: string, route: NestedRoute): NestedEventRecord | undefined {
	if (Buffer.byteLength(content, "utf-8") > MAX_EVENT_BYTES) return undefined;
	let parsed: unknown;
	try {
		parsed = JSON.parse(content);
	} catch {
		return undefined;
	}
	if (!parsed || typeof parsed !== "object") return undefined;
	const raw = parsed as Record<string, unknown>;
	if (raw.rootRunId !== route.rootRunId || raw.capabilityToken !== route.capabilityToken) return undefined;
	const ts = clampNumber(raw.ts);
	if (ts === undefined) return undefined;
	return {
		...raw,
		ts,
		rootRunId: route.rootRunId,
		capabilityToken: route.capabilityToken,
	} as NestedEventRecord;
}

function parseControlRequest(content: string, route: NestedRoute): NestedControlRequestRecord | undefined {
	if (Buffer.byteLength(content, "utf-8") > MAX_EVENT_BYTES) return undefined;
	let parsed: unknown;
	try {
		parsed = JSON.parse(content);
	} catch {
		return undefined;
	}
	if (!parsed || typeof parsed !== "object") return undefined;
	const raw = parsed as Record<string, unknown>;
	if (raw.type !== "subagent.nested.control-request") return undefined;
	if (raw.rootRunId !== route.rootRunId || raw.capabilityToken !== route.capabilityToken) return undefined;
	if (!isSafeNestedId(raw.requestId) || !isSafeNestedId(raw.targetRunId)) return undefined;
	if (raw.action !== "interrupt" && raw.action !== "resume") return undefined;
	const ts = clampNumber(raw.ts);
	if (ts === undefined) return undefined;
	return {
		type: "subagent.nested.control-request",
		ts,
		rootRunId: route.rootRunId,
		capabilityToken: route.capabilityToken,
		requestId: raw.requestId,
		targetRunId: raw.targetRunId,
		action: raw.action,
		...(stringValue(raw.message, 16_000) ? { message: stringValue(raw.message, 16_000) } : {}),
	};
}

function parseControlResult(content: string, route: NestedRoute): NestedControlResultRecord | undefined {
	if (Buffer.byteLength(content, "utf-8") > MAX_EVENT_BYTES) return undefined;
	let parsed: unknown;
	try {
		parsed = JSON.parse(content);
	} catch {
		return undefined;
	}
	if (!parsed || typeof parsed !== "object") return undefined;
	const raw = parsed as Record<string, unknown>;
	if (raw.type !== "subagent.nested.control-result") return undefined;
	if (raw.rootRunId !== route.rootRunId || raw.capabilityToken !== route.capabilityToken) return undefined;
	if (!isSafeNestedId(raw.requestId) || !isSafeNestedId(raw.targetRunId)) return undefined;
	const ts = clampNumber(raw.ts);
	if (ts === undefined || typeof raw.ok !== "boolean") return undefined;
	return {
		type: "subagent.nested.control-result",
		ts,
		rootRunId: route.rootRunId,
		capabilityToken: route.capabilityToken,
		requestId: raw.requestId,
		targetRunId: raw.targetRunId,
		ok: raw.ok,
		message: stringValue(raw.message, 16_000) ?? (raw.ok ? "Control request completed." : "Control request failed."),
	};
}

// ── Public API ──────────────────────────────────────────────────────────────

export function writeNestedEvent(route: NestedRoute, event: Omit<NestedEventRecord, "rootRunId" | "capabilityToken">): void {
	validateRouteShape(route);
	const record: NestedEventRecord = {
		...event,
		rootRunId: route.rootRunId,
		capabilityToken: route.capabilityToken,
	};
	const sanitized = parseRecord(JSON.stringify(record), route);
	if (!sanitized) throw new Error("Nested event record failed validation.");
	writeRouteRecord(route.eventSink, sanitized.ts, sanitized);
}

export function writeNestedControlRequest(route: NestedRoute, request: Omit<NestedControlRequestRecord, "type" | "rootRunId" | "capabilityToken">): string {
	validateRouteShape(route);
	assertSafeId("requestId", request.requestId);
	assertSafeId("targetRunId", request.targetRunId);
	const record: NestedControlRequestRecord = {
		type: "subagent.nested.control-request",
		...request,
		rootRunId: route.rootRunId,
		capabilityToken: route.capabilityToken,
	};
	const sanitized = parseControlRequest(JSON.stringify(record), route);
	if (!sanitized) throw new Error("Nested control request failed validation.");
	return writeRouteRecord(route.controlInbox, sanitized.ts, sanitized);
}

export function readNestedControlRequests(route: NestedRoute): Array<NestedControlRequestRecord & { filePath: string }> {
	validateRouteShape(route);
	let entries: string[] = [];
	try {
		entries = fs.readdirSync(route.controlInbox).filter((entry) => entry.endsWith(".json")).sort();
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	const requests: Array<NestedControlRequestRecord & { filePath: string }> = [];
	for (const entry of entries) {
		const filePath = path.join(route.controlInbox, entry);
		if (!containedPath(route.controlInbox, filePath)) continue;
		try {
			const stat = fs.statSync(filePath);
			if (!stat.isFile() || stat.size > MAX_EVENT_BYTES) continue;
			const request = parseControlRequest(fs.readFileSync(filePath, "utf-8"), route);
			if (request) requests.push({ ...request, filePath });
		} catch {
			continue;
		}
	}
	return requests;
}

export function writeNestedControlResult(route: NestedRoute, result: Omit<NestedControlResultRecord, "type" | "rootRunId" | "capabilityToken">): void {
	validateRouteShape(route);
	assertSafeId("requestId", result.requestId);
	assertSafeId("targetRunId", result.targetRunId);
	const record: NestedControlResultRecord = {
		type: "subagent.nested.control-result",
		...result,
		rootRunId: route.rootRunId,
		capabilityToken: route.capabilityToken,
	};
	const sanitized = parseControlResult(JSON.stringify(record), route);
	if (!sanitized) throw new Error("Nested control result failed validation.");
	writeRouteRecord(route.eventSink, sanitized.ts, sanitized);
}

export function readNestedControlResults(route: NestedRoute): NestedControlResultRecord[] {
	validateRouteShape(route);
	let entries: string[] = [];
	try {
		entries = fs.readdirSync(route.eventSink).filter((entry) => entry.endsWith(".json") || entry.endsWith(".jsonl")).sort();
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	const results: NestedControlResultRecord[] = [];
	for (const entry of entries) {
		const eventPath = path.join(route.eventSink, entry);
		if (!containedPath(route.eventSink, eventPath)) continue;
		try {
			const stat = fs.statSync(eventPath);
			if (!stat.isFile() || stat.size > MAX_EVENT_BYTES) continue;
			const content = fs.readFileSync(eventPath, "utf-8");
			const lines = content.includes("\n") ? content.split("\n").filter((line) => line.trim()) : [content];
			for (const line of lines) {
				const result = parseControlResult(line, route);
				if (result) results.push(result);
			}
		} catch {
			continue;
		}
	}
	return results;
}
