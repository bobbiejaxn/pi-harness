# Integration & E2E Tests for pi-subagents

## Target
`/Users/michaelguiao/Projects/active/pi-subagents/test/integration/`

## Test Files

### Tier 1: Structural (fast, <2s, no pi process)
- [x] `structural.sh` — 47 checks verifying all modules exist, are wired into execution pipeline, and have correct types

### Tier 2: Live E2E (spawns real pi processes)
- [x] `live-e2e.sh` — 23 checks: stream events, usage, manifest fields, PID cleanup, config resolution
- [x] `live-cost-guard.sh` — Cost limit triggered with PI_SUBAGENT_MAX_COST=0.001
- [x] `live-timeout.sh` — Timeout wiring verified, liveness check (non-deterministic kill)
- [x] `live-session-budget.sh` — Session budget exhaustion detected with PI_SESSION_MAX_COST=0.001

### Runner
- [x] `run-all.sh` — Runs all tests in sequence, 5/5 passing

## Results
- **Unit tests**: 179 passing
- **Structural integration**: 47/47 checks passing
- **Live E2E**: 23/23 checks passing (full pipeline)
- **Cost guard**: ✓ limit triggered
- **Session budget**: ✓ exhaustion detected
- **Cascading timeout**: ✓ wiring verified, liveness confirmed (actual kill is non-deterministic with free models)
- **Manifest**: ✓ all required fields present on success
- **PID tracking**: ✓ files cleaned up after run

## Notes
- Cost guard kill and session budget depend on the model having non-zero cost. With free models (zai/glm-5), the guard can't trigger on actual spend — the unit tests cover the kill logic exhaustively.
- Cascading timeout kill is non-deterministic — the subagent might complete before the timer fires. Structural wiring + liveness is verified; unit tests cover the timer logic.
