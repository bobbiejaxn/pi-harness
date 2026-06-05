# pi-harness

Production-hardened subagent execution engine for [pi](https://github.com/nicobailon/pi-coding-agent). Delegate work to focused child agents with circuit breakers, session learning, stuck-agent detection, cost control, and domain enforcement.

Forked from [pi-subagents](https://github.com/nicobailon/pi-subagents) v0.26.0.

## ⚠️ Project-level only

```
✅ your-project/.pi/extensions/subagent/   ← install here
❌ ~/.pi/agent/extensions/subagent/        ← NEVER (conflicts with upstream)
```

Both register a `subagent` tool — pi refuses to load both. Project-level = your project's customized version, version-controlled, no implicit deps.

## Install

```bash
cd your-project
npx pi-harness
```

That's it. Pi auto-discovers the extension when you run it in that directory.

## Quick start

Ask in plain language:

```
Use scout to analyze the auth module.
```

```
Run parallel reviewers: one for correctness, one for tests.
```

```
Ask worker to implement the login page based on the plan.
```

No agents, config, or slash commands needed to start delegating.

## How it works

Pi is the parent. A subagent is a focused child Pi session. When you delegate, Pi starts the child, gives it a task, streams progress back, and returns the result.

- **Single**: one agent, one task
- **Parallel**: multiple agents, concurrent, optional git worktree isolation
- **Chain**: sequential pipeline, each step sees `{previous}` output

## Safety features

pi-harness adds five safety layers that the upstream doesn't have:

| Layer | What it catches | Config key |
|-------|----------------|------------|
| **Circuit breaker** | Agent fails 3× in a row → blocks dispatch for cooldown | `circuitBreaker` |
| **Execution guard** | Agent loops (turns, repetition) or stalls (no output) → kills process | `executionGuard` |
| **Cost guard** | Spend exceeds limit → kills process | `cost.maxPerRun` |
| **Session budget** | Cumulative spend across all runs exceeds cap → blocks | `cost.maxSessionBudget` |
| **Domain enforcement** | Agent tries to write outside allowed paths → blocks tool call | `domain` |

## Self-learning

The harness learns from completed runs within a session (no persistence, no state files):

- **Predicted cost**: "scout averages $0.02/run" — warns if approaching limits
- **Adaptive timeouts**: "scout usually takes 15s, it's been 45s" — extends stall detection
- **Model preference**: "glm-5 failed 3× on this task, sonnet hasn't" — avoids bad models
- **Escalation**: "worker has 67% failure rate across 6 runs" — surfaces to parent

## Configuration

All optional. Create `.pi/extensions/subagent/config.json`:

```json
{
  "cost": { "maxPerRun": 0.50, "maxSessionBudget": 5.00 },
  "executionGuard": { "maxTurns": 50, "maxRepetitions": 3, "stallTimeoutMs": 120000 },
  "circuitBreaker": { "failureThreshold": 3, "cooldownMs": 30000 },
  "mergeResolver": { "aiResolveEnabled": false },
  "domain": [
    { "path": "src", "read": true, "upsert": true, "delete": false }
  ],
  "allowedTools": ["read", "write", "bash", "grep"]
}
```

### Defaults

| Option | Default | Purpose |
|--------|---------|---------|
| `cost.maxPerRun` | No limit | Kill child when single run exceeds this cost |
| `cost.maxSessionBudget` | No limit | Cumulative spend cap across all runs |
| `executionGuard.maxTurns` | 50 | Kill after N+1 turns without finishing |
| `executionGuard.maxRepetitions` | 3 | Kill after N identical tool calls |
| `executionGuard.stallTimeoutMs` | 120000 | Kill when no event for 2 min |
| `circuitBreaker.failureThreshold` | 3 | Block agent after N consecutive failures |
| `circuitBreaker.cooldownMs` | 30000 | Cooldown before probe attempt |
| `mergeResolver.aiResolveEnabled` | false | Use LLM for merge conflicts |
| `mergeResolver.aiModel` | `PI_MODEL` env var, else `zai/glm-5` | Model for AI conflict resolution |
| `domain` | No restrictions | File path access rules |
| `allowedTools` | All tools | Tool allowlist for children |

### Environment variable overrides

| Variable | Overrides |
|----------|-----------|
| `PI_SUBAGENT_MAX_COST` | `cost.maxPerRun` |
| `PI_SESSION_MAX_COST` | `cost.maxSessionBudget` |
| `PI_SUBAGENT_TIMEOUT_MS` | Cascading timeout base |
| `PI_SUBAGENT_MAX_RETRIES` | `retry.maxRetries` |

## Modules

16 production modules in `src/shared/`:

| Module | Purpose |
|--------|---------|
| `circuit-breaker` | Per-agent failure tracking with exponential backoff |
| `execution-guard` | Turn limit, repetition detection, stall detection |
| `session-learner` | Mid-session cost/duration/model learning |
| `merge-resolver` | 4-tier conflict resolution for worktree merges |
| `cost-guard` | Per-run and session budget enforcement |
| `retry-logic` | Exponential backoff with jitter |
| `cascading-timeout` | Depth-aware timeout schedule |
| `trace-propagation` | Run ID, manifests, PID files |
| `domain-enforcement` | File path access control |
| `tool-allowlist` | Permissive tool restriction |
| `allowed-agents-guard` | Parent-enforced agent restrictions |
| `subagent-events` | Structured lifecycle events |
| `tilldone` | Task list state machine |
| `stream-callbacks` | JSON line protocol processor |
| `child-domain-guard` | Structural enforcement in child processes |

## Tests

- **255 unit tests** across 16 files
- **65 structural checks** (module wiring verification)
- **11 live E2E checks** (real pi processes)

```bash
# Unit tests
node --experimental-strip-types --test test/unit/*.test.ts

# Structural
bash test/integration/structural.sh

# Full E2E suite
bash test/integration/run-all.sh
```

## Detailed documentation

The upstream pi-subagents README covers advanced topics in depth:

- **[Agent chains and parallel execution](docs/upstream-README.md#chains-and-parallel)** — chain files, `{previous}` variables, worktree isolation
- **[Prompt assembly and frontmatter](docs/upstream-README.md#prompt-assembly)** — customizing agent system prompts, model selection
- **[Background and forked runs](docs/upstream-README.md#background-runs)** — async execution, status checking
- **[Acceptance gates](docs/upstream-README.md#acceptance-gates)** — structured verification of agent output
- **[Intercom bridge](docs/upstream-README.md#intercom-bridge)** — parent-child communication
- **[Skills and tool selection](docs/upstream-README.md#skills)** — per-agent skill and extension control

## Namespace compatibility

Works with both pi package namespaces:
- `@earendil-works/pi-*` (v0.78+, current)
- `@mariozechner/pi-*` (v0.73+, legacy)

Both resolve at runtime — no source changes needed when dropping into projects using either namespace.

## License

MIT
