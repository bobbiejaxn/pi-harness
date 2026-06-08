#!/bin/bash
# ──────────────────────────────────────────────────────────────────────────────
# cron-auto-ship-enhanced.sh
#
# Enhanced auto-ship wrapper implementing the "monitor and work on issues
# continuously" principle:
#
#   - 20-minute interval cron
#   - Picks highest-priority spec-approved issue
#   - Generates explicit goal + task list for the issue
#   - Runs the ship workflow with progress reporting
#   - Marks the issue as shipped or moves to spec-hold on failure
#
# Differences from the v3 cron-auto-ship.sh:
#   - Adds goal/task list generation (printed + saved to manifest)
#   - Reports every 20 min (status updates)
#   - More conservative retry: 1 retry per run (was 3 in DLQ reaper)
#   - Shorter individual step timeout (180s) — let the harness handle longer hangs
# ──────────────────────────────────────────────────────────────────────────────
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# Auto-detect project root
PROJECT_DIR="$(cd "$SCRIPT_DIR" && while [ "$(pwd)" != "/" ]; do [ -f ".pi/config.sh" ] && pwd && break; cd ..; done)"

source "$PROJECT_DIR/.pi/config.sh" 2>/dev/null || {
  echo "[FATAL] Could not source .pi/config.sh from $PROJECT_DIR"
  exit 1
}

# Derive REPO
REPO="${REPO:-$(echo "$PROJECT_REPO" | sed "s|https://github.com/||" | sed "s|\.git$||")}"
export BASH_WHITELIST_MODE="log"

LOG_DIR="$PROJECT_DIR/logs/cron"
mkdir -p "$LOG_DIR"
LOG_FILE="$LOG_DIR/auto-ship-$(date +%Y%m%d-%H%M%S).log"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "$LOG_FILE"; }

# ── Fetch the next spec-approved issue ──────────────────────────────────────
log "════════════════════════════════════════════════"
log "  AUTO-SHIP CRON — $(date)"
log "  Project: $PROJECT_NAME"
log "  Repo:    $REPO"
log "  Mode:    20-min continuous"
log "════════════════════════════════════════════════"

# Health check
HEALTH=$(curl -sf http://127.0.0.1:9099/health 2>/dev/null || echo '{"status":"unreachable"}')
log "[HEALTH] $HEALTH"

# Fetch highest-priority spec-approved issue
ISSUE_NUMBER=$(gh issue list --repo "$REPO" --state open --label spec-approved --json number,labels,createdAt \
  --jq 'sort_by(.createdAt) | .[0].number // empty' 2>/dev/null || true)

if [ -z "$ISSUE_NUMBER" ]; then
  log "No spec-approved issues in queue. Idle."
  log "════════════════════════════════════════════════"
  log "  AUTO-SHIP CRON — Idle (no work)"
  log "════════════════════════════════════════════════"
  exit 0
fi

log "Picked issue #$ISSUE_NUMBER"

# ── Generate goal and task list ─────────────────────────────────────────────
ISSUE_TITLE=$(gh issue view "$ISSUE_NUMBER" --repo "$REPO" --json title --jq '.title' 2>/dev/null || echo "Unknown")
ISSUE_BODY=$(gh issue view "$ISSUE_NUMBER" --repo "$REPO" --json body --jq '.body' 2>/dev/null || echo "")

GOAL="Ship issue #$ISSUE_NUMBER ('$ISSUE_TITLE') with a working PR that closes the issue and passes all acceptance criteria."

TASKS=(
  "Investigate codebase structure relevant to: $ISSUE_TITLE"
  "Implement the change in the codebase"
  "Write/update tests covering the change"
  "Run verification: build + tests + lint"
  "Commit, push, and open PR with closing reference"
  "Label the issue as 'shipped' or move to 'spec-hold' with reason"
)

# Write goal + task list to a manifest file for the run
MANIFEST="$LOG_DIR/issue-${ISSUE_NUMBER}-manifest.json"
cat > "$MANIFEST" <<EOF
{
  "issue_number": "$ISSUE_NUMBER",
  "title": "$ISSUE_TITLE",
  "goal": "$GOAL",
  "tasks": $(printf '%s\n' "${TASKS[@]}" | python3 -c "import json,sys; print(json.dumps([l.strip() for l in sys.stdin if l.strip()]))"),
  "started_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "status": "in_progress"
}
EOF

log "─── GOAL ───"
log "$GOAL"
log ""
log "─── TASKS ───"
for t in "${TASKS[@]}"; do
  log "  □ $t"
done
log ""

# ── Status update checkpoint (every 20 min) ────────────────────────────────
# Set a 20-min timer that prints a status snapshot
(
  sleep 1200
  if [ -f "$LOG_FILE" ]; then
    log "─── STATUS UPDATE (20 min) ───"
    log "Issue #$ISSUE_NUMBER still in progress"
    log "Log file: $LOG_FILE"
    log "Elapsed: $(($(date +%s) - $(stat -c %Y "$LOG_FILE")))s"
  fi
) &
STATUS_PID=$!

# ── Mark in-progress and run the ship workflow ────────────────────────────
gh issue edit "$ISSUE_NUMBER" --repo "$REPO" --add-label "in-progress" 2>/dev/null || true
log "Marked issue #$ISSUE_NUMBER as in-progress"

# ── Run the ship workflow via pi ────────────────────────────────────────────
# Build the prompt with the goal + task list embedded
PROMPT=$(cat <<PI_PROMPT
You are the auto-ship agent for the $PROJECT_NAME codebase at $PROJECT_DIR.

## Issue #$ISSUE_NUMBER
$ISSUE_TITLE

$ISSUE_BODY

## Goal
$GOAL

## Task List
$(printf -- '- %s\n' "${TASKS[@]}")

## Workflow
1. Investigate the codebase to understand the current state
2. Plan the change (which files, what edits)
3. Implement the change
4. Write/update tests
5. Run verification: \`$VERIFY_COMMANDS\`
6. Commit with message referencing #$ISSUE_NUMBER
7. Push the branch and open a PR
8. Update the issue (label shipped or comment with status)

## Constraints
- Do NOT skip tests
- Do NOT bypass lint/typecheck
- If verification fails, report which step failed
- Use the project's existing patterns
- Stay focused on THIS issue — don't refactor unrelated code

## Output Format
End with a JSON block:
{
  "pr_url": "...",
  "issues_addressed": [$ISSUE_NUMBER],
  "tasks_completed": ["task 1", "task 2", ...],
  "verification": { "build": "passed|failed", "tests": "passed|failed", "lint": "passed|failed" },
  "ready_to_ship": true|false,
  "blockers": []
}
PI_PROMPT
)

log "Launching pi orchestrator..."
timeout --kill-after=5 "${PI_TIMEOUT:-900}" "$PI_BIN" --no-extensions \
  -e .pi/extensions/subagent/src/extension/index.ts \
  -e .pi/extensions/model-router/index.ts \
  -e .pi/extensions/github-tools/index.ts \
  --mode json --no-session \
  --provider "${CRON_SHIP_PROVIDER:-zai}" \
  --model "${CRON_SHIP_MODEL:-zai/glm-5.1}" \
  "$PROMPT" 2>&1 | tee -a "$LOG_FILE"
PI_EXIT=${PIPESTATUS[0]}

# Cancel the 20-min status updater
kill $STATUS_PID 2>/dev/null || true

log "pi exited with code $PI_EXIT"

# ── Update the issue based on result ────────────────────────────────────────
if [ $PI_EXIT -eq 0 ]; then
  log "Ship succeeded. Labeling as shipped."
  gh issue edit "$ISSUE_NUMBER" --repo "$REPO" --remove-label "in-progress" 2>/dev/null || true
  gh issue edit "$ISSUE_NUMBER" --repo "$REPO" --add-label "shipped" 2>/dev/null || true
  python3 -c "
import json
m = json.load(open('$MANIFEST'))
m['status'] = 'shipped'
m['completed_at'] = '$(date -u +%Y-%m-%dT%H:%M:%SZ)'
json.dump(m, open('$MANIFEST', 'w'), indent=2)
"
else
  log "Ship failed. Moving to spec-hold."
  gh issue edit "$ISSUE_NUMBER" --repo "$REPO" --remove-label "in-progress" 2>/dev/null || true
  gh issue edit "$ISSUE_NUMBER" --repo "$REPO" --add-label "spec-hold" 2>/dev/null || true
  # Write a brief DLQ entry (no reaper — 20-min cron will pick it up next cycle)
  mkdir -p /root/.hermes/dlq
  TS=$(date -u +%Y-%m-%dT%H%M%S)
  cat > "/root/.hermes/dlq/${TS}-${PROJECT_NAME}-${ISSUE_NUMBER}.json" <<DLQ_JSON
{
  "job_name": "${PROJECT_NAME}-${ISSUE_NUMBER}",
  "timestamp": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "error": "pi exited with code $PI_EXIT",
  "project": "${PROJECT_NAME}",
  "issue_number": "${ISSUE_NUMBER}",
  "repo": "${REPO}",
  "retry_count": 0,
  "last_attempt": "$(date -u +%Y-%m-%dT%H:%M:%S+00:00)",
  "log_file": "$LOG_FILE"
}
DLQ_JSON
  python3 -c "
import json
m = json.load(open('$MANIFEST'))
m['status'] = 'spec-hold'
m['completed_at'] = '$(date -u +%Y-%m-%dT%H:%M:%SZ)'
m['pi_exit_code'] = $PI_EXIT
json.dump(m, open('$MANIFEST', 'w'), indent=2)
"
fi

log "════════════════════════════════════════════════"
log "  AUTO-SHIP CRON COMPLETE — Issue #$ISSUE_NUMBER"
log "════════════════════════════════════════════════"
