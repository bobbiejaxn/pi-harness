/**
 * Nested event sanitization and record parsing.
 * Extracted from nested-events.ts. Pure functions — no file system.
 */

import type { NestedRunSummary, NestedRunState, NestedStepSummary } from "../../shared/types.ts";
import type { NestedRoute, NestedEventRecord } from "./nested-events.ts";
import { sanitizeNestedPath, isSafeNestedPathId } from "./nested-path.ts";

const MAX_EVENT_BYTES = 64 * 1024;
const MAX_STEPS = 12;
const MAX_CHILDREN = 16;
const MAX_DEPTH = 3;

// ── Helpers ─────────────────────────────────────────────────────────────────

function clampNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function stringValue(value: unknown, max = 512): string | undefined {
	return typeof value === "string" && value.length > 0 ? value.slice(0, max) : undefined;
}

function isSafeNestedId(value: unknown): value is string {
	return typeof value === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(value);
}

// ── Sanitization ────────────────────────────────────────────────────────────

function sanitizeTokenUsage(value: unknown): NestedRunSummary["totalTokens"] | undefined {
	if (!value || typeof value !== "object") return undefined;
	const raw = value as Record<string, unknown>;
	const input = clampNumber(raw.input);
	const output = clampNumber(raw.output);
	const total = clampNumber(raw.total);
	return input !== undefined && output !== undefined && total !== undefined
		? { input, output, total }
		: undefined;
}

function sanitizeState(value: unknown, fallback: NestedRunState): NestedRunState {
	return value === "queued" || value === "running" || value === "complete" || value === "failed" || value === "paused"
		? value
		: fallback;
}

function sanitizeStep(input: unknown, depth: number): NestedStepSummary | undefined {
	if (!input || typeof input !== "object") return undefined;
	const raw = input as Record<string, unknown>;
	const agent = stringValue(raw.agent, 128);
	if (!agent) return undefined;
	const status = raw.status === "pending" || raw.status === "running" || raw.status === "complete" || raw.status === "completed" || raw.status === "failed" || raw.status === "paused"
		? raw.status
		: "pending";
	return {
		agent,
		status,
		...(stringValue(raw.sessionFile, 2048) ? { sessionFile: stringValue(raw.sessionFile, 2048) } : {}),
		...(raw.activityState === "active_long_running" || raw.activityState === "needs_attention" ? { activityState: raw.activityState } : {}),
		...(clampNumber(raw.lastActivityAt) !== undefined ? { lastActivityAt: clampNumber(raw.lastActivityAt) } : {}),
		...(stringValue(raw.currentTool, 128) ? { currentTool: stringValue(raw.currentTool, 128) } : {}),
		...(clampNumber(raw.currentToolStartedAt) !== undefined ? { currentToolStartedAt: clampNumber(raw.currentToolStartedAt) } : {}),
		...(stringValue(raw.currentPath, 2048) ? { currentPath: stringValue(raw.currentPath, 2048) } : {}),
		...(clampNumber(raw.turnCount) !== undefined ? { turnCount: clampNumber(raw.turnCount) } : {}),
		...(clampNumber(raw.toolCount) !== undefined ? { toolCount: clampNumber(raw.toolCount) } : {}),
		...(clampNumber(raw.startedAt) !== undefined ? { startedAt: clampNumber(raw.startedAt) } : {}),
		...(clampNumber(raw.endedAt) !== undefined ? { endedAt: clampNumber(raw.endedAt) } : {}),
		...(stringValue(raw.error, 1024) ? { error: stringValue(raw.error, 1024) } : {}),
		...(depth < MAX_DEPTH && Array.isArray(raw.children) ? { children: raw.children.map((child: unknown) => sanitizeSummary(child, depth + 1)).filter((child): child is NestedRunSummary => Boolean(child)).slice(0, MAX_CHILDREN) } : {}),
	};
}

export function sanitizeSummary(input: unknown, depth = 0): NestedRunSummary | undefined {
	if (!input || typeof input !== "object") return undefined;
	const raw = input as Record<string, unknown>;
	if (!isSafeNestedId(raw.id) || !isSafeNestedId(raw.parentRunId)) return undefined;
	const pathParts = sanitizeNestedPath(raw.path);
	const steps = Array.isArray(raw.steps)
		? raw.steps.map((step: unknown) => sanitizeStep(step, depth + 1)).filter((step): step is NestedStepSummary => Boolean(step)).slice(0, MAX_STEPS)
		: undefined;
	const totalTokens = sanitizeTokenUsage(raw.totalTokens);
	return {
		id: raw.id,
		parentRunId: raw.parentRunId,
		...(clampNumber(raw.parentStepIndex) !== undefined ? { parentStepIndex: clampNumber(raw.parentStepIndex) } : {}),
		...(stringValue(raw.parentAgent, 128) ? { parentAgent: stringValue(raw.parentAgent, 128) } : {}),
		depth: Math.min(Math.max(0, clampNumber(raw.depth) ?? 0), MAX_DEPTH),
		path: pathParts,
		state: sanitizeState(raw.state, "running"),
		...(stringValue(raw.asyncDir, 2048) ? { asyncDir: stringValue(raw.asyncDir, 2048) } : {}),
		...(clampNumber(raw.pid) !== undefined && clampNumber(raw.pid)! > 0 && Number.isInteger(clampNumber(raw.pid)) ? { pid: clampNumber(raw.pid) } : {}),
		...(stringValue(raw.sessionId, 256) ? { sessionId: stringValue(raw.sessionId, 256) } : {}),
		...(stringValue(raw.sessionFile, 2048) ? { sessionFile: stringValue(raw.sessionFile, 2048) } : {}),
		...(stringValue(raw.intercomTarget, 256) ? { intercomTarget: stringValue(raw.intercomTarget, 256) } : {}),
		...(stringValue(raw.ownerIntercomTarget, 256) ? { ownerIntercomTarget: stringValue(raw.ownerIntercomTarget, 256) } : {}),
		...(stringValue(raw.leafIntercomTarget, 256) ? { leafIntercomTarget: stringValue(raw.leafIntercomTarget, 256) } : {}),
		...(raw.ownerState === "live" || raw.ownerState === "gone" || raw.ownerState === "unknown" ? { ownerState: raw.ownerState } : {}),
		...(stringValue(raw.controlInbox, 2048) ? { controlInbox: stringValue(raw.controlInbox, 2048) } : {}),
		...(stringValue(raw.capabilityToken, 128) ? { capabilityToken: stringValue(raw.capabilityToken, 128) } : {}),
		...(raw.mode === "single" || raw.mode === "parallel" || raw.mode === "chain" ? { mode: raw.mode } : {}),
		...(stringValue(raw.agent, 128) ? { agent: stringValue(raw.agent, 128) } : {}),
		...(Array.isArray(raw.agents) ? { agents: raw.agents.map((agent: unknown) => stringValue(agent, 128)).filter((agent): agent is string => Boolean(agent)).slice(0, MAX_STEPS) } : {}),
		...(clampNumber(raw.currentStep) !== undefined ? { currentStep: clampNumber(raw.currentStep) } : {}),
		...(clampNumber(raw.chainStepCount) !== undefined ? { chainStepCount: clampNumber(raw.chainStepCount) } : {}),
		...(raw.activityState === "active_long_running" || raw.activityState === "needs_attention" ? { activityState: raw.activityState } : {}),
		...(clampNumber(raw.lastActivityAt) !== undefined ? { lastActivityAt: clampNumber(raw.lastActivityAt) } : {}),
		...(stringValue(raw.currentTool, 128) ? { currentTool: stringValue(raw.currentTool, 128) } : {}),
		...(clampNumber(raw.currentToolStartedAt) !== undefined ? { currentToolStartedAt: clampNumber(raw.currentToolStartedAt) } : {}),
		...(stringValue(raw.currentPath, 2048) ? { currentPath: stringValue(raw.currentPath, 2048) } : {}),
		...(clampNumber(raw.turnCount) !== undefined ? { turnCount: clampNumber(raw.turnCount) } : {}),
		...(clampNumber(raw.toolCount) !== undefined ? { toolCount: clampNumber(raw.toolCount) } : {}),
		...(totalTokens ? { totalTokens } : {}),
		...(clampNumber(raw.startedAt) !== undefined ? { startedAt: clampNumber(raw.startedAt) } : {}),
		...(clampNumber(raw.endedAt) !== undefined ? { endedAt: clampNumber(raw.endedAt) } : {}),
		...(clampNumber(raw.lastUpdate) !== undefined ? { lastUpdate: clampNumber(raw.lastUpdate) } : {}),
		...(stringValue(raw.error, 1024) ? { error: stringValue(raw.error, 1024) } : {}),
		...(steps && steps.length > 0 ? { steps } : {}),
		...(depth < MAX_DEPTH && Array.isArray(raw.children) ? { children: raw.children.map((child: unknown) => sanitizeSummary(child, depth + 1)).filter((child): child is NestedRunSummary => Boolean(child)).slice(0, MAX_CHILDREN) } : {}),
	};
}

// ── Record parsing ──────────────────────────────────────────────────────────

export function parseRecord(content: string, route: NestedRoute): NestedEventRecord | undefined {
	if (Buffer.byteLength(content, "utf-8") > MAX_EVENT_BYTES) return undefined;
	let parsed: unknown;
	try {
		parsed = JSON.parse(content);
	} catch {
		return undefined;
	}
	if (!parsed || typeof parsed !== "object") return undefined;
	const raw = parsed as Record<string, unknown>;
	if (raw.type !== "subagent.nested.started" && raw.type !== "subagent.nested.updated" && raw.type !== "subagent.nested.completed") return undefined;
	if (raw.rootRunId !== route.rootRunId || raw.capabilityToken !== route.capabilityToken) return undefined;
	if (!isSafeNestedId(raw.parentRunId)) return undefined;
	const ts = clampNumber(raw.ts);
	if (ts === undefined) return undefined;
	const child = sanitizeSummary(raw.child);
	if (!child || child.id === route.rootRunId) return undefined;
	const routedChild: NestedRunSummary = {
		...child,
		controlInbox: route.controlInbox,
		capabilityToken: route.capabilityToken,
		ownerState: child.ownerState ?? "unknown",
	};
	return {
		type: raw.type,
		ts,
		rootRunId: route.rootRunId,
		parentRunId: raw.parentRunId,
		...(clampNumber(raw.parentStepIndex) !== undefined ? { parentStepIndex: clampNumber(raw.parentStepIndex) } : {}),
		capabilityToken: route.capabilityToken,
		child: routedChild,
	};
}

export function parseNestedEventRecords(content: string, route: NestedRoute): NestedEventRecord[] {
	if (!content.includes("\n")) {
		const record = parseRecord(content.trim(), route);
		return record ? [record] : [];
	}
	return content.split("\n")
		.slice(0, content.endsWith("\n") ? undefined : -1)
		.map((line) => line.trim() ? parseRecord(line, route) : undefined)
		.filter((event): event is NestedEventRecord => Boolean(event));
}
