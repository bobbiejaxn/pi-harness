#!/bin/bash
# ──────────────────────────────────────────────────────────────────────────────
# Full pi-harness migration — v2
#
# Steps per project:
#   1. Remove old subagent files (worktree.ts, merge-resolver.ts, etc.)
#   2. Remove redundant extensions (domain-enforcer, mid-session-learning)
#   3. Clone pi-harness from GitHub
#   4. npm install
#   5. Write project-specific config.json
#   6. Patch cron scripts to use the new entry path
#   7. Commit the cron script changes (prevent future reverts)
# ──────────────────────────────────────────────────────────────────────────────
set -uo pipefail

PROJECTS_DIR="/root/projects/active"
TIMESTAMP=$(date +%Y%m%d-%H%M%S)
PI_HARNESS_REPO="https://github.com/bobbiejaxn/pi-harness.git"

# New subagent entry path that pi-harness uses
NEW_PATH="src/extension/index.ts"

# Old path the crons currently use
OLD_PATH="index.ts"

PASS=0
FAIL=0
SKIP=0

# Per-project harness config (timing tuned per project)
write_config() {
  local proj="$1"
  local ext_dir="$2"
  cat > "$ext_dir/config.json" << 'EOF'
{
  "comment": "pi-harness config. Tuned to complement cron-auto-ship.sh timing: PI_TIMEOUT=900s, PI_SUBAGENT_TIMEOUT_MS=600s, PI_STEP_TIMEOUT=300s. Strictest layer wins — execution guard kills stuck subagents BEFORE the 600s subagent timeout fires.",
  "cost": {
    "maxPerRun": 0.50,
    "maxSessionBudget": 2.00
  },
  "retry": {
    "maxRetries": 2,
    "baseMs": 1000,
    "maxMs": 30000
  },
  "timeout": {
    "cascadeEnabled": true,
    "baseMs": 540000
  },
  "executionGuard": {
    "maxTurns": 30,
    "maxRepetitions": 3,
    "stallTimeoutMs": 180000
  },
  "circuitBreaker": {
    "failureThreshold": 3,
    "cooldownMs": 30000,
    "maxCooldownMs": 300000
  },
  "mergeResolver": {
    "aiResolveEnabled": false,
    "reimagineEnabled": false
  }
}
EOF
}

# Patch cron scripts to use the new entry path
patch_cron_scripts() {
  local proj_dir="$1"
  local scripts_dir="$proj_dir/.pi/scripts"
  local patched=0

  for script in "$scripts_dir"/cron-*.sh; do
    [ -f "$script" ] || continue
    # Replace old path with new path
    if grep -q "extensions/subagent/$OLD_PATH" "$script" 2>/dev/null; then
      sed -i "s|extensions/subagent/$OLD_PATH|extensions/subagent/$NEW_PATH|g" "$script"
      patched=$((patched + 1))
      echo "    ✓ patched $(basename $script)"
    fi
  done

  return $patched
}

# Commit the patched cron scripts so the change sticks
commit_cron_changes() {
  local proj_dir="$1"
  cd "$proj_dir" || return 1

  # Check if there are uncommitted changes to cron scripts
  if git status --porcelain 2>/dev/null | grep -q "\.pi/scripts/cron-"; then
    git add ".pi/scripts/cron-*.sh" 2>/dev/null
    git -c user.email="hermes@hostinger" -c user.name="Hermes Migration" \
      commit -m "fix(cron): point to pi-harness entry path src/extension/index.ts

The pi-harness subagent extension entry moved from subagent/index.ts
to subagent/src/extension/index.ts. Cron scripts must reference the new
path or they fail to load the extension.

This commit is the migration marker — it must not be reverted without
also reverting the extension to the old layout." 2>&1 | head -1
    return 0
  fi
  return 1
}

# List of projects to migrate
PROJECTS=(
  "resiliently-ai"
  "debored-ai"
  "lillylegend"
  "tutu-tiaras"
  "natursteinvertrieb"
  "sela-clean"
  "fenstervertrieb"
  "hm-solingen"
  "ai-trader"
  "asian-shop"
  "bounty-scanner"
  "careerscore-ai"
  "einsatz-pro"
  "fb-baukonzept-astro"
  "natursteinvertrieb-legacy"
  "poly-scanner"
  "prompt-spaghetti"
  "signature-creator"
  "video-content-studio"
)

# Ensure user-level subagent is removed (conflict source)
USER_LEVEL="/root/.pi/agent/extensions/subagent"
[ -e "$USER_LEVEL" ] && rm -rf "$USER_LEVEL" && echo "Removed user-level subagent"

echo "Migrating ${#PROJECTS[@]} projects..."
echo ""

for proj in "${PROJECTS[@]}"; do
  proj_dir="$PROJECTS_DIR/$proj"
  subagent_dir="$proj_dir/.pi/extensions/subagent"

  if [ ! -d "$proj_dir" ]; then
    echo "  ⏭  $proj: directory not found"
    SKIP=$((SKIP + 1))
    continue
  fi

  # Skip if already migrated
  if [ -f "$subagent_dir/src/shared/circuit-breaker.ts" ]; then
    echo "  ⏭  $proj: already on pi-harness"
    SKIP=$((SKIP + 1))
    continue
  fi

  echo "  ▶ $proj:"

  # Step 1: Remove old subagent files
  if [ -d "$subagent_dir" ]; then
    rm -rf "$subagent_dir"
    echo "    ✓ removed old subagent files"
  fi

  # Step 2: Remove redundant extensions
  for ext in domain-enforcer mid-session-learning; do
    if [ -d "$proj_dir/.pi/extensions/$ext" ]; then
      rm -rf "$proj_dir/.pi/extensions/$ext"
      echo "    ✓ removed $ext"
    fi
  done

  # Step 3: Clone pi-harness
  if git clone "$PI_HARNESS_REPO" "$subagent_dir" 2>/dev/null; then
    echo "    ✓ cloned pi-harness"
  else
    echo "    ✗ clone failed"
    FAIL=$((FAIL + 1))
    continue
  fi

  # Step 4: npm install
  (cd "$subagent_dir" && npm install --omit=dev --no-audit --no-fund --loglevel=error 2>&1 | tail -1) > /tmp/npm-install.log 2>&1
  if [ -d "$subagent_dir/node_modules/typebox" ]; then
    echo "    ✓ deps installed"
  else
    echo "    ⚠ npm install failed (continuing)"
  fi

  # Step 5: Write config
  write_config "$proj" "$subagent_dir"
  echo "    ✓ wrote config.json"

  # Step 6: Patch cron scripts
  if [ -d "$proj_dir/.pi/scripts" ]; then
    patch_cron_scripts "$proj_dir"
  else
    echo "    ⏭ no scripts dir, skipping cron patch"
  fi

  # Step 7: Commit cron changes (prevents future reverts)
  if commit_cron_changes "$proj_dir"; then
    echo "    ✓ committed cron script changes"
  fi

  PASS=$((PASS + 1))
  echo ""
done

echo "═══════════════════════════════════════════════════════════"
echo "Migration complete:"
echo "  ✅ Success: $PASS"
echo "  ⏭  Skipped: $SKIP"
echo "  ✗  Failed: $FAIL"
echo "═══════════════════════════════════════════════════════════"
