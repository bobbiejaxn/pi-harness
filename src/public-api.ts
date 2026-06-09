/**
 * Public API surface for pi-harness.
 *
 * Consumers should import from this module rather than reaching into
 * internal paths. Everything re-exported here is stable public API.
 *
 * Usage:
 * ```ts
 * import { Cron, ComsClient, ConvexAdapter, TraceRecorder } from "pi-harness/public-api";
 * ```
 *
 * ## Modules
 *
 * | Module | Purpose |
 * |--------|---------|
 * | `Cron` | In-process job scheduler with DLQ |
 * | `ComsClient` | HTTP client for coms-net peer network |
 * | `ConvexAdapter` | Typed persistence (Convex or local JSONL) |
 * | `TraceRecorder` | JSONL trace persistence for subagent events |
 */

// ── Cron scheduler ──────────────────────────────────────────────────────────

export { Cron, createTraceSummarizerJob } from "./cron/cron.ts";
export type { CronConfig, CronJob, CronContext } from "./cron/cron.ts";

// ── Coms-net client ─────────────────────────────────────────────────────────

export { ComsClient, ComsClientError, resolveComsConfig } from "./coms/coms-client.ts";
export type {
	AgentCard,
	RegisterRequest,
	RegisterResponse,
	SendRequest,
	SendResponse,
	HeartbeatRequest,
	MessageStatus,
	ResponseSubmitRequest,
	ServerHealth,
	ComsConfig,
	ComsCliFlags,
	ComsEnv,
} from "./coms/coms-types.ts";

// ── Convex adapter ──────────────────────────────────────────────────────────

export { ConvexAdapter } from "./convex/convex-adapter.ts";
export type {
	ConvexEvent,
	ConvexLesson,
	ConvexMemory,
	ConvexFact,
	ConvexRun,
	EventFilter,
	LessonFilter,
	MemoryFilter,
	FactFilter,
	RunFilter,
	EventSeverity,
	EventType,
	MemoryCategory,
	MemorySource,
	RunTrigger,
	RunStatus,
} from "./convex/convex-types.ts";

// ── Trace recorder ──────────────────────────────────────────────────────────

export { TraceRecorder } from "./shared/trace-recorder.ts";

// ── Acceptance gates ────────────────────────────────────────────────────────

export { runAcceptanceGates } from "./runs/acceptance-gates.ts";
