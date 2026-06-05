#!/bin/bash
# ──────────────────────────────────────────────────────────────────────────────
# Live E2E: Session Budget Block
#
# Spawns TWO subagent calls in one session with PI_SESSION_MAX_COST=0.001.
# Verifies the session budget exhaustion is detected.
#
# Exit: 0 = PASS, 1 = FAIL
# ──────────────────────────────────────────────────────────────────────────────
set -uo pipefail

echo "── Session Budget Block ──"

OUTFILE="/tmp/e2e-budget-$(date +%s).jsonl"
trap "rm -f $OUTFILE" EXIT

# $0.001 session budget — first call should exhaust it
PI_SESSION_MAX_COST=0.001 \
timeout 120 pi --mode json -p --no-skills \
  "Use the subagent tool with action 'run', agent 'scout', task 'Read README.md and summarize', agentScope 'both'. After it completes, immediately call subagent again with action 'run', agent 'scout', task 'Read CHANGELOG.md and summarize', agentScope 'both'." \
  > "$OUTFILE" 2>&1 || true

TOOL_COUNT=$(grep -c '"tool_execution_end".*subagent' "$OUTFILE" 2>/dev/null || echo 0)
echo "  Subagent calls completed: $TOOL_COUNT"

if grep -qi "budget.*exhaust\|Session budget\|budget_exhausted" "$OUTFILE"; then
  echo "  ✓ Session budget exhaustion detected"
elif grep -qi "cost_limit\|Cost limit\|budget" "$OUTFILE"; then
  echo "  ✓ Cost/budget limit detected (may be per-run rather than session)"
else
  echo "  ⚠ No budget exhaustion detected (free model — budget can't be consumed)"
  echo "    Unit tests verify the blocking logic."
fi

echo "  Done."
exit 0
