---
description: Run a structured board deliberation on a question. 8 board advisors debate from competing biases, board-ceo synthesizes into a memo. Use for hard calls that benefit from multi-perspective analysis.
---

Run a board deliberation on the following question:

**Question:** $@

## The Process

You are the moderator. Run the deliberation in 3 phases:

### Phase 1: Independent positions (parallel)

Spawn each of the 8 board advisors via the subagent tool. Each advisor gives a 200-400 word position statement from their unique bias. Run them in parallel:

```json
{
  "agent": "board-architect",
  "task": "Question: $@\n\nGive your position as the long-term design advocate. 200-400 words. Cite specific concerns from the project context.",
  "agentScope": "both"
}
```

(Repeat for: `board-contrarian`, `board-moonshot`, `ship-fast`, `tech-debt-auditor`, `security-advisor`, `dx-advocate`.)

### Phase 2: Targeted rebuttals (sequential, max 2 per advisor)

For each advisor, look at the others' positions. If any advisor's argument directly contradicts another, have them exchange brief rebuttals (100-200 words each). Use your judgment — only invoke a rebuttal if there's a substantive disagreement worth surfacing.

### Phase 3: Synthesis (board-ceo)

Spawn `board-ceo` to synthesize all positions into a single memo:

```json
{
  "agent": "board-ceo",
  "task": "Synthesize the board deliberation below into a single memo. Structure: (1) the decision, (2) the strongest argument for, (3) the strongest argument against, (4) the consensus, (5) the 1-3-1 forks that need human input.\n\nPOSITIONS:\n[insert all 8 advisor positions here]\n\nREBUTTALS:\n[insert any rebuttals here]\n\nQUESTION: $@",
  "agentScope": "both"
}
```

The board-ceo's output IS the final answer. Surface it to the user as the deliberation's conclusion.

## Don't do

- Don't let the deliberation run forever. Cap at 2 rounds of rebuttals.
- Don't let any single advisor's bias dominate — that's why we have 8 competing perspectives.
- Don't present the final answer as if it were your own — frame it as the board's recommendation.
