
# Evolve pi-subagents: Superior Subagent Execution Engine

Goal: Port the best features from ivi's custom subagent fork and pi-agent-observability into the upstream pi-subagents package, making it the superior all-in-one subagent execution + observability solution.

## Source repos (read-only)
- `/Users/michaelguiao/Projects/active/agent0/usr/projects/ivi/.pi/extensions/subagent/` — ivi's custom fork
- `/Users/michaelguiao/Projects/active/pi-agent-observability/` — observability extension + server + UI

## Target repo (write)
- `/Users/michaelguiao/Projects/active/pi-subagents/` — upstream pi-subagents

## Progress

### Phase 1: Cost & Reliability Guards (from ivi) — DONE
- [x] **Per-run cost guard** — `src/shared/cost-guard.ts` (CostGuardConfig, SessionCostTracker, checkRunCostLimit) + 15 tests
- [x] **Session budget** — SessionCostTracker in cost-guard.ts with cumulative cap + callback
- [x] **Cascading timeouts** — `src/shared/cascading-timeout.ts` (depth schedule, env override) + 12 tests
- [x] **Retry with exponential backoff** — `src/shared/retry-logic.ts` (isRetriable, backoffMs, shouldRetry) + 22 tests
- [x] **Allowed-agents guard** — `src/shared/allowed-agents-guard.ts` (checkAllowedAgent) + 7 tests
- [x] Config schema + ExtensionConfig additions for all new options (types.ts updated)
- [x] Unit tests for cost guard, budget, retry, timeout logic (72 total, all passing)
- [x] **WIRE: cost guard into execution.ts** — kill child on cost overflow
- [x] **WIRE: retry loop into execution.ts** — runSyncWithRetry wrapper added
- [x] **WIRE: cascading timeout into execution.ts** — depth-aware SIGTERM
- [x] **WIRE: allowed-agents into subagent-executor.ts** — ExecutorDeps + runSync options
- [x] **WIRE: session cost tracker into index.ts** — instantiated and passed to executor
- [x] **WIRE: config resolution into index.ts** — resolveCostGuardConfig, resolveRetryConfig, resolveTimeoutConfig

### Phase 2: Trace Propagation (from ivi) — DONE
- [x] **Trace run ID propagation** — `src/shared/trace-propagation.ts` (resolveTraceRunId, buildTraceEnv) + 4 tests
- [x] **Manifest writing** — writeRunManifest in trace-propagation.ts + 2 tests
- [x] **PID tracking** — writePidFile/removePidFile in trace-propagation.ts
- [x] **WIRE: trace env into execution.ts** — propagated PI_TRACE_* to children
- [x] **WIRE: trace env into async-execution.ts** — propagate PI_TRACE_* to async children
- [x] **WIRE: manifest writing into execution flow** — write after run completes
- [x] **WIRE: PID file management into execution.ts** — write on spawn, clean up on exit

### Phase 3: Observability Hooks (inspired by pi-agent-observability) — WIRED
- [x] **Structured subagent events** — `src/shared/subagent-events.ts` (7 event types + payloads) + 6 tests
- [x] **Per-turn cost/token rollup** — accumulateTurnCost, sumTurnRollups in subagent-events.ts
- [x] **WIRE: event emission into index.ts** — SessionCostTracker callback emits budget_exhausted, session_start resets tracker
- [x] Integration tests for event emission

### Phase 4: Documentation — DONE
- [x] Update README with new features, config options, env vars
- [x] Add CHANGELOG entry

## Architecture Principles
1. **Zero breaking changes** — all new features are opt-in via config or env vars
2. **Additive config** — extend ExtensionConfig, not replace it
3. **Sensible defaults** — cost guards off by default, cascading timeouts on by default
4. **Test-first** — unit tests for every new module before integration
5. **Type-safe** — full TypeScript types, no any
