#!/bin/bash
# ──────────────────────────────────────────────────────────────────────────────
# Run All Integration Tests
#
# Tier 1: Structural (fast, <5s, no pi process)
# Tier 2: Live E2E (spawns real pi processes, ~60-90s each)
#
# Exit: 0 = all pass, 1 = any fail
# ──────────────────────────────────────────────────────────────────────────────
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

PASS=0
FAIL=0
TOTAL=0

run_test() {
  local name="$1"
  local script="$2"
  local timeout_s="${3:-120}"

  TOTAL=$((TOTAL + 1))
  echo ""
  echo "───────────────────────────────────────────────────────────"
  echo "  [$TOTAL] $name"
  echo "───────────────────────────────────────────────────────────"

  START=$(date +%s)
  if timeout "$timeout_s" bash "$script" 2>&1; then
    PASS=$((PASS + 1))
    END=$(date +%s)
    echo "  ▶ PASS ($((END - START))s)"
  else
    FAIL=$((FAIL + 1))
    END=$(date +%s)
    echo "  ▶ FAIL ($((END - START))s)"
  fi
}

echo "╔══════════════════════════════════════════════════════════════╗"
echo "║  pi-subagents Integration Test Suite"
echo "╚══════════════════════════════════════════════════════════════╝"
echo ""

echo "═══════════════════ TIER 1: Structural (fast) ═══════════════════"
run_test "Structural Wiring" "$SCRIPT_DIR/structural.sh" 10

echo ""
echo "═══════════════════ TIER 2: Live E2E ═══════════════════"
run_test "Full Pipeline E2E" "$SCRIPT_DIR/live-e2e.sh" 90
run_test "Cost Guard Kill" "$SCRIPT_DIR/live-cost-guard.sh" 120
run_test "Cascading Timeout" "$SCRIPT_DIR/live-timeout.sh" 120
run_test "Session Budget" "$SCRIPT_DIR/live-session-budget.sh" 150

# ── Summary ──────────────────────────────────────────────────────────────────
echo ""
echo "╔══════════════════════════════════════════════════════════════╗"
echo "║  RESULTS: $PASS/$TOTAL passed, $FAIL failed"
echo "╚══════════════════════════════════════════════════════════════╝"

[ "$FAIL" -eq 0 ] && exit 0 || exit 1
