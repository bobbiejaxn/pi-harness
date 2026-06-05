#!/bin/bash
# ──────────────────────────────────────────────────────────────────────────────
# Structural Tests: Verify all modules are wired correctly in source code
#
# No pi processes spawned. Pure code analysis. Runs in <5s.
#
# Exit: 0 = PASS, 1 = FAIL
# ──────────────────────────────────────────────────────────────────────────────
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SRC="/Users/michaelguiao/Projects/active/pi-subagents/src"
SHARED="$SRC/shared"
EXEC="$SRC/runs/foreground/execution.ts"
EXECUTOR="$SRC/runs/foreground/subagent-executor.ts"
EXT="$SRC/extension/index.ts"
TYPES="$SRC/shared/types.ts"

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

echo "── Module existence ──"
for mod in cost-guard retry-logic cascading-timeout trace-propagation allowed-agents-guard subagent-events domain-enforcement tool-allowlist tilldone stream-callbacks; do
  [ -f "$SHARED/${mod}.ts" ] && check "$mod.ts" "pass" || check "$mod.ts" "fail" "not found"
done

echo ""
echo "── Domain enforcement wiring ──"
grep -q "AGENT_DOMAIN_RULES" "$SHARED/domain-enforcement.ts" && check "AGENT_DOMAIN_RULES defined" "pass" || check "AGENT_DOMAIN_RULES" "fail"
grep -q "isDomainAllowed" "$SHARED/domain-enforcement.ts" && check "isDomainAllowed function" "pass" || check "isDomainAllowed" "fail"
grep -q "BASH_WRITE_PATTERNS" "$SHARED/domain-enforcement.ts" && check "Bash heuristic patterns" "pass" || check "Bash patterns" "fail"
grep -q "buildDomainEnv" "$SHARED/domain-enforcement.ts" && check "buildDomainEnv function" "pass" || check "buildDomainEnv" "fail"
grep -q "buildDomainEnv\|domainEnv" "$EXEC" && check "Domain env in execution.ts" "pass" || check "Domain in execution.ts" "fail"
grep -q "domain.*ExecutorDeps\|domain\?:.*domain" "$EXECUTOR" && check "Domain in ExecutorDeps" "pass" || check "Domain in ExecutorDeps" "fail"
grep -q "domain.*config\|config.*domain" "$EXT" && check "Domain in extension/index.ts" "pass" || check "Domain in extension" "fail"

echo ""
echo "── Tool allowlist (permissive) ──"
for tool in read grep find ls glob subagent; do
  grep -q "\"$tool\"" "$SHARED/tool-allowlist.ts" && check "'$tool' always-allowed" "pass" || check "'$tool' always-allowed" "fail"
done
grep -q "AGENT_ALLOWED_TOOLS" "$SHARED/tool-allowlist.ts" && check "AGENT_ALLOWED_TOOLS env var" "pass" || check "AGENT_ALLOWED_TOOLS" "fail"
grep -q "active: false\|!allowlist.active" "$SHARED/tool-allowlist.ts" && check "Permissive default" "pass" || check "Permissive default" "fail"

echo ""
echo "── Cost guard ──"
grep -q "PI_SUBAGENT_MAX_COST" "$SHARED/cost-guard.ts" && check "PI_SUBAGENT_MAX_COST" "pass" || check "PI_SUBAGENT_MAX_COST" "fail"
grep -q "PI_SESSION_MAX_COST" "$SHARED/cost-guard.ts" && check "PI_SESSION_MAX_COST" "pass" || check "PI_SESSION_MAX_COST" "fail"
grep -q "SessionCostTracker" "$SHARED/cost-guard.ts" && check "SessionCostTracker" "pass" || check "SessionCostTracker" "fail"
grep -q "costGuard\|cost_limit" "$EXEC" && check "Cost guard in execution.ts" "pass" || check "Cost guard wired" "fail"

echo ""
echo "── Cascading timeout ──"
grep -q "PI_SUBAGENT_TIMEOUT_MS" "$SHARED/cascading-timeout.ts" && check "PI_SUBAGENT_TIMEOUT_MS" "pass" || check "PI_SUBAGENT_TIMEOUT_MS" "fail"
grep -q "cascadeTimer\|cascadeTimeoutMs" "$EXEC" && check "Cascade timer in execution.ts" "pass" || check "Cascade timer" "fail"
grep -q "resolveTimeout" "$SHARED/cascading-timeout.ts" && check "resolveTimeout function" "pass" || check "resolveTimeout" "fail"

echo ""
echo "── Trace propagation ──"
grep -q "PI_TRACE_RUN_ID" "$SHARED/trace-propagation.ts" && check "PI_TRACE_RUN_ID" "pass" || check "PI_TRACE_RUN_ID" "fail"
grep -q "writeRunManifest\|writePidFile" "$EXEC" && check "Manifest + PID in execution.ts" "pass" || check "Manifest/PID wired" "fail"
grep -q "buildTraceEnv" "$EXEC" && check "Trace env in execution.ts" "pass" || check "Trace env wired" "fail"

echo ""
echo "── TillDone ──"
for fn in createState addTask startTask doneTask clearState; do
  grep -q "export function $fn" "$SHARED/tilldone.ts" && check "$fn()" "pass" || check "$fn()" "fail"
done

echo ""
echo "── Stream callbacks ──"
for fn in createStreamProcessor StreamCallbacks onToolCallStart onUsage; do
  grep -q "$fn" "$SHARED/stream-callbacks.ts" && check "$fn" "pass" || check "$fn" "fail"
done

echo ""
echo "── Child domain guard ──"
if [ -f "$SRC/runs/foreground/child-domain-guard.ts" ]; then
  check "child-domain-guard.ts exists" "pass"
  grep -q 'pi.on("tool_call"' "$SRC/runs/foreground/child-domain-guard.ts" && check "Hooks pi.on(tool_call)" "pass" || check "Hooks pi.on(tool_call)" "fail"
  grep -q 'AGENT_DOMAIN_RULES' "$SRC/runs/foreground/child-domain-guard.ts" && check "Reads AGENT_DOMAIN_RULES" "pass" || check "Reads AGENT_DOMAIN_RULES" "fail"
  grep -q 'AGENT_EXPERTISE' "$SRC/runs/foreground/child-domain-guard.ts" && check "Reads AGENT_EXPERTISE" "pass" || check "Reads AGENT_EXPERTISE" "fail"
  grep -q 'AGENT_ALLOWED_TOOLS' "$SRC/runs/foreground/child-domain-guard.ts" && check "Reads AGENT_ALLOWED_TOOLS" "pass" || check "Reads AGENT_ALLOWED_TOOLS" "fail"
  grep -q 'BASH_WRITE_PATTERNS\|BASH_DELETE_PATTERNS' "$SRC/runs/foreground/child-domain-guard.ts" && check "Bash heuristic patterns" "pass" || check "Bash heuristics" "fail"
  grep -q 'CHILD_DOMAIN_GUARD_PATH' "$SRC/runs/foreground/execution.ts" && check "Guard path in execution.ts" "pass" || check "Guard path in execution.ts" "fail"
  grep -q 'domainGuardArgs' "$SRC/runs/foreground/execution.ts" && check "Guard injected into baseArgs" "pass" || check "Guard in baseArgs" "fail"
else
  check "child-domain-guard.ts exists" "fail"
fi

echo ""
echo "── Config types ──"
grep -q "domain.*DomainRule\|allowedTools" "$TYPES" && check "domain/allowedTools in types" "pass" || check "types" "fail"
grep -q "cost.*CostGuard\|retry.*Retry\|timeout.*Timeout" "$TYPES" && check "cost/retry/timeout in types" "pass" || check "cost/retry/timeout types" "fail"
grep -q "tracePropagation\|emitLifecycleEvents" "$TYPES" && check "trace/events in types" "pass" || check "trace/events types" "fail"

echo ""
echo "╔══════════════════════════════════════════════════════════════╗"
echo "║  STRUCTURAL: $PASS/$TOTAL passed, $FAIL failed"
echo "╚══════════════════════════════════════════════════════════════╝"

[ "$FAIL" -eq 0 ] && exit 0 || exit 1
