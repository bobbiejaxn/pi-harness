#!/bin/bash
# ──────────────────────────────────────────────────────────────────────────────
# trace-index — Query and rebuild the subagent trace index
# ──────────────────────────────────────────────────────────────────────────────
# Ported from pi_launchpad's scripts/trace-index.sh
#
# Reads manifest files from .pi/traces/runs/ and provides summaries.
#
# Usage:
#   ./scripts/trace-index.sh summary       # Print summary of all runs
#   ./scripts/trace-index.sh failures      # Show runs with failures
#   ./scripts/trace-index.sh costly        # Show most expensive runs
#   ./scripts/trace-index.sh agent <name>  # Show all traces for an agent
#   ./scripts/trace-index.sh rebuild       # Rebuild index from all runs
#
set -euo pipefail

TRACES_DIR="${PI_TRACES_DIR:-/tmp/.pi/traces}"
RUNS_DIR="$TRACES_DIR/runs"
INDEX_FILE="$TRACES_DIR/index.json"

# ── Commands ─────────────────────────────────────────────────────────────────

cmd_summary() {
	echo "╔══════════════════════════════════════════════════════════════╗"
	echo "║  Subagent Trace Summary"
	echo "╚══════════════════════════════════════════════════════════════╝"
	echo ""

	if [ ! -d "$RUNS_DIR" ]; then
		echo "No traces found at $RUNS_DIR"
		return
	fi

	local total_runs=0
	local total_cost=0
	local total_success=0
	local total_fail=0
	local agents=""

	for manifest in "$RUNS_DIR"/*/manifest.json; do
		[ -f "$manifest" ] || continue
		total_runs=$((total_runs + 1))

		local cost=$(jq -r '.totalCost // 0' "$manifest" 2>/dev/null || echo 0)
		total_cost=$(echo "$total_cost + $cost" | bc 2>/dev/null || echo "$total_cost")

		local success=$(jq -r '.successCount // 0' "$manifest" 2>/dev/null || echo 0)
		local fail=$(jq -r '.failCount // 0' "$manifest" 2>/dev/null || echo 0)
		total_success=$((total_success + success))
		total_fail=$((total_fail + fail))

		# Collect agent names
		local task_agents=$(jq -r '.tasks[].agent // empty' "$manifest" 2>/dev/null || echo "")
		agents="$agents $task_agents"
	done

	echo "  Runs:      $total_runs"
	echo "  Successes: $total_success"
	echo "  Failures:  $total_fail"
	echo "  Total cost: \$$(printf '%.4f' "$total_cost" 2>/dev/null || echo "0")"
	echo ""
	echo "  Agents used:"
	echo "$agents" | tr ' ' '\n' | sort | uniq -c | sort -rn | head -10 | while read count agent; do
		[ -n "$agent" ] && echo "    $agent: $count runs"
	done
}

cmd_failures() {
	echo "╔══════════════════════════════════════════════════════════════╗"
	echo "║  Failed Runs"
	echo "╚══════════════════════════════════════════════════════════════╝"
	echo ""

	if [ ! -d "$RUNS_DIR" ]; then
		echo "No traces found."
		return
	fi

	local found=0
	for manifest in "$RUNS_DIR"/*/manifest.json; do
		[ -f "$manifest" ] || continue
		local fail=$(jq -r '.failCount // 0' "$manifest" 2>/dev/null || echo 0)
		if [ "$fail" -gt 0 ]; then
			found=$((found + 1))
			local run_id=$(jq -r '.runId // "unknown"' "$manifest" 2>/dev/null)
			local timestamp=$(jq -r '.timestamp // "unknown"' "$manifest" 2>/dev/null)
			local cost=$(jq -r '.totalCost // 0' "$manifest" 2>/dev/null)
			echo "  Run: $run_id"
			echo "    Time: $timestamp"
			echo "    Cost: \$$cost"
			jq -r '.tasks[] | select(.exitCode != 0) | "    Failed: \(.agent) (exit \(.exitCode))"' "$manifest" 2>/dev/null || true
			echo ""
		fi
	done

	[ "$found" -eq 0 ] && echo "  No failed runs found."
}

cmd_costly() {
	echo "╔══════════════════════════════════════════════════════════════╗"
	echo "║  Most Expensive Runs (top 10)"
	echo "╚══════════════════════════════════════════════════════════════╝"
	echo ""

	if [ ! -d "$RUNS_DIR" ]; then
		echo "No traces found."
		return
	fi

	for manifest in "$RUNS_DIR"/*/manifest.json; do
		[ -f "$manifest" ] || continue
		local run_id=$(jq -r '.runId // "unknown"' "$manifest" 2>/dev/null)
		local cost=$(jq -r '.totalCost // 0' "$manifest" 2>/dev/null)
		local timestamp=$(jq -r '.timestamp // "unknown"' "$manifest" 2>/dev/null)
		local agent=$(jq -r '.tasks[0].agent // "unknown"' "$manifest" 2>/dev/null)
		echo "$cost $run_id $timestamp $agent"
	done | sort -rn | head -10 | while read cost run_id timestamp agent; do
		echo "  \$$cost  $run_id  $agent  ($timestamp)"
	done
}

cmd_agent() {
	local agent_name="${1:-}"
	if [ -z "$agent_name" ]; then
		echo "Usage: trace-index.sh agent <name>"
		exit 1
	fi

	echo "╔══════════════════════════════════════════════════════════════╗"
	echo "║  Traces for agent: $agent_name"
	echo "╚══════════════════════════════════════════════════════════════╝"
	echo ""

	if [ ! -d "$RUNS_DIR" ]; then
		echo "No traces found."
		return
	fi

	local found=0
	for manifest in "$RUNS_DIR"/*/manifest.json; do
		[ -f "$manifest" ] || continue
		local has_agent=$(jq --arg name "$agent_name" '.tasks[].agent | select(. == $name)' "$manifest" 2>/dev/null)
		[ -n "$has_agent" ] || continue
		found=$((found + 1))

		local run_id=$(jq -r '.runId // "unknown"' "$manifest" 2>/dev/null)
		local timestamp=$(jq -r '.timestamp // "unknown"' "$manifest" 2>/dev/null)
		local cost=$(jq -r '.totalCost // 0' "$manifest" 2>/dev/null)
		local exit_code=$(jq -r '.tasks[] | select(.agent == "'"$agent_name"'") | .exitCode' "$manifest" 2>/dev/null | head -1)

		echo "  Run: $run_id"
		echo "    Time: $timestamp"
		echo "    Cost: \$$cost"
		echo "    Exit: $exit_code"
		echo ""
	done

	[ "$found" -eq 0 ] && echo "  No traces found for agent '$agent_name'."
}

cmd_rebuild() {
	echo "Rebuilding trace index..."

	if [ ! -d "$RUNS_DIR" ]; then
		echo "No traces found at $RUNS_DIR"
		exit 0
	fi

	local count=0
	echo '[' > "$INDEX_FILE"
	first=true
	for manifest in "$RUNS_DIR"/*/manifest.json; do
		[ -f "$manifest" ] || continue
		count=$((count + 1))
		if [ "$first" = true ]; then
			first=false
		else
			echo ',' >> "$INDEX_FILE"
		fi
		cat "$manifest" >> "$INDEX_FILE"
	done
	echo ']' >> "$INDEX_FILE"

	echo "Indexed $count runs → $INDEX_FILE"
}

# ── Main ──────────────────────────────────────────────────────────────────────

case "${1:-summary}" in
	summary)   cmd_summary ;;
	failures)  cmd_failures ;;
	costly)    cmd_costly ;;
	agent)     cmd_agent "${2:-}" ;;
	rebuild)   cmd_rebuild ;;
	*)
		echo "Usage: $0 {summary|failures|costly|agent <name>|rebuild}"
		exit 1
		;;
esac
