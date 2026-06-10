# pi-harness

Production-hardened subagent execution engine for [pi](https://github.com/nicobailon/pi-coding-agent). Delegate work to focused child agents with circuit breakers, session learning, stuck-agent detection, cost control, and domain enforcement.

Forked from [pi-subagents](https://github.com/nicobailon/pi-subagents) v0.26.0.

> **This is the engine.** If you want the full autonomous agent fleet (CEO loop, 62 specialists, 26 extensions, slash commands, enforcement scripts, self-learning), use [**pi_launchpad**](https://github.com/bobbiejaxn/pi_launchpad) instead — it includes pi-harness and adds everything else.

## Install

```bash
cd your-project
npx pi-harness
```

Pi auto-discovers the extension. No config required to start delegating.

### Verify

```bash
npx pi-harness --verify
```

Outputs JSON, exits 0 on success, 1 on failure:

```json
{"ok":true,"version":"1.3.2","path":"/project/.pi/extensions/subagent"}
```

```json
{"ok":false,"error":"not_installed"}
```

```json
{"ok":false,"error":"conflict","detail":"user-level subagent at ~/.pi/agent/extensions/subagent"}
```

### Other commands

```bash
npx pi-harness --check      # Human-readable status
npx pi-harness --update     # Pull latest from GitHub
npx pi-harness --remove     # Uninstall from this project
```

## ⚠️ Project-level only

```
✅ your-project/.pi/extensions/subagent/   ← install here
❌ ~/.pi/agent/extensions/subagent/         ← NEVER (conflicts with upstream)
```

Both register a `subagent` tool — pi refuses to load both. Project-level = version-controlled, no implicit deps.

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

## Agent onboarding

When starting a new project and installing pi-harness, use this prompt:

> Install pi-harness into this project by running `npx pi-harness`. This adds the subagent extension to `.pi/extensions/subagent/`. After install, verify with `npx pi-harness --verify` — it should output `{"ok":true,...}` and exit 0. If it reports a conflict with user-level subagent, remove `~/.pi/agent/extensions/subagent/`. The extension registers a `subagent` tool that pi auto-discovers when run in the project directory.

### What pi-harness adds

| Tool | Description |
|------|-------------|
| `subagent` | Delegate tasks to child agents with safety guards |
| `/deliberate` | Board of 8 advisor agents for strategic decisions |
| `/ship` | Review → QA → deploy gate |

### Agent names

Built-in agents discovered from `.pi/agents/` and inline config:

| Agent | Purpose |
|-------|---------|
| `researcher` | Deep analysis and information gathering |
| `writer` | Content generation and documentation |
| `scout` | Code analysis and exploration |
| `worker` | Implementation and coding tasks |
| `reviewer` | Code review and quality checks |
| `critic` | Find flaws and edge cases |

Custom agents go in `.pi/agents/<name>.md` with YAML frontmatter:

```markdown
---
model: sonnet
skills: [bash, read]
---
You are a database migration specialist.
```

## How it works

Pi is the parent. A subagent is a focused child Pi session. When you delegate, Pi starts the child, gives it a task, streams progress back, and returns the result.

- **Single**: one agent, one task
- **Parallel**: multiple agents, concurrent, optional git worktree isolation
- **Chain**: sequential pipeline, each step sees `{previous}` output

## Safety features

Five safety layers the upstream doesn't have:

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

## Programmatic API

For consumers that import pi-harness as a library dependency:

```ts
import { Cron, ComsClient, ConvexAdapter, TraceRecorder, runGates } from "pi-harness";
```

Or target a specific export:

```ts
import { Cron } from "pi-harness/public-api";
import { discoverAgents } from "pi-harness/agents";
```

### API surface

| Export | Purpose |
|--------|---------|
| `Cron` | In-process job scheduler with DLQ |
| `createTraceSummarizerJob` | Cron job that summarizes JSONL traces |
| `ComsClient` | HTTP client for coms-net peer network |
| `resolveComsConfig` | Resolve coms config from env/flags |
| `ConvexAdapter` | Typed persistence (Convex or local JSONL) |
| `TraceRecorder` | JSONL trace persistence for subagent events |
| `runGates` | Acceptance gate runner |
| `defaultNodeGates` | Default gate set for Node.js projects |
| `discoverAgents` | Scan project for agent definitions |

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

- **890 unit tests** across 40+ files — all in CI
- **25 integration tests** — mock subprocess spawning
- **0 type errors** — enforced by CI

```bash
# Unit tests (CI gate)
npm run test:unit

# Integration tests (require --experimental-transform-types)
npm run test:integration

# Type checking
npm run typecheck

# Linting
npm run lint
```

## Namespace compatibility

Works with both pi package namespaces:
- `@earendil-works/pi-*` (v0.78+, current)
- `@mariozechner/pi-*` (v0.73+, legacy)

Both resolve at runtime — no source changes needed.

## Detailed documentation

The upstream pi-subagents README covers advanced topics in depth:

- **[Agent chains and parallel execution](docs/upstream-README.md#chains-and-parallel)** — chain files, `{previous}` variables, worktree isolation
- **[Prompt assembly and frontmatter](docs/upstream-README.md#prompt-assembly)** — customizing agent system prompts, model selection
- **[Background and forked runs](docs/upstream-README.md#background-runs)** — async execution, status checking
- **[Acceptance gates](docs/upstream-README.md#acceptance-gates)** — structured verification of agent output
- **[Intercom bridge](docs/upstream-README.md#intercom-bridge)** — parent-child communication
- **[Skills and tool selection](docs/upstream-README.md#skills)** — per-agent skill and extension control

## License

MIT
