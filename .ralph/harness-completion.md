
# pi-harness completion — wire, consume, test, drop-in

## Goal
Complete the 4 remaining work items to make pi-harness production-ready:

## Checklist

### 1. Wire merge resolver into worktree flow
- [ ] Find where worktree tasks complete and diffs are collected in subagent-executor.ts
- [ ] After successful parallel worktree tasks, call resolveMerge() instead of just cleanup
- [ ] Wire MergeResolverOptions through config → executor deps → worktree flow
- [ ] Add merge result to SingleResult (worktree.mergeResult)
- [ ] Unit test for the wiring

### 2. Consume session learner hints
- [ ] Before runSync calls in subagent-executor.ts, call learner.suggest(agent, task)
- [ ] Use hint.estimatedCost to warn if approaching cost limit
- [ ] Use hint.suggestedTimeoutMs to override/extend timeoutConfig when learner has data
- [ ] Use hint.preferredModel to influence model selection
- [ ] Use hint.skipRetry to skip retry when agent has 3+ consecutive failures
- [ ] Use hint.shouldEscalate to surface escalation in tool result
- [ ] Log hint data to manifest

### 3. Live E2E tests for new guards
- [ ] live-circuit-breaker.sh: spawn agent 3× with forced failure, verify 4th is blocked
- [ ] live-execution-guard.sh: spawn agent with maxTurns=2, verify kill on turn 3
- [ ] live-stall-detection.sh: spawn agent with stallTimeoutMs=5000, verify kill
- [ ] Add to run-all.sh

### 4. Drop-in test on ivi
- [ ] Backup ivi's current .pi/extensions/subagent/
- [ ] Install pi-harness to ivi's .pi/extensions/subagent/
- [ ] Verify extension loads (pi --mode text)
- [ ] Run a single subagent delegation test
- [ ] Document any issues found
- [ ] Restore if needed

## Key files
- `/Users/michaelguiao/Projects/active/pi-subagents/src/runs/foreground/subagent-executor.ts` — main executor
- `/Users/michaelguiao/Projects/active/pi-subagents/src/runs/shared/worktree.ts` — worktree lifecycle
- `/Users/michaelguiao/Projects/active/pi-subagents/src/shared/merge-resolver.ts` — merge resolver
- `/Users/michaelguiao/Projects/active/pi-subagents/src/shared/session-learner.ts` — session learner
- `/Users/michaelguiao/Projects/active/pi-subagents/src/shared/execution-guard.ts` — execution guard
- `/Users/michaelguiao/Projects/active/pi-subagents/src/shared/circuit-breaker.ts` — circuit breaker
- `/Users/michaelguiao/Projects/active/agent0/usr/projects/ivi/` — ivi project for drop-in test

## Constraints
- Zero breaking changes
- All existing 236 tests must keep passing
- Live E2E tests use real `pi` CLI with scout agent
