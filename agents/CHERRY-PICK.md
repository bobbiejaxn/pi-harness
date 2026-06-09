# Agent Cherry-Pick: pi_launchpad → pi-harness

**Date:** 2026-06-09
**pi_launchpad roster:** 56 agents in `.pi/agents/` + 8 in `.pi/agents/board/` = **64 agents**
**pi-harness roster:** 8 agents (scout, worker, planner, reviewer, researcher, oracle, context-builder, delegate)
**Target:** ~32 agents in pi-harness (down from 64, drop 50% by removing overlap)

## Decision Rules

- **DEDUPE** if two pi_launchpad agents do the same job
- **MERGE** if the only difference is the domain (verifier-*, audit-*) — make ONE generic agent
- **PROMOTE** if the pi_launchpad agent fills a gap not covered by pi-harness's 8
- **DROP** if the agent is a one-off / niche / not worth the maintenance cost
- **PORT** the body, but use `inherit` for `model:` (let parent decide) instead of hardcoding
- **DEFER** to Phase 4 if the agent depends on product-layer features (board, cron, coms-net)

## pi-harness's Canonical 8 (base)

| Agent | Role | Model | Notes |
|---|---|---|---|
| scout | Fast codebase recon, compressed context for handoff | inherit | Already in pi-harness |
| worker | Implementation, executes plans, narrow edits | inherit | Already in pi-harness. **Equivalent to pi_launchpad's `implementer`** — keep one, drop the other |
| planner | Implementation plans from context and requirements | inherit | Already in pi-harness. **Less detailed than pi_launchpad's `architect`** — promote `architect` to canonical |
| reviewer | Code diffs, plans, PR/issue validation | inherit | Already in pi-harness |
| researcher | Web research, synthesis | inherit | Already in pi-harness |
| oracle | High-context decision-consistency, prevents drift | inherit | Already in pi-harness. **No equivalent in pi_launchpad — unique to pi-harness** |
| context-builder | Generates context and meta-prompt from requirements | inherit | Already in pi-harness. **No equivalent in pi_launchpad** |
| delegate | Lightweight subagent that inherits parent | inherit | Already in pi-harness. **No equivalent in pi_launchpad** |

## Cherry-Pick Table

| pi_launchpad agent | Decision | Maps to / Notes |
|---|---|---|
| **adversarial-tester** | DROP | Overlaps with `verifier-ui` adversarial mode |
| **architect** | PROMOTE | Opus-tier detailed planner. Replaces/augments pi-harness's `planner`. Keep as `architect` in pi-harness. |
| **audit-budget** | MERGE → DROPPED | 6 audit-* agents are templated by domain. Drop all 6. Use `verifier-deploy` for budget checks. |
| **audit-compliance** | MERGE → DROPPED | (see above) |
| **audit-creative** | MERGE → DROPPED | (see above) |
| **audit-google** | MERGE → DROPPED | (see above) |
| **audit-meta** | MERGE → DROPPED | (see above) |
| **audit-tracking** | MERGE → DROPPED | (see above) |
| **backend-lead** | DROP | Overlaps with `architect` + `planner`. Distinction (backend vs frontend) is too granular. |
| **board-architect** | DEFER → Phase 4 | Board deliberation feature, not yet in pi-harness |
| **board-ceo** | DEFER → Phase 4 | Same as above |
| **board-contrarian** | DEFER → Phase 4 | Same |
| **board-moonshot** | DEFER → Phase 4 | Same |
| **ceo** | PROMOTE | The autonomous CEO loop. Big flagship agent. Add to pi-harness as `ceo`. |
| **claude-oracle** | MERGE → keep both | The `oracle` agent in pi-harness is similar; `claude-oracle` adds Straico/Claude routing. Promote `claude-oracle` as `oracle-claude` (or fold into `oracle` as model variant). **Decision: keep `oracle` in pi-harness, port `claude-oracle` as model-override variant. Phase 2 work.** |
| **completion-auditor** | PROMOTE | Distinct role: verifies "done" claims against actual evidence. Add to pi-harness. |
| **copy-writer** | PROMOTE | Marketing/copy. Niche but distinct. Add to pi-harness under `writing/` subdir. |
| **creative-strategist** | DROP | Overlaps with `office-hours` and `copy-writer` |
| **cross-model-reviewer** | DROP | Engine can already route review to a different model — no need for a dedicated agent |
| **database-optimizer** | PROMOTE | Distinct skill (SQL/schema/index optimization). Add to pi-harness. |
| **debug-agent** | DROP | Overlaps with `worker` + `fixer` — same job |
| **deep-researcher** | MERGE → keep both | `researcher` (pi-harness) handles deep research. Drop `deep-researcher` to reduce redundancy. **Decision: drop, keep `researcher`.** |
| **dynamic-ceo** | PROMOTE | Strategic layer. Add to pi-harness as `dynamic-ceo`. |
| **dx-advocate** | DEFER → Phase 4 | Board advisor |
| **fixer** | DROP | Overlaps with `worker` |
| **format-adapter** | DROP | One-off utility, not worth an agent slot |
| **frontend-lead** | DROP | Overlaps with `architect` |
| **gate-skeptic** | MERGE → keep both | Evidence-based readiness check. Distinct from `completion-auditor`. Add to pi-harness. |
| **harness-evolver** | PROMOTE | Self-optimization. Add to pi-harness. |
| **idea-capture** | PROMOTE | Lightweight (Haiku) idea capture. Add to pi-harness. |
| **implementer** | DROP (map to `worker`) | `worker` in pi-harness is the canonical implementation agent |
| **issue-creator** | MERGE → DROPPED | Overlaps with `idea-capture` |
| **knowledge-organizer** | PROMOTE | Organizes learnings/docs. Add to pi-harness. |
| **learning-agent** | MERGE → DROPPED | The `session-learner` module in pi-harness's `src/shared/` already does this. No agent needed. |
| **office-hours** | PROMOTE | YC-style product interrogation. Add to pi-harness. |
| **pr-reviewer** | DROP | `reviewer` already handles PRs |
| **product-manager** | PROMOTE | PM interview → USVA spec. Add to pi-harness. |
| **reasoning-researcher** | DROP | Overlaps with `researcher` |
| **release-engineer** | DROP | Niche, not core |
| **researcher** | DROP (pi-harness already has it) | Already in pi-harness |
| **retro** | PROMOTE | Weekly retro. Add to pi-harness. |
| **reviewer** | DROP (pi-harness already has it) | Already in pi-harness |
| **scout** | DROP (pi-harness already has it) | Already in pi-harness |
| **security-advisor** | DEFER → Phase 4 | Board advisor |
| **security-reviewer** | PROMOTE | Security audit. Add to pi-harness. |
| **ship-fast** | DEFER → Phase 4 | Board advisor |
| **software-architect** | MERGE → DROPPED | Overlaps with `architect` (Opus-tier planning). Keep one. |
| **spec-clarifier** | PROMOTE | Pre-flight spec reader, resolves ambiguities. Add to pi-harness. |
| **sre** | DROP | Niche for general harness; project-specific verifiers handle this |
| **tech-debt-auditor** | DEFER → Phase 4 | Board advisor |
| **test-writer** | PROMOTE | E2E tests from spec. Add to pi-harness. |
| **ui-reviewer** | DROP | `reviewer` already covers UI |
| **unit-test-writer** | MERGE → DROPPED | Overlaps with `test-writer`. Or keep both — they target different layers. **Decision: keep both, distinct. PROMOTE both.** |
| **validation-lead** | DROP | Overlaps with `verifier-typescript` |
| **verifier-deploy** | MERGE → keep canonical | One of 5 verifier-* agents. **Decision: keep all 5 as standard instances. They are templated and useful.** Add all to pi-harness under `verifiers/` subdir. |
| **verifier-python** | PROMOTE (keep all verifiers) | (see above) |
| **verifier-sql** | PROMOTE (keep all verifiers) | (see above) |
| **verifier-typescript** | PROMOTE (keep all verifiers) | (see above) |
| **verifier-ui** | PROMOTE (keep all verifiers) | (see above) |
| **visual-designer** | DROP | Too niche for default roster |
| **web-researcher** | DROP (pi-harness's `researcher` does this) | `researcher` in pi-harness already handles web research |
| **worker** | DROP (pi-harness already has it) | Already in pi-harness |

## Final Roster for pi-harness (~32 agents)

**Base (8, already in pi-harness):**
1. scout
2. worker
3. planner
4. reviewer
5. researcher
6. oracle
7. context-builder
8. delegate

**Promoted from pi_launchpad (24):**
9. architect (Opus-tier detailed planner)
10. ceo (autonomous loop)
11. dynamic-ceo (strategic layer)
12. office-hours (product interrogation)
13. spec-clarifier (pre-flight spec reader)
14. product-manager (PM interview → USVA)
15. test-writer (E2E)
16. unit-test-writer (unit/integration)
17. security-reviewer
18. completion-auditor
19. gate-skeptic
20. knowledge-organizer
21. retro
22. idea-capture (Haiku)
23. claude-oracle (model-variant of oracle) — or fold into `oracle` with `model:` override
24. harness-evolver
25. copy-writer
26. database-optimizer
27. verifier-typescript
28. verifier-python
29. verifier-sql
30. verifier-ui
31. verifier-deploy

**Total: 31 agents** (close to target of ~32)

## Verification

After porting, run:
```bash
# pi-harness test suite must stay green
cd /Users/michaelguiao/Projects/active/pi-harness
npm run test:unit
# Expected: 750+ tests pass (existing 750 + any new agent tests)

# All agents must parse
cd /Users/michaelguiao/Projects/pi_launchpad
pi list  # if available
# Or:
ls /Users/michaelguiao/Projects/active/pi-harness/agents/ | wc -l
# Expected: 31
```

## Deferred to Phase 4 (Product Layer)

The 8 board advisors (board-architect, board-ceo, board-contrarian, board-moonshot, dx-advocate, security-advisor, ship-fast, tech-debt-auditor) require the board deliberation feature, which is Phase 4 work. They stay in pi_launchpad for now and get ported when board deliberation lands in pi-harness.
