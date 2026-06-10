# Project Entry — pi-harness

> **This file specializes the global rules for THIS project. It does not contradict them.**
> Per Manifesto VII.26, project files hold only specifics — the stack declaration and any
> project-specific specialization. Global principles live at `~/.pi/agent/AGENTS.md`.

## Read first (in order)

1. `~/.pi/agent/AGENTS.md` — global entry point (manifesto + system-design + crystallization)
2. `~/.pi/agent/personal-overrides.md` — Mike's user-specific rules
3. `~/.pi/agent/projects/pi-harness.md` — this project's crystallized entry (stack, verification, notes)
4. `~/.pi/agent/stacks/typescript.md` and `~/.pi/agent/stacks/node.md` — operative stack references

## Stack (detected)

- Language: TypeScript (uses `--experimental-strip-types` — no build step)
- Runtime: Node.js 22+
- Engine: pi (subagent execution engine; this IS the engine)
- Peer dependencies: `@earendil-works/pi-coding-agent`, `jiti`, `typebox`
- Type checking: `tsc --noEmit` via `npm run typecheck` (489 pre-existing type errors — non-blocking)

## Verification chain (concrete)

```bash
npm run test:unit  # 826 unit tests, must all pass
npm run typecheck  # tsc --noEmit (non-blocking — 489 pre-existing type errors from code built without tsc)
```

Integration tests (`npm run test:integration`) require a running `pi` binary environment. See `test/integration/README.md`.

## This project's exceptions

None. Every manifesto principle applies.

## Crystallization status

- 2026-06-09: Initial crystallization. Stack files `typescript.md` and `node.md` built and verified.
- 2026-06-09: Subagent engine swap to pi-harness from pi-subagents (commit `6b042aa`).
- 2026-06-09: `config is not defined` typo fix in executor (commit `ba68d13`).
- 2026-06-09: Refactor extracted 9 helpers to `run-utils.ts` and 9 types to `executor-types.ts` (commit `1e2dcf0` + `b7c9f25`).
- 2026-06-09: Trace recorder with JSONL persistence (commit `77167f4`).
- 2026-06-09: Acceptance gates module (commit `91e7d02`).
- 2026-06-09: Phase 4 modules — cron (`src/cron/`), coms-net (`src/coms/`), convex (`src/convex/`).
- 2026-06-09: LOC ceiling refactor (v1.2.0) — 13 of 16 files brought under 500 LOC, ~2,600 LOC reduced, 30 commits.
- 2026-06-10: Housekeeping — version bump 1.2.0, `tsconfig.json` + typecheck gate, AGENTS.md refresh.

## Project-specific notes

- **Engine library, not a service.** This is a library that other projects (e.g. `pi_launchpad`) consume via `npm install file:../active/pi-harness`.
- **Single extension entry point** at `src/extension/index.ts`. Consumers should NOT depend on internal modules — they go through the re-export shim at `agents.ts`.
- **Public API surface** at `src/public-api.ts` — re-exports Cron, ComsClient, ConvexAdapter, TraceRecorder, runAcceptanceGates.
- **Refactor ceiling** (Manifesto III.13): 400 LOC soft, 500 LOC hard. Current state: 13 of 16 original files under 500 LOC. Remaining 11 files are architecturally constrained (monolithic closures, TUI components, shared mutable state).
- **Type errors**: 489 pre-existing `tsc` errors from code built with `--experimental-strip-types` (no tsc enforcement). Runtime is correct (826/826 tests pass). Fixing requires aligning `types.ts` with actual runtime shapes — a separate project.

## Don't forget

- Run `npm run test:unit` before committing. 826/826 must pass.
- Update `~/.pi/agent/projects/pi-harness.md` and `CHANGELOG.md` when stack, verification, or notes change.
- The `subagent` tool name is public API. Renaming breaks every consumer.
