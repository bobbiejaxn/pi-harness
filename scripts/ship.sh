#!/usr/bin/env bash
# ship.sh — Run the /ship slash command with proper system prompt binding.
#
# pi does NOT load .pi/prompts/*.md as slash commands — they are auto-loaded
# as system prompt fragments only when explicitly injected. This wrapper:
#
# 1. Resolves the feature description from args
# 2. Invokes `pi` with the ship prompt as an additional system prompt
#
# Usage:
#   scripts/ship.sh "Add dark mode toggle"
#   scripts/ship.sh --model zai/glm-5.1 "Fix the login bug"

set -euo pipefail

# Parse args
MODEL_FLAG=""
FEATURE=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --model)
      MODEL_FLAG="--model $2"
      shift 2
      ;;
    *)
      FEATURE="$1"
      shift
      ;;
  esac
done

if [[ -z "$FEATURE" ]]; then
  echo "Usage: $0 [--model MODEL] \"<feature description>\""
  exit 1
fi

# Find the harness root (where this script lives)
HARNESS_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# Locate the ship prompt
SHIP_PROMPT="$HARNESS_ROOT/prompts/ship.md"
if [[ ! -f "$SHIP_PROMPT" ]]; then
  echo "Error: ship prompt not found at $SHIP_PROMPT"
  exit 1
fi

# Run pi with the ship prompt as an additional system prompt
exec pi \
  --append-system-prompt "$(cat "$SHIP_PROMPT")" \
  $MODEL_FLAG \
  --mode json -p --no-session \
  "Ship: $FEATURE"
