# Close pi-harness gaps for drop-in readiness

## Goal
Make pi-harness a complete drop-in replacement for ivi's subagent extension by closing 2 gaps:
1. **Merge resolver** — tiered conflict resolution for worktree merges
2. **Namespace compatibility** — support both `@mariozechner/*` and `@earendil-works/*` imports

## Checklist

### Merge Resolver (`src/shared/merge-resolver.ts`)
- [x] Port ivi's 4-tier merge resolver (clean → auto → AI → reimagine)
- [x] Types: `ResolutionTier`, `MergeResolutionResult`, `MergeResolverOptions`
- [x] Tier 1: clean merge (git merge --no-edit)
- [x] Tier 2: auto-resolve (parse conflict markers, keep incoming)
- [x] Tier 3: AI-resolve (spawn pi subprocess for LLM resolution)
- [x] Tier 4: reimagine (abort, reimplement from scratch via LLM)
- [x] Export helpers: `resolveConflictsKeepIncoming`, `resolveConflictsUnion`, `hasContentfulCanonical`, `looksLikeProse`
- [x] No external deps beyond node:child_process, node:fs, node:path

### Namespace Compatibility
- [x] Add `@mariozechner/*` peerDependencies to package.json
- [x] Verified both resolve at runtime — extension loads in any pi installation

### Tests
- [x] Unit tests for merge resolver helpers (conflict parsing, prose detection) — 18 tests
- [x] All existing 236 tests still pass
- [x] 65 structural checks passing

### Wiring
- [x] Module exported and importable — available for worktree flow integration
- [x] `resolveMerge()` is the public API, called after parallel worktree tasks complete

## Verification
- Commit: `6280bcc` — pushed to `bobbiejaxn/pi-harness` main
- 236 unit tests, 0 fail
- 65 structural checks, 0 fail
