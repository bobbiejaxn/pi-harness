# Integration Tests

## Status

Integration tests spawn real child processes (`pi` binary) and require a running
pi environment. They are **not suitable for CI** without a pi installation.

- **7 tests pass** (pure logic tests that don't spawn processes)
- **30 tests fail** (require `pi` binary + full runtime environment)

## Running

```bash
# All integration tests (requires pi environment)
npm run test:integration

# Unit tests only (no environment required, always green)
npm run test:unit
```

## Categories

| Category | Tests | Notes |
|----------|-------|-------|
| Pure logic | 7 | ReadStatus, jiti, config validation |
| Async child spawn | ~25 | Need `pi` binary, temp dirs |
| Chain/parallel spawn | ~5 | Need `pi` binary + agents |

## Live shell scripts

The `live-*.sh` scripts are manual smoke tests for specific subsystems:
- `live-circuit-breaker.sh` — circuit breaker recovery
- `live-cost-guard.sh` — cost limit enforcement
- `live-e2e.sh` — full end-to-end flow
- `live-execution-guard.sh` — execution timeout guard
- `live-session-budget.sh` — session token budget
- `live-timeout.sh` — timeout handling

Run with `bash test/integration/live-*.sh` from project root.
