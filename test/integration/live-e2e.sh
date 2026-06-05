#!/bin/bash
# ──────────────────────────────────────────────────────────────────────────────
# Live E2E: Full Pipeline
#
# Spawns ONE pi process that calls a subagent, then verifies:
#   1. Stream events (tool_execution_start/update/end, message_end, agent_end)
#   2. Usage stats in result
#   3. Manifest written with all required fields
#   4. PID files cleaned up
#   5. Cost guard env var is read by the extension
#   6. Timeout config env var is read by the extension
#
# Exit: 0 = PASS, 1 = FAIL
# ──────────────────────────────────────────────────────────────────────────────
set -uo pipefail

PASS=0
FAIL=0
TOTAL=0

check() {
  local name="$1"
  local result="$2"
  TOTAL=$((TOTAL + 1))
  if [ "$result" = "pass" ]; then
    PASS=$((PASS + 1))
    echo "  ✓ $name"
  else
    FAIL=$((FAIL + 1))
    echo "  ✗ $name"
  fi
}

OUTFILE="/tmp/e2e-live-$(date +%s).jsonl"
trap "rm -f $OUTFILE" EXIT

echo "── Spawning live subagent ──"

# Run with both cost and timeout env vars set (high limits so they don't kill the test)
PI_SUBAGENT_MAX_COST=10 \
PI_SESSION_MAX_COST=50 \
PI_SUBAGENT_TIMEOUT_MS=300000 \
timeout 60 pi --mode json -p --no-session --no-skills \
  "Use the subagent tool with action 'run', agent 'scout', task 'List files in the current directory and count them', agentScope 'both'." \
  > "$OUTFILE" 2>&1 || true

echo ""
echo "── Stream events ──"

# tool_execution_start
grep -q '"type":"tool_execution_start"' "$OUTFILE" && check "tool_execution_start" "pass" || check "tool_execution_start" "fail"

# tool_execution_update (progress)
grep -q '"type":"tool_execution_update"' "$OUTFILE" && check "tool_execution_update (progress)" "pass" || check "tool_execution_update" "fail"

# tool_execution_end
grep -q '"type":"tool_execution_end"' "$OUTFILE" && check "tool_execution_end" "pass" || check "tool_execution_end" "fail"

# message_end
grep -q '"type":"message_end"' "$OUTFILE" && check "message_end" "pass" || check "message_end" "fail"

echo ""
echo "── Usage stats ──"
grep -q '"usage":{' "$OUTFILE" && check "Usage stats in result" "pass" || check "Usage stats" "fail"

echo ""
echo "── Manifest ──"

# Find latest manifest
LATEST=$(ls -td /tmp/.pi/traces/runs/*/ 2>/dev/null | head -1)
if [ -n "$LATEST" ] && [ -f "${LATEST}manifest.json" ]; then
  check "Manifest file exists" "pass"
  M="${LATEST}manifest.json"
  for field in runId timestamp mode agent taskCount successCount totalCost tasks; do
    jq -e ".${field} != null" "$M" >/dev/null 2>&1 && check "manifest.${field}" "pass" || check "manifest.${field}" "fail"
  done
  # Check tasks array has at least one entry
  TASK_COUNT=$(jq '.tasks | length' "$M" 2>/dev/null || echo 0)
  [ "$TASK_COUNT" -ge 1 ] && check "manifest.tasks has entries ($TASK_COUNT)" "pass" || check "manifest.tasks entries" "fail"
  # Check tasks have required fields
  jq -e '.tasks[0].agent' "$M" >/dev/null 2>&1 && check "task.agent" "pass" || check "task.agent" "fail"
  jq -e '.tasks[0].exitCode' "$M" >/dev/null 2>&1 && check "task.exitCode" "pass" || check "task.exitCode" "fail"
  jq -e '.tasks[0].durationMs' "$M" >/dev/null 2>&1 && check "task.durationMs" "pass" || check "task.durationMs" "fail"
else
  check "Manifest file exists" "fail"
fi

echo ""
echo "── PID cleanup ──"
STALE=$(find ~/.pi/agents-live -name "*.pid" -newer "$OUTFILE" 2>/dev/null | wc -l | tr -d ' ')
[ "$STALE" -eq 0 ] && check "PID files cleaned up" "pass" || check "PID files cleaned up ($STALE remain)" "fail"

echo ""
echo "── Cost guard config resolution ──"
# Verify the extension reads the env var (checked via unit tests, but verify the source path)
SRC="/Users/michaelguiao/Projects/active/pi-subagents/src"
grep -q "PI_SUBAGENT_MAX_COST" "$SRC/shared/cost-guard.ts" && check "Cost guard env var in source" "pass" || check "Cost guard env var" "fail"
grep -q "resolveCostGuardConfig" "$SRC/extension/index.ts" && check "resolveCostGuardConfig called" "pass" || check "resolveCostGuardConfig" "fail"

echo ""
echo "── Timeout config resolution ──"
grep -q "PI_SUBAGENT_TIMEOUT_MS" "$SRC/shared/cascading-timeout.ts" && check "Timeout env var in source" "pass" || check "Timeout env var" "fail"
grep -q "resolveTimeoutConfig" "$SRC/extension/index.ts" && check "resolveTimeoutConfig called" "pass" || check "resolveTimeoutConfig" "fail"

echo ""
echo "╔══════════════════════════════════════════════════════════════╗"
echo "║  LIVE E2E: $PASS/$TOTAL passed, $FAIL failed"
echo "╚══════════════════════════════════════════════════════════════╝"

[ "$FAIL" -eq 0 ] && exit 0 || exit 1
