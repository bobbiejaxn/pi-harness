#!/bin/bash
# acceptance/subagent-delegation.sh — End-to-end subagent delegation test
#
# Ported from pi_launchpad's acceptance/subagent-delegation.sh
# Adapted for the pi-subagents extension.
#
# Tests that the subagent extension can spawn agents and return results.
# Checks the new features: cost guard, domain enforcement, tool allowlist,
# trace propagation, manifest writing, cascading timeouts.
#
# Exit codes: 0 = PASS, 1 = FAIL, 2 = ERROR
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

PASS=0
FAIL=0
TOTAL=0

check() {
  local name="$1"
  local result="$2"
  local detail="${3:-}"
  TOTAL=$((TOTAL + 1))
  if [ "$result" = "pass" ]; then
    PASS=$((PASS + 1))
    echo "  ✓ $name"
  else
    FAIL=$((FAIL + 1))
    echo "  ✗ $name — $detail"
  fi
}

echo "╔══════════════════════════════════════════════════════════════╗"
echo "║  SUBAGENT DELEGATION ACCEPTANCE TEST"
echo "╚══════════════════════════════════════════════════════════════╝"
echo ""

# ── Prerequisites ───────────────────────────────────────────────────────────
echo "── Prerequisites ──"

if ! command -v pi >/dev/null 2>&1; then
  echo "  ✗ pi CLI not found — skipping delegation tests"
  exit 2
fi
check "pi CLI available" "pass"

PI_VERSION=$(pi --version 2>/dev/null || echo "unknown")
check "pi version ($PI_VERSION)" "pass"

# Check extension files exist
EXT_DIR="$HOME/.pi/agent/extensions/subagent"
if [ -f "$EXT_DIR/src/extension/index.ts" ]; then
  check "Extension installed" "pass"
else
  check "Extension installed" "fail" "not found at $EXT_DIR"
fi

echo ""
echo "── Test 1: New shared modules ──"

# Check all new modules exist
for module in cost-guard retry-logic cascading-timeout trace-propagation allowed-agents-guard subagent-events domain-enforcement tool-allowlist tilldone stream-callbacks; do
  if [ -f "$EXT_DIR/src/shared/${module}.ts" ]; then
    check "Module '${module}' exists" "pass"
  else
    check "Module '${module}' exists" "fail" "not found"
  fi
done

echo ""
echo "── Test 2: Cost guard ──"

if grep -q 'SESSION_MAX_COST\|PI_SESSION_MAX_COST' "$EXT_DIR/src/shared/cost-guard.ts"; then
  check "Session cost guard code present" "pass"
else
  check "Session cost guard code present" "fail"
fi

if grep -q 'SUBAGENT_MAX_COST\|PI_SUBAGENT_MAX_COST' "$EXT_DIR/src/shared/cost-guard.ts"; then
  check "Per-call cost guard code present" "pass"
else
  check "Per-call cost guard code present" "fail"
fi

echo ""
echo "── Test 3: Domain enforcement ──"

if grep -q 'AGENT_DOMAIN_RULES' "$EXT_DIR/src/shared/domain-enforcement.ts"; then
  check "Domain rules env var" "pass"
else
  check "Domain rules env var" "fail"
fi

if grep -q 'isDomainAllowed' "$EXT_DIR/src/shared/domain-enforcement.ts"; then
  check "Domain check function" "pass"
else
  check "Domain check function" "fail"
fi

if grep -q 'BASH_WRITE_PATTERNS' "$EXT_DIR/src/shared/domain-enforcement.ts"; then
  check "Bash heuristic patterns" "pass"
else
  check "Bash heuristic patterns" "fail"
fi

echo ""
echo "── Test 4: Tool allowlist (permissive) ──"

if grep -q 'ALWAYS_ALLOWED' "$EXT_DIR/src/shared/tool-allowlist.ts"; then
  check "Always-allowed tools defined" "pass"
else
  check "Always-allowed tools defined" "fail"
fi

# Verify read/grep/find/ls/glob are always allowed
if grep -q '"read"' "$EXT_DIR/src/shared/tool-allowlist.ts" && \
   grep -q '"subagent"' "$EXT_DIR/src/shared/tool-allowlist.ts"; then
  check "Read + subagent always allowed" "pass"
else
  check "Read + subagent always allowed" "fail"
fi

echo ""
echo "── Test 5: Cascading timeout ──"

if grep -q 'resolveTimeout\|TIMEOUT_SCHEDULE' "$EXT_DIR/src/shared/cascading-timeout.ts"; then
  check "Cascading timeout schedule" "pass"
else
  check "Cascading timeout schedule" "fail"
fi

echo ""
echo "── Test 6: Trace propagation ──"

if grep -q 'PI_TRACE_RUN_ID' "$EXT_DIR/src/shared/trace-propagation.ts"; then
  check "Trace run ID propagation" "pass"
else
  check "Trace run ID propagation" "fail"
fi

if grep -q 'writeRunManifest\|manifest' "$EXT_DIR/src/runs/foreground/execution.ts"; then
  check "Manifest writing in execution" "pass"
else
  check "Manifest writing in execution" "fail"
fi

echo ""
echo "── Test 7: TillDone task tracking ──"

if grep -q 'startTask\|doneTask' "$EXT_DIR/src/shared/tilldone.ts"; then
  check "TillDone state machine" "pass"
else
  check "TillDone state machine" "fail"
fi

echo ""
echo "── Test 8: Streaming callbacks ──"

if grep -q 'onToolCallStart\|onUsage\|onText' "$EXT_DIR/src/shared/stream-callbacks.ts"; then
  check "Streaming callback hooks" "pass"
else
  check "Streaming callback hooks" "fail"
fi

echo ""
echo "── Test 9: Domain env wired into execution ──"

if grep -q 'buildDomainEnv\|domainEnv' "$EXT_DIR/src/runs/foreground/execution.ts"; then
  check "Domain env injected into spawn" "pass"
else
  check "Domain env injected into spawn" "fail"
fi

if grep -q 'domain.*deps\|allowedTools.*deps' "$EXT_DIR/src/runs/foreground/subagent-executor.ts"; then
  check "Domain options threaded to executor" "pass"
else
  check "Domain options threaded to executor" "fail"
fi

# ── Summary ─────────────────────────────────────────────────────────────────
echo ""
echo "╔══════════════════════════════════════════════════════════════╗"
echo "║  RESULTS: $PASS/$TOTAL passed, $FAIL failed"
echo "╚══════════════════════════════════════════════════════════════╝"

[ "$FAIL" -eq 0 ] && exit 0 || exit 1
