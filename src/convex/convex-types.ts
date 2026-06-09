/**
 * Types for the Convex adapter — mirrors the pi_launchpad Convex schema.
 *
 * These are pure TypeScript interfaces with no runtime dependency on the
 * `convex` package. The adapter can persist to Convex (if configured) or
 * fall back to local JSONL storage (for testing / offline / CI).
 *
 * Schema tables (from pi_launchpad/.pi/convex/schema.ts):
 *   agents, projects, clients, libraries, lessons, facts,
 *   memories, patterns, runs, events, inbox
 *
 * The adapter exposes the subset that pi-harness actually needs:
 *   events, lessons, memories, runs, facts
 */

// ── Events ──────────────────────────────────────────────────────────────────

export type EventSeverity = "critical" | "warning" | "info";
export type EventType = "deploy" | "incident" | "lesson" | "ship" | "alert" | "coordination" | "cron" | "coms" | "system";

export interface ConvexEvent {
	id?: string;
	type: EventType;
	project?: string;
	agent?: string;
	detail: string;
	severity: EventSeverity;
	ts: number;
	metadata?: unknown;
}

// ── Lessons ─────────────────────────────────────────────────────────────────

export type LessonSeverity = "critical" | "warning" | "info";

export interface ConvexLesson {
	id?: string;
	text: string;
	tags: string[];
	severity: LessonSeverity;
	learnedBy?: string;
	learnedAt: number;
	appliesTo: string[];
	sourceEvent?: string;
	verified?: boolean;
	verifiedBy?: string;
	context?: string;
	staleAfterDays?: number;
	lastAppliedAt?: number;
}

// ── Memories ────────────────────────────────────────────────────────────────

export type MemoryCategory = "preference" | "decision" | "pattern" | "error_pattern" | "expertise";
export type MemorySource = "session" | "lesson" | "human" | "inferred";

export interface ConvexMemory {
	id?: string;
	agent: string;
	project?: string;
	category: MemoryCategory;
	key: string;
	value: string;
	confidence: number;
	source: MemorySource;
	createdAt: number;
	updatedAt: number;
	accessCount: number;
	lastAccessedAt?: number;
	expiresAt?: number;
}

// ── Facts ───────────────────────────────────────────────────────────────────

export type FactSource = "grounded-audit" | "agent-check" | "manual";

export interface ConvexFact {
	id?: string;
	key: string;
	value: string;
	source: FactSource;
	checkedAt: number;
	project?: string;
}

// ── Runs ────────────────────────────────────────────────────────────────────

export type RunTrigger = "manual" | "cron" | "serial-dispatch" | "coms-net" | "test";
export type RunStatus = "running" | "completed" | "failed" | "aborted";

export interface ConvexRun {
	id?: string;
	runId: string;
	trigger: RunTrigger;
	project?: string;
	status: RunStatus;
	startedAt: number;
	completedAt?: number;
	totalCost?: number;
	taskCount?: number;
	successCount?: number;
	failCount?: number;
	budget?: number;
}

// ── Query filters ───────────────────────────────────────────────────────────

export interface EventFilter {
	type?: EventType;
	project?: string;
	severity?: EventSeverity;
	since?: number;
	until?: number;
	limit?: number;
}

export interface LessonFilter {
	tags?: string[];
	severity?: LessonSeverity;
	context?: string;
	appliesTo?: string;
	since?: number;
	limit?: number;
}

export interface MemoryFilter {
	agent?: string;
	project?: string;
	category?: MemoryCategory;
	keyPrefix?: string;
	minConfidence?: number;
	limit?: number;
}

export interface FactFilter {
	key?: string;
	project?: string;
	since?: number;
	limit?: number;
}

export interface RunFilter {
	runId?: string;
	project?: string;
	status?: RunStatus;
	trigger?: RunTrigger;
	since?: number;
	limit?: number;
}
