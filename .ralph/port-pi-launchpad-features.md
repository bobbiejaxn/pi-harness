# Port pi_launchpad Features into pi-subagents

## Target
`/Users/michaelguiao/Projects/active/pi-subagents/`

## Source
`/Users/michaelguiao/pi_launchpad/`

## Checklist

### Phase 1: Core Engine Features (into src/shared/)
- [x] Port tool allowlist (permissive — allow all by default, block only when explicitly configured)
- [x] Port domain enforcement (per-agent file path restrictions via env)
- [x] Port TillDone task tracking state machine
- [x] Port streaming callback hooks (onText, onToolCall, onUsage from subprocess.ts)
- [x] Wire all new modules into types.ts, execution.ts, subagent-executor.ts, extension/index.ts

### Phase 2: Scripts & Tests
- [x] Port trace-index.sh and cost digest scripts (adapted for pi-subagents manifest format)
- [x] Port/adapt acceptance test suite (subagent-delegation.sh)
- [x] Write unit tests for all new modules (99 new tests, 179 total passing)

### Phase 3: Documentation
- [x] Update README.md with new features
- [x] Update CHANGELOG.md

## Rules
- Zero breaking changes — all new features opt-in
- Permissive defaults — allowlists allow all unless explicitly restricted
- Type-safe — full TypeScript
- Test every new module

## Verification Evidence
- 179 unit/integration tests passing (80 Phase 1 + 99 Phase 2)
- 27/27 acceptance checks passing
- Live E2E: spawned scout subagent, verified manifest written, trace-index queries real data
- All new modules wired into execution pipeline and installed at ~/.pi/agent/extensions/subagent/
