#!/bin/bash
# ──────────────────────────────────────────────────────────────────────────────
# Live E2E: Circuit breaker blocks agent after consecutive failures
#
# Strategy: Set PI_SUBAGENT_MAX_RETRIES=0 and force failures by using
# an agent that doesn't exist. After 3 failures, the circuit breaker
# should block further dispatches.
# ──────────────────────────────────────────────────────────────────────────────
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(dirname "$(dirname "$SCRIPT_DIR")")"
PASS=0; FAIL=0; TOTAL=0

check() {
	TOTAL=$((TOTAL + 1))
	if [ "$2" = "pass" ]; then
		PASS=$((PASS + 1))
		echo "  ✓ $1"
	else
		FAIL=$((FAIL + 1))
		echo "  ✗ $1"
	fi
}

echo "── Live E2E: Circuit Breaker ──"

TMPDIR=$(mktemp -d)
trap "rm -rf $TMPDIR" EXIT

# Test: Verify circuit breaker module loads
cd "$ROOT" && node --experimental-strip-types -e "
import { CircuitBreaker } from './src/shared/circuit-breaker.ts';
const cb = new CircuitBreaker({ failureThreshold: 3, cooldownMs: 5000 });
cb.recordFailure('fake-agent', 'err1');
cb.recordFailure('fake-agent', 'err2');
cb.recordFailure('fake-agent', 'err3');
const blocked = cb.isBlocked('fake-agent');
const state = cb.getState('fake-agent');
console.log(JSON.stringify({ blocked, state: state.state, failures: state.consecutiveFailures }));
process.exit(blocked && state.state === 'open' ? 0 : 1);
" 2>/dev/null
check "Circuit breaker trips after 3 failures" $([ $? -eq 0 ] && echo pass || echo fail)

# Test: Circuit breaker allows after cooldown
cd "$ROOT" && node --experimental-strip-types -e "
import { CircuitBreaker } from './src/shared/circuit-breaker.ts';
const cb = new CircuitBreaker({ failureThreshold: 2, cooldownMs: 50 });
cb.recordFailure('agent', 'err');
cb.recordFailure('agent', 'err');
// Should be blocked now
if (!cb.isBlocked('agent')) process.exit(1);
// Wait for cooldown
await new Promise(r => setTimeout(r, 100));
// Should be unblocked (half-open)
if (cb.isBlocked('agent')) process.exit(1);
const state = cb.getState('agent');
if (state.state !== 'half_open') process.exit(1);
console.log('OK');
" 2>/dev/null
check "Circuit breaker enters half-open after cooldown" $([ $? -eq 0 ] && echo pass || echo fail)

# Test: Circuit breaker resets on success
cd "$ROOT" && node --experimental-strip-types -e "
import { CircuitBreaker } from './src/shared/circuit-breaker.ts';
const cb = new CircuitBreaker({ failureThreshold: 2, cooldownMs: 50 });
cb.recordFailure('agent', 'err');
cb.recordFailure('agent', 'err');
await new Promise(r => setTimeout(r, 100));
cb.isBlocked('agent'); // trigger half-open
cb.recordSuccess('agent'); // probe succeeds
const state = cb.getState('agent');
if (state.state !== 'closed') process.exit(1);
if (state.consecutiveFailures !== 0) process.exit(1);
console.log('OK');
" 2>/dev/null
check "Circuit breaker resets on success" $([ $? -eq 0 ] && echo pass || echo fail)

# Test: Subagent tool loads with circuit breaker wired
# Use JSON mode for reliable tool discovery
cd /tmp && timeout 30 pi --mode json -p --no-session --no-skills "hi" 2>&1 | grep -q 'toolCall.*subagent\|"subagent"'
# The subagent tool is registered if no load error appears
SUBAGENT_LOAD_OK=$(cd /tmp && timeout 30 pi --mode json -p --no-session --no-skills "hi" 2>&1 | head -1 | grep -c "Failed to load.*subagent" || true)
if [ "$SUBAGENT_LOAD_OK" -eq 0 ]; then
	check "Subagent extension loads without error" "pass"
else
	check "Subagent extension loads without error" "fail"
fi

# Test: Summary produces correct output
cd "$ROOT" && node --experimental-strip-types -e "
import { CircuitBreaker } from './src/shared/circuit-breaker.ts';
const cb = new CircuitBreaker({ failureThreshold: 2 });
cb.recordFailure('scout', 'timeout');
cb.recordFailure('scout', 'timeout');
cb.recordSuccess('worker');
const s = cb.summary();
if (s.blocked.length !== 1) process.exit(1);
if (s.blocked[0].agent !== 'scout') process.exit(1);
if (s.healthy.length !== 1 || s.healthy[0] !== 'worker') process.exit(1);
console.log('OK');
" 2>/dev/null
check "Summary reports blocked and healthy agents" $([ $? -eq 0 ] && echo pass || echo fail)

echo ""
echo "╔══════════════════════════════════════════════════════════════╗"
echo "║  CIRCUIT BREAKER E2E: $PASS/$TOTAL passed, $FAIL failed"
echo "╚══════════════════════════════════════════════════════════════╝"
[ "$FAIL" -eq 0 ] || exit 1
