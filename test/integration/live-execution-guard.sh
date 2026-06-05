#!/bin/bash
# ──────────────────────────────────────────────────────────────────────────────
# Live E2E: Execution guard kills looping agents
#
# Strategy: Verify the guard module works correctly by simulating
# turn-limit exceeded, repetition detection, and stall detection
# with real timer behavior.
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

echo "── Live E2E: Execution Guard ──"

# Test: Turn limit kills after N+1 turns
cd "$ROOT" && node --experimental-strip-types -e "
import { ExecutionGuard } from './src/shared/execution-guard.ts';
const guard = new ExecutionGuard({ maxTurns: 2, maxRepetitions: 0, stallTimeoutMs: 0 });
const turn = () => ({ type: 'message_end', message: { role: 'assistant', stopReason: 'stop' } });
let a = guard.processEvent(turn()); // turn 1
if (a) process.exit(1);
a = guard.processEvent(turn()); // turn 2
if (a) process.exit(1);
a = guard.processEvent(turn()); // turn 3 = exceeded
if (!a || a.type !== 'kill') process.exit(1);
if (guard.getState().killedBy !== 'turn_limit') process.exit(1);
console.log('OK');
" 2>/dev/null
check "Turn limit kills after N+1 turns" $([ $? -eq 0 ] && echo pass || echo fail)

# Test: Repetition detection kills on identical tool calls
cd "$ROOT" && node --experimental-strip-types -e "
import { ExecutionGuard } from './src/shared/execution-guard.ts';
const guard = new ExecutionGuard({ maxTurns: 0, maxRepetitions: 3, stallTimeoutMs: 0 });
const tool = () => ({ type: 'tool_execution_start', toolName: 'read', args: { path: '/same/file' } });
let a;
for (let i = 0; i < 2; i++) { a = guard.processEvent(tool()); if (a) process.exit(1); }
a = guard.processEvent(tool()); // 3rd = kill
if (!a || a.type !== 'kill') process.exit(1);
if (guard.getState().killedBy !== 'repetition') process.exit(1);
console.log('OK');
" 2>/dev/null
check "Repetition kills after 3 identical tool calls" $([ $? -eq 0 ] && echo pass || echo fail)

# Test: Stall detection fires after timeout
cd "$ROOT" && node --experimental-strip-types -e "
import { ExecutionGuard } from './src/shared/execution-guard.ts';
let killed = false;
const guard = new ExecutionGuard({ maxTurns: 0, maxRepetitions: 0, stallTimeoutMs: 80 });
guard.startStallTimer(() => { killed = true; });
await new Promise(r => setTimeout(r, 200));
if (!killed) process.exit(1);
if (guard.getState().killedBy !== 'stall') process.exit(1);
console.log('OK');
" 2>/dev/null
check "Stall detection fires after timeout" $([ $? -eq 0 ] && echo pass || echo fail)

# Test: Events reset stall timer
cd "$ROOT" && node --experimental-strip-types -e "
import { ExecutionGuard } from './src/shared/execution-guard.ts';
let killed = false;
const guard = new ExecutionGuard({ maxTurns: 0, maxRepetitions: 0, stallTimeoutMs: 100 });
guard.startStallTimer(() => { killed = true; });
// Send events before stall fires
await new Promise(r => setTimeout(r, 40));
guard.processEvent({ type: 'message_end', message: { role: 'assistant' } });
await new Promise(r => setTimeout(r, 40));
guard.processEvent({ type: 'message_end', message: { role: 'assistant' } });
await new Promise(r => setTimeout(r, 40));
if (killed) process.exit(1);
guard.destroy();
console.log('OK');
" 2>/dev/null
check "Events reset stall timer" $([ $? -eq 0 ] && echo pass || echo fail)

# Test: Destroy cancels stall timer
cd "$ROOT" && node --experimental-strip-types -e "
import { ExecutionGuard } from './src/shared/execution-guard.ts';
let killed = false;
const guard = new ExecutionGuard({ stallTimeoutMs: 50 });
guard.startStallTimer(() => { killed = true; });
guard.destroy();
await new Promise(r => setTimeout(r, 150));
if (killed) process.exit(1);
console.log('OK');
" 2>/dev/null
check "Destroy cancels stall timer" $([ $? -eq 0 ] && echo pass || echo fail)

# Test: Guard state snapshots are accurate
cd "$ROOT" && node --experimental-strip-types -e "
import { ExecutionGuard } from './src/shared/execution-guard.ts';
const guard = new ExecutionGuard({ maxTurns: 10, maxRepetitions: 5 });
guard.processEvent({ type: 'message_end', message: { role: 'assistant' } });
guard.processEvent({ type: 'tool_execution_start', toolName: 'read', args: {} });
const state = guard.getState();
if (state.turnCount !== 1) process.exit(1);
if (state.recentToolCalls.length !== 1) process.exit(1);
if (state.killedBy !== null) process.exit(1);
if (!state.active) process.exit(1);
console.log('OK');
" 2>/dev/null
check "Guard state snapshots are accurate" $([ $? -eq 0 ] && echo pass || echo fail)

echo ""
echo "╔══════════════════════════════════════════════════════════════╗"
echo "║  EXECUTION GUARD E2E: $PASS/$TOTAL passed, $FAIL failed"
echo "╚══════════════════════════════════════════════════════════════╝"
[ "$FAIL" -eq 0 ] || exit 1
