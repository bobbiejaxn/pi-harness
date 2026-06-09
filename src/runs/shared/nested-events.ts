// randomUUID moved to nested-routes.ts
import * as fs from "node:fs";
import * as path from "node:path";
import {
	ASYNC_DIR,
	RESULTS_DIR,
	TEMP_ROOT_DIR,
	type AsyncJobState,
	type AsyncStatus,
	type NestedRouteInfo,
	type NestedRunSummary,
	type NestedRunState,
	type NestedStepSummary,
	type SubagentRunMode,
	type SubagentState,
} from "../../shared/types.ts";
import { isSafeNestedPathId, parseNestedPathEnv, sanitizeNestedPath, type NestedPathEntry } from "./nested-path.ts";
// SUBAGENT_PARENT_* env vars moved to nested-routes.ts
import { writeAtomicJson } from "../../shared/atomic-json.ts";

export const NESTED_EVENTS_DIR = path.join(TEMP_ROOT_DIR, "nested-subagent-events");
const ROUTE_FILE = "route.json";
const REGISTRY_FILE = "registry.json";
const MAX_EVENT_BYTES = 64 * 1024;
const MAX_STEPS = 12;
const MAX_CHILDREN = 16;
const MAX_DEPTH = 3;

type NestedStatusEventType = "subagent.nested.started" | "subagent.nested.updated" | "subagent.nested.completed";
type NestedControlResultEventType = "subagent.nested.control-result";

export type NestedRoute = NestedRouteInfo;

export interface NestedEventRecord {
	type: NestedStatusEventType;
	ts: number;
	rootRunId: string;
	parentRunId: string;
	parentStepIndex?: number;
	capabilityToken: string;
	child: NestedRunSummary;
}

export interface NestedControlResultRecord {
	type: NestedControlResultEventType;
	ts: number;
	rootRunId: string;
	capabilityToken: string;
	requestId: string;
	targetRunId: string;
	ok: boolean;
	message: string;
}

export interface NestedControlRequestRecord {
	type: "subagent.nested.control-request";
	ts: number;
	rootRunId: string;
	capabilityToken: string;
	requestId: string;
	targetRunId: string;
	action: "interrupt" | "resume";
	message?: string;
}

export interface NestedRegistry {
	rootRunId: string;
	updatedAt: number;
	children: NestedRunSummary[];
	processedEvents: string[];
}


export interface NestedRunResolutionScope {
	descendantOf: { runId: string; stepIndex?: number };
}

export interface NestedRunMatch {
	rootRunId: string;
	run: NestedRunSummary;
	scope?: NestedRunResolutionScope;
}

// Route functions extracted to nested-routes.ts — re-export for backward compat
export { isSafeNestedId, assertSafeNestedId, createNestedRoute, resolveNestedRouteFromEnv, resolveInheritedNestedRouteFromEnv, resolveNestedParentAddressFromEnv, resolveNestedAsyncDir } from "./nested-routes.ts";
import { validateRouteShape, commonRouteRoot, containedPath, assertSafeId } from "./nested-routes.ts";

// Sanitization extracted to nested-sanitize.ts
import { sanitizeSummary as _sanitizeSummary, parseRecord as _parseRecord, parseNestedEventRecords as _parseNestedEventRecords } from "./nested-sanitize.ts";
// Re-export for backward compat
export { sanitizeSummary, parseNestedEventRecords } from "./nested-sanitize.ts";

// Local helpers still needed for route resolution
function clampNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function terminal(state: NestedRunState): boolean {
	return state === "complete" || state === "failed" || state === "paused";
}

function mergeSummary(existing: NestedRunSummary | undefined, event: NestedEventRecord): NestedRunSummary {
	const incomingState = event.type === "subagent.nested.completed" && event.child.state === "running" ? "complete" : event.child.state;
	const incoming = { ...event.child, state: incomingState, lastUpdate: event.child.lastUpdate ?? event.ts };
	if (!existing) return incoming;
	const existingUpdate = existing.lastUpdate ?? 0;
	const incomingUpdate = incoming.lastUpdate ?? event.ts;
	if (incomingUpdate < existingUpdate) return existing;
	if (terminal(existing.state) && !terminal(incoming.state)) return existing;
	if (terminal(existing.state) && terminal(incoming.state) && incomingUpdate === existingUpdate) return existing;
	return { ...existing, ...incoming, state: incoming.state, lastUpdate: Math.max(existingUpdate, incomingUpdate) };
}

function attachChild(children: NestedRunSummary[], event: NestedEventRecord): NestedRunSummary[] {
	let updated = false;
	const walk = (items: NestedRunSummary[]): NestedRunSummary[] => items.map((item) => {
		if (item.id === event.parentRunId) {
			const existingChildren = item.children ?? [];
			const childIndex = existingChildren.findIndex((child) => child.id === event.child.id);
			const nextChild = mergeSummary(childIndex >= 0 ? existingChildren[childIndex] : undefined, event);
			const nextChildren = childIndex >= 0
				? existingChildren.map((child, index) => index === childIndex ? nextChild : child)
				: [...existingChildren, nextChild];
			updated = true;
			return { ...item, children: nextChildren.slice(0, MAX_CHILDREN), lastUpdate: Math.max(item.lastUpdate ?? 0, event.ts) };
		}
		if (!item.children?.length) return item;
		const nextChildren = walk(item.children);
		return nextChildren === item.children ? item : { ...item, children: nextChildren };
	});
	const next = walk(children);
	if (updated) return next;
	const childIndex = next.findIndex((child) => child.id === event.child.id);
	const nextChild = mergeSummary(childIndex >= 0 ? next[childIndex] : undefined, event);
	return childIndex >= 0
		? next.map((child, index) => index === childIndex ? nextChild : child)
		: [...next, nextChild].slice(0, MAX_CHILDREN);
}

export function applyNestedEvent(registry: NestedRegistry, event: NestedEventRecord): NestedRegistry {
	return {
		...registry,
		updatedAt: Math.max(registry.updatedAt, event.ts),
		children: attachChild(registry.children, event),
	};
}

function registryPath(route: NestedRoute): string {
	return path.join(commonRouteRoot(route), REGISTRY_FILE);
}

export function findNestedRouteForRootId(rootRunId: string): NestedRoute | undefined {
	assertSafeId("rootRunId", rootRunId);
	let entries: string[];
	try {
		entries = fs.readdirSync(NESTED_EVENTS_DIR);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
	for (const entry of entries) {
		if (!entry.startsWith(`${rootRunId}-`)) continue;
		const routeRoot = path.join(NESTED_EVENTS_DIR, entry);
		try {
			const metadata = JSON.parse(fs.readFileSync(path.join(routeRoot, ROUTE_FILE), "utf-8")) as { rootRunId?: unknown; capabilityToken?: unknown };
			if (metadata.rootRunId !== rootRunId || typeof metadata.capabilityToken !== "string") continue;
			const route = {
				rootRunId,
				eventSink: path.join(routeRoot, "events"),
				controlInbox: path.join(routeRoot, "controls"),
				capabilityToken: metadata.capabilityToken,
			};
			validateRouteShape(route);
			return route;
		} catch {
			continue;
		}
	}
	return undefined;
}

export function projectNestedRegistryForRoot(rootRunId: string): NestedRegistry | undefined {
	const route = findNestedRouteForRootId(rootRunId);
	return route ? projectNestedEvents(route) : undefined;
}

export function findNestedRun(children: NestedRunSummary[] | undefined, id: string): NestedRunSummary | undefined {
	if (!children?.length) return undefined;
	for (const child of children) {
		if (child.id === id) return child;
		const nested = findNestedRun(child.children, id) ?? findNestedRun(child.steps?.flatMap((step) => step.children ?? []), id);
		if (nested) return nested;
	}
	return undefined;
}

export interface NestedRunMatch {
	rootRunId: string;
	route: NestedRoute;
	run: NestedRunSummary;
}

export interface NestedRunResolutionScope {
	routes: NestedRoute[];
	descendantOf?: { parentRunId: string; parentStepIndex?: number };
}

function collectNestedRuns(children: NestedRunSummary[] | undefined, output: NestedRunSummary[] = []): NestedRunSummary[] {
	for (const child of children ?? []) {
		output.push(child);
		collectNestedRuns(child.children, output);
		collectNestedRuns(child.steps?.flatMap((step) => step.children ?? []), output);
	}
	return output;
}

function collectScopedNestedRuns(children: NestedRunSummary[] | undefined, scope: NestedRunResolutionScope["descendantOf"], output: NestedRunSummary[] = []): NestedRunSummary[] {
	if (!scope) return collectNestedRuns(children, output);
	for (const child of children ?? []) {
		if (child.parentRunId === scope.parentRunId && (scope.parentStepIndex === undefined || child.parentStepIndex === scope.parentStepIndex)) {
			collectNestedRuns([child], output);
			continue;
		}
		collectScopedNestedRuns(child.children, scope, output);
		collectScopedNestedRuns(child.steps?.flatMap((step) => step.children ?? []), scope, output);
	}
	return output;
}

function listNestedRoutes(): NestedRoute[] {
	let entries: string[];
	try {
		entries = fs.readdirSync(NESTED_EVENTS_DIR);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
	const routes: NestedRoute[] = [];
	for (const entry of entries) {
		const routeRoot = path.join(NESTED_EVENTS_DIR, entry);
		try {
			const metadata = JSON.parse(fs.readFileSync(path.join(routeRoot, ROUTE_FILE), "utf-8")) as { rootRunId?: unknown; capabilityToken?: unknown };
			if (typeof metadata.rootRunId !== "string" || typeof metadata.capabilityToken !== "string") continue;
			const route = {
				rootRunId: metadata.rootRunId,
				eventSink: path.join(routeRoot, "events"),
				controlInbox: path.join(routeRoot, "controls"),
				capabilityToken: metadata.capabilityToken,
			};
			validateRouteShape(route);
			routes.push(route);
		} catch {
			continue;
		}
	}
	return routes;
}

export function findNestedRunMatchesById(id: string, options: { prefix?: boolean; scope?: NestedRunResolutionScope } = {}): NestedRunMatch[] {
	assertSafeId("id", id);
	const matches: NestedRunMatch[] = [];
	for (const route of options.scope?.routes ?? listNestedRoutes()) {
		try {
			const registry = projectNestedEvents(route);
			for (const run of collectScopedNestedRuns(registry.children, options.scope?.descendantOf)) {
				if (options.prefix ? run.id.startsWith(id) : run.id === id) matches.push({ rootRunId: route.rootRunId, route, run });
			}
		} catch {
			continue;
		}
	}
	return matches;
}

export function findNestedRunById(id: string): { rootRunId: string; run: NestedRunSummary } | undefined {
	const match = findNestedRunMatchesById(id)[0];
	return match ? { rootRunId: match.rootRunId, run: match.run } : undefined;
}

export function readNestedRegistry(route: NestedRoute): NestedRegistry {
	validateRouteShape(route);
	try {
		const parsed = JSON.parse(fs.readFileSync(registryPath(route), "utf-8")) as NestedRegistry;
		return {
			rootRunId: route.rootRunId,
			updatedAt: typeof parsed.updatedAt === "number" ? parsed.updatedAt : 0,
			children: Array.isArray(parsed.children) ? parsed.children.map((child) => _sanitizeSummary(child)).filter((child): child is NestedRunSummary => Boolean(child)) : [],
			processedEvents: Array.isArray(parsed.processedEvents) ? parsed.processedEvents.filter((item): item is string => typeof item === "string") : [],
		};
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		return { rootRunId: route.rootRunId, updatedAt: 0, children: [], processedEvents: [] };
	}
}

export function projectNestedEvents(route: NestedRoute): NestedRegistry {
	validateRouteShape(route);
	let registry = readNestedRegistry(route);
	const seen = new Set(registry.processedEvents);
	let changed = false;
	let entries: string[] = [];
	try {
		entries = fs.readdirSync(route.eventSink).filter((entry) => entry.endsWith(".json") || entry.endsWith(".jsonl")).sort();
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	for (const entry of entries) {
		if (seen.has(entry)) continue;
		const eventPath = path.join(route.eventSink, entry);
		if (!containedPath(route.eventSink, eventPath)) continue;
		let content: string;
		try {
			const stat = fs.statSync(eventPath);
			if (!stat.isFile() || stat.size > MAX_EVENT_BYTES) continue;
			content = fs.readFileSync(eventPath, "utf-8");
		} catch {
			continue;
		}
		for (const event of _parseNestedEventRecords(content, route)) {
			registry = applyNestedEvent(registry, event);
			changed = true;
		}
		seen.add(entry);
		changed = true;
	}
	if (changed) {
		registry = { ...registry, processedEvents: [...seen].slice(-1000) };
		// Parent projection is the only writer to this sidecar registry. Child and
		// runner processes only create immutable event files, so parent status.json
		// remains owned by the existing runner writer and is never rewritten here.
		writeAtomicJson(registryPath(route), registry);
	}
	return registry;
}

// I/O functions extracted to nested-io.ts — re-export for backward compat
export { writeNestedEvent, writeNestedControlRequest, readNestedControlRequests, writeNestedControlResult, readNestedControlResults } from "./nested-io.ts";

export function nestedRouteEnv(route: NestedRoute): Record<string, string> {
	return {
		[SUBAGENT_PARENT_EVENT_SINK_ENV]: route.eventSink,
		[SUBAGENT_PARENT_CONTROL_INBOX_ENV]: route.controlInbox,
		[SUBAGENT_PARENT_ROOT_RUN_ID_ENV]: route.rootRunId,
		[SUBAGENT_PARENT_CAPABILITY_TOKEN_ENV]: route.capabilityToken,
	};
}

export function attachRootChildrenToSteps<T extends { children?: NestedRunSummary[]; index?: number }>(rootRunId: string, steps: T[] | undefined, children: NestedRunSummary[] | undefined): void {
	if (!steps?.length) return;
	for (const step of steps) {
		step.children = undefined;
	}
	if (!children?.length) return;
	for (const child of children) {
		if (child.parentRunId !== rootRunId || child.parentStepIndex === undefined) continue;
		const step = steps.find((candidate, index) => (candidate.index ?? index) === child.parentStepIndex);
		if (!step) continue;
		step.children ??= [];
		step.children = [...step.children.filter((existing) => existing.id !== child.id), child].slice(0, MAX_CHILDREN);
	}
}

export function updateAsyncJobNestedProjection(job: AsyncJobState): void {
	if (!job.nestedRoute) return;
	const registry = projectNestedEvents(job.nestedRoute);
	job.nestedChildren = registry.children;
	attachRootChildrenToSteps(job.asyncId, job.steps, registry.children);
}

export function updateForegroundNestedProjection(control: SubagentState["foregroundControls"] extends Map<string, infer T> ? T : never): void {
	if (!control.nestedRoute) return;
	const registry = projectNestedEvents(control.nestedRoute);
	control.nestedChildren = registry.children;
}

export function hasLiveNestedDescendants(children: NestedRunSummary[] | undefined): boolean {
	if (!children?.length) return false;
	for (const child of children) {
		if (!terminal(child.state)) return true;
		if (hasLiveNestedDescendants(child.children)) return true;
		if (hasLiveNestedDescendants(child.steps?.flatMap((step) => step.children ?? []))) return true;
	}
	return false;
}

export function nestedSummaryFromAsyncStatus(status: AsyncStatus, asyncDir: string, fallback: { id: string; parentRunId: string; parentStepIndex?: number; depth: number; path?: Array<{ runId: string; stepIndex?: number; agent?: string }>; mode?: SubagentRunMode; ts: number }): NestedRunSummary {
	return {
		id: status.runId || fallback.id,
		parentRunId: fallback.parentRunId,
		...(fallback.parentStepIndex !== undefined ? { parentStepIndex: fallback.parentStepIndex } : {}),
		depth: fallback.depth,
		path: fallback.path ?? [{ runId: fallback.parentRunId, ...(fallback.parentStepIndex !== undefined ? { stepIndex: fallback.parentStepIndex } : {}) }],
		asyncDir,
		...(status.pid ? { pid: status.pid } : {}),
		...(status.sessionId ? { sessionId: status.sessionId } : {}),
		mode: status.mode ?? fallback.mode,
		state: status.state,
		...(status.currentStep !== undefined ? { currentStep: status.currentStep } : {}),
		...(status.chainStepCount !== undefined ? { chainStepCount: status.chainStepCount } : {}),
		...(status.activityState ? { activityState: status.activityState } : {}),
		...(status.lastActivityAt !== undefined ? { lastActivityAt: status.lastActivityAt } : {}),
		...(status.currentTool ? { currentTool: status.currentTool } : {}),
		...(status.currentToolStartedAt !== undefined ? { currentToolStartedAt: status.currentToolStartedAt } : {}),
		...(status.currentPath ? { currentPath: status.currentPath } : {}),
		...(status.turnCount !== undefined ? { turnCount: status.turnCount } : {}),
		...(status.toolCount !== undefined ? { toolCount: status.toolCount } : {}),
		...(status.totalTokens ? { totalTokens: status.totalTokens } : {}),
		...(status.startedAt !== undefined ? { startedAt: status.startedAt } : { startedAt: fallback.ts }),
		...(status.endedAt !== undefined ? { endedAt: status.endedAt } : {}),
		lastUpdate: status.lastUpdate ?? fallback.ts,
		...(status.sessionFile ? { sessionFile: status.sessionFile } : {}),
		...(status.steps?.length ? { steps: status.steps.map((step) => ({
			agent: step.agent,
			status: step.status,
			...(step.sessionFile ? { sessionFile: step.sessionFile } : {}),
			...(step.activityState ? { activityState: step.activityState } : {}),
			...(step.lastActivityAt !== undefined ? { lastActivityAt: step.lastActivityAt } : {}),
			...(step.currentTool ? { currentTool: step.currentTool } : {}),
			...(step.currentToolStartedAt !== undefined ? { currentToolStartedAt: step.currentToolStartedAt } : {}),
			...(step.currentPath ? { currentPath: step.currentPath } : {}),
			...(step.turnCount !== undefined ? { turnCount: step.turnCount } : {}),
			...(step.toolCount !== undefined ? { toolCount: step.toolCount } : {}),
			...(step.startedAt !== undefined ? { startedAt: step.startedAt } : {}),
			...(step.endedAt !== undefined ? { endedAt: step.endedAt } : {}),
			...(step.error ? { error: step.error } : {}),
		})).slice(0, MAX_STEPS) } : {}),
	};
}

export function nestedArtifactEnv(rootRunId: string, parentRunId: string): Record<string, string> {
	return {
		PI_SUBAGENT_NESTED_ROOT_RUN_ID: rootRunId,
		PI_SUBAGENT_NESTED_PARENT_RUN_ID: parentRunId,
	};
}

export function isTopLevelAsyncDir(asyncDir: string): boolean {
	const resolved = path.resolve(asyncDir);
	return containedPath(ASYNC_DIR, resolved) && !containedPath(path.join(TEMP_ROOT_DIR, "nested-subagent-runs"), resolved);
}

export function nestedResultsPath(rootRunId: string, id: string): string {
	assertSafeId("rootRunId", rootRunId);
	assertSafeId("id", id);
	return path.join(RESULTS_DIR, "nested", rootRunId, `${id}.json`);
}
