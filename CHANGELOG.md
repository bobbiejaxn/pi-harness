# Changelog

All notable changes to pi-harness are documented here.

## [1.1.0] — 2026-06-09

### Added

**Phase 4: Executive layer (cron, board, coms-net, Convex)**

- **Cron scheduler** (`src/cron/cron.ts`) — in-process job scheduler with named jobs, interval-based execution, dead-letter queue (DLQ) on failure, bounded concurrency, and automatic pause after consecutive failures. Built-in `createTraceSummarizerJob()` reads all trace files and emits `cron.trace_summary` events with aggregate stats. 12 unit tests.

- **Board deliberation** (`agents/board/*.md`) — 8 board advisor agents (architect, ceo, contrarian, moonshot, ship-fast, tech-debt-auditor, security-advisor, dx-advocate) + board-ceo moderator. `/deliberate` slash command runs 3-phase deliberation (parallel positions → targeted rebuttals → synthesis).

- **Coms-net client** (`src/coms/coms-client.ts`) — typed HTTP client for the peer-to-peer agent network. 9 API methods (health, register, heartbeat, send, getMessage, awaitMessage, submitResponse, leave, listPeers) with Bearer auth injection, bounded timeouts, auth token sanitization in errors, and config resolution from env/CLI. 18 unit tests.

- **Convex adapter** (`src/convex/convex-adapter.ts`) — typed persistence layer for events, lessons, memories, facts, and runs. Dual backend: Convex HTTP API (if `convexUrl` configured) or local JSONL (for testing/offline). Rich query filters with per-table timestamp mapping. 24 unit tests.

- **`/status` command** (`src/slash/status.ts`) — project snapshot: unit test count (static analysis), last git commit, open GitHub issues. All data sources fail-soft.

- **`/ceo` slash command** (`prompts/ceo.md` + `scripts/ceo.sh`) — autonomous CEO mode for project direction.

- **`/gather` slash command** (`scripts/gather.sh`) — gather context and clarify a question.

- **`/research` slash command** (`scripts/research.sh`) — parallel research on a topic.

- **Acceptance gates** (`src/runs/acceptance-gates.ts`) — post-ship verification: fail-fast, optional gates, per-gate pass/fail/skip.

- **Trace recorder** (`src/shared/trace-recorder.ts`) — JSONL persistence for subagent lifecycle events. Split into `emit()` (public, for producers) and `handleEvent()` (private bus-receiver) to prevent infinite recursion.

- **Public API** (`src/public-api.ts`) — stable re-export surface for consumers. Import cron, coms, convex, trace-recorder, and acceptance-gates from one place.

### Changed

- **Executor refactor** — `subagent-executor.ts` reduced from 2565 → 1974 LOC (23% reduction). Extracted `foreground-validation.ts` (478 LOC: validation + parallel worktree helpers) and `run-async.ts` (185 LOC: async dispatch path).

- **Chain-clarify refactor** — `chain-clarify.ts` reduced from 1333 → 1172 LOC. Extracted `clarify-editor.ts` (152 LOC: text editor helpers).

- **Extension wiring** — cron + convex initialized in `src/extension/index.ts`. Cron auto-starts with trace-summarizer job (30 min interval). Convex uses local JSONL by default. Both cleaned up on session_shutdown. Test-mode guard prevents cron from starting during `npm run test:unit`. Cron timers use `unref()` to not keep process alive.

- **Config** — `ExtensionConfig` gains `cron` (boolean) and `convexUrl` (string) options.

### Tests

- **826 unit tests** (up from 772) — 0 failures.
- **22 integration tests** added:
  - `cron-execution.test.ts` — real timer-based execution, DLQ persistence, failure recovery, clean shutdown.
  - `coms-client-endpoint.test.ts` — real HTTP server (node:http), endpoint testing, error handling.
  - `convex-adapter-recovery.test.ts` — corrupt JSONL, empty files, missing directories, concurrent writes.

### Docs

- `AGENTS.md` — test count updated, refactor status updated.
- `~/.pi/agent/projects/pi-harness.md` — crystallization log updated.

## [1.0.0] — 2026-06-09

Initial release. Subagent execution engine with:
- Sync and async execution (single, parallel, chain modes)
- Circuit breaker, session learner, execution guard
- Cost control with per-run and session budgets
- Intercom bridge for fork-context coordination
- TUI widget for live subagent monitoring
- Slash commands (/ship, /ceo)
- Agent discovery and management
- Skills system
- Nested subagent support
- 772 unit tests
