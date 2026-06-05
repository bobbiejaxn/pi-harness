#!/bin/bash
# ──────────────────────────────────────────────────────────────────────────────
# Live E2E: Cascading Timeout
#
# Spawns a subagent with PI_SUBAGENT_TIMEOUT_MS=3000 (3s).
# The timeout is enforced by execution.ts's cascadeTimer.
# Since we can't guarantee the child runs longer than 3s, this test:
#   1. Verifies the timeout wiring exists (structural)
#   2. Verifies the run completes without hanging (liveness)
#   3. If timeout fires, detects it in output
#
# Exit: 0 = PASS, 1 = FAIL
# ──────────────────────────────────────────────────────────────────────────────
set -uo pipefail

echo "── Cascading Timeout ──"

SRC="/Users/michaelguiao/Projects/active/pi-subagents/src"

# Structural check
if grep -q "cascadeTimer\|cascadeTimeoutMs" "$SRC/runs/foreground/execution.ts"; then
  echo "  ✓ Cascade timer wired in execution.ts"
else
  echo "  ✗ Cascade timer NOT wired"
  exit 1
fi

if grep -q "PI_SUBAGENT_TIMEOUT_MS" "$SRC/shared/cascading-timeout.ts"; then
  echo "  ✓ PI_SUBAGENT_TIMEOUT_MS env var defined"
else
  echo "  ✗ PI_SUBAGENT_TIMEOUT_MS not found"
  exit 1
fi

# Live check: verify the run doesn't hang
OUTFILE="/tmp/e2e-timeout-$(date +%s).jsonl"
trap "rm -f $OUTFILE" EXIT

START_TIME=$(date +%s)

PI_SUBAGENT_TIMEOUT_MS=3000 \
timeout 60 pi --mode json -p --no-session --no-skills \
  "Use the subagent tool with action 'run', agent 'scout', task 'echo hello', agentScope 'both'." \
  > "$OUTFILE" 2>&1 || true

END_TIME=$(date +%s)
ELAPSED=$((END_TIME - START_TIME))

if [ "$ELAPSED" -lt 55 ]; then
  echo "  ✓ Run completed in ${ELAPSED}s (didn't hang)"
else
  echo "  ✗ Run took ${ELAPSED}s (may be stuck)"
  exit 1
fi

# Check for timeout (non-deterministic — model might respond before 3s)
if grep -qi "timeout\|timed out\|SIGTERM" "$OUTFILE"; then
  echo "  ✓ Timeout indication found in output"
else
  echo "  ⚠ No timeout detected (subagent completed before 3s — non-deterministic)"
  echo "    Unit tests verify the timer logic exhaustively."
fi

# Verify subagent was spawned
if grep -q "tool_execution_end" "$OUTFILE"; then
  echo "  ✓ Subagent spawned and returned"
fi

echo "  Done."
exit 0
