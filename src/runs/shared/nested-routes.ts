/**
 * Nested route creation and resolution.
 * Extracted from nested-events.ts.
 */

import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { TEMP_ROOT_DIR, type NestedRouteInfo, type NestedRunSummary } from "../../shared/types.ts";
import { isSafeNestedPathId, parseNestedPathEnv, type NestedPathEntry } from "./nested-path.ts";
import {
	SUBAGENT_PARENT_CAPABILITY_TOKEN_ENV,
	SUBAGENT_PARENT_CHILD_INDEX_ENV,
	SUBAGENT_PARENT_CONTROL_INBOX_ENV,
	SUBAGENT_PARENT_DEPTH_ENV,
	SUBAGENT_PARENT_EVENT_SINK_ENV,
	SUBAGENT_PARENT_PATH_ENV,
	SUBAGENT_PARENT_ROOT_RUN_ID_ENV,
	SUBAGENT_PARENT_RUN_ID_ENV,
} from "./pi-args.ts";

export const NESTED_EVENTS_DIR = path.join(TEMP_ROOT_DIR, "nested-subagent-events");
export const ROUTE_FILE = "route.json";
const MAX_DEPTH = 3;

// ── Helpers ─────────────────────────────────────────────────────────────────

export function isSafeNestedId(value: unknown): value is string {
	return isSafeNestedPathId(value);
}

export function assertSafeNestedId(label: string, value: string): void {
	if (!isSafeNestedId(value)) throw new Error(`${label} must be a non-empty safe id token.`);
}

export function assertSafeId(label: string, value: string): void {
	assertSafeNestedId(label, value);
}

export function containedPath(base: string, candidate: string): boolean {
	const resolvedBase = path.resolve(base);
	const resolvedCandidate = path.resolve(candidate);
	return resolvedCandidate === resolvedBase || resolvedCandidate.startsWith(`${resolvedBase}${path.sep}`);
}

export function commonRouteRoot(route: Pick<NestedRouteInfo, "eventSink" | "controlInbox">): string {
	return path.dirname(path.resolve(route.eventSink));
}

export function validateRouteShape(route: NestedRouteInfo): void {
	assertSafeId("rootRunId", route.rootRunId);
	assertSafeId("capabilityToken", route.capabilityToken);
	if (!containedPath(NESTED_EVENTS_DIR, route.eventSink)) throw new Error("Nested event sink is outside the subagent nested event root.");
	if (!containedPath(NESTED_EVENTS_DIR, route.controlInbox)) throw new Error("Nested control inbox is outside the subagent nested event root.");
	if (commonRouteRoot(route) !== path.dirname(path.resolve(route.controlInbox))) throw new Error("Nested event sink and control inbox must share one route root.");
}

function clampNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

// ── Route creation ──────────────────────────────────────────────────────────

export function createNestedRoute(rootRunId: string): NestedRouteInfo {
	assertSafeId("rootRunId", rootRunId);
	const capabilityToken = randomUUID();
	const routeRoot = path.join(NESTED_EVENTS_DIR, `${rootRunId}-${capabilityToken}`);
	const eventSink = path.join(routeRoot, "events");
	const controlInbox = path.join(routeRoot, "controls");
	fs.mkdirSync(eventSink, { recursive: true, mode: 0o700 });
	fs.mkdirSync(controlInbox, { recursive: true, mode: 0o700 });
	fs.writeFileSync(path.join(routeRoot, ROUTE_FILE), `${JSON.stringify({ rootRunId, capabilityToken, createdAt: Date.now() })}\n`, { mode: 0o600 });
	return { rootRunId, eventSink, controlInbox, capabilityToken };
}

// ── Route resolution ────────────────────────────────────────────────────────

export function resolveNestedRouteFromEnv(env: NodeJS.ProcessEnv = process.env): NestedRouteInfo | undefined {
	const rootRunId = env[SUBAGENT_PARENT_ROOT_RUN_ID_ENV];
	const eventSink = env[SUBAGENT_PARENT_EVENT_SINK_ENV];
	const controlInbox = env[SUBAGENT_PARENT_CONTROL_INBOX_ENV];
	const capabilityToken = env[SUBAGENT_PARENT_CAPABILITY_TOKEN_ENV];
	if (!rootRunId || !eventSink || !controlInbox || !capabilityToken) return undefined;
	const route = { rootRunId, eventSink, controlInbox, capabilityToken };
	validateRouteShape(route);
	const routeFile = path.join(commonRouteRoot(route), ROUTE_FILE);
	const metadata = JSON.parse(fs.readFileSync(routeFile, "utf-8")) as { rootRunId?: unknown; capabilityToken?: unknown };
	if (metadata.rootRunId !== rootRunId || metadata.capabilityToken !== capabilityToken) {
		throw new Error("Nested event route metadata does not match the provided root id and capability token.");
	}
	return route;
}

export function resolveInheritedNestedRouteFromEnv(env: NodeJS.ProcessEnv = process.env): NestedRouteInfo | undefined {
	try {
		return resolveNestedRouteFromEnv(env);
	} catch (error) {
		console.error("Ignoring invalid nested subagent event route:", error);
		return undefined;
	}
}

export function resolveNestedParentAddressFromEnv(env: NodeJS.ProcessEnv = process.env): { parentRunId: string; parentStepIndex?: number; depth: number; path: NestedPathEntry[] } | undefined {
	const parentRunId = env[SUBAGENT_PARENT_RUN_ID_ENV];
	if (!isSafeNestedId(parentRunId)) return undefined;
	const rawIndex = env[SUBAGENT_PARENT_CHILD_INDEX_ENV];
	const parentStepIndex = rawIndex && /^\d+$/.test(rawIndex) ? Number(rawIndex) : undefined;
	const depth = Math.min(Math.max(1, clampNumber(Number(env[SUBAGENT_PARENT_DEPTH_ENV])) ?? 1), MAX_DEPTH);
	const parsedPath = parseNestedPathEnv(env[SUBAGENT_PARENT_PATH_ENV]);
	const nestedPath = parsedPath.length ? parsedPath : [{ runId: parentRunId, ...(parentStepIndex !== undefined ? { stepIndex: parentStepIndex } : {}) }];
	return { parentRunId, ...(parentStepIndex !== undefined ? { parentStepIndex } : {}), depth, path: nestedPath };
}

export function resolveNestedAsyncDir(rootRunId: string, run: NestedRunSummary): string | undefined {
	if (!run.asyncDir) return undefined;
	const resolved = path.resolve(run.asyncDir);
	const nestedRoot = path.resolve(TEMP_ROOT_DIR, "nested-subagent-runs", rootRunId, run.id);
	const relative = path.relative(nestedRoot, resolved);
	return resolved === nestedRoot || (!relative.startsWith("..") && !path.isAbsolute(relative)) ? resolved : undefined;
}
