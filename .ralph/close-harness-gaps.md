
# Close pi-harness gaps for drop-in readiness

## Goal
Make pi-harness a complete drop-in replacement for ivi's subagent extension by closing 2 gaps:
1. **Merge resolver** — tiered conflict resolution for worktree merges
2. **Namespace compatibility** — support both `@mariozechner/*` and `@earendil-works/*` imports

## Checklist

### Merge Resolver (`src/shared/merge-resolver.ts`)
- [ ] Port ivi's 4-tier merge resolver (clean → auto → AI → reimagine)
- [ ] Types: `ResolutionTier`, `MergeResolutionResult`, `MergeResolverOptions`
- [ ] Tier 1: clean merge (git merge --no-edit)
- [ ] Tier 2: auto-resolve (parse conflict markers, keep incoming)
- [ ] Tier 3: AI-resolve (spawn pi subprocess for LLM resolution)
- [ ] Tier 4: reimagine (abort, reimplement from scratch via LLM)
- [ ] Export helpers: `resolveConflictsKeepIncoming`, `resolveConflictsUnion`, `hasContentfulCanonical`, `looksLikeProse`
- [ ] No external deps beyond node:child_process, node:fs, node:path

### Namespace Compatibility
- [ ] Add `@mariozechner/*` peerDependencies to package.json
- [ ] Create type shims if needed (or verify both resolve to same global)

### Tests
- [ ] Unit tests for merge resolver helpers (conflict parsing, prose detection)
- [ ] Unit tests for merge resolver tiers (mock git)
- [ ] All existing 218 tests still pass

### Wiring
- [ ] Wire merge resolver into worktree flow (after parallel tasks complete)
- [ ] Export from types/config if needed
