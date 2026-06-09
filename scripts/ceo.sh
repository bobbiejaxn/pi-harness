#!/usr/bin/env bash
# ceo.sh — Run the /ceo slash command with proper system prompt binding.
#
# Same pattern as ship.sh: pi doesn't auto-load .prompts/*.md as slash
# commands, so we inject via --append-system-prompt.
#
# Usage:
#   scripts/ceo.sh "What is the current state of pi-harness?"
#   scripts/ceo.sh --model zai/glm-5.1 "Add a /verify slash command"

set -euo pipefail

MODEL_FLAG=""
GOAL=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --model)
      MODEL_FLAG="--model $2"
      shift 2
      ;;
    *)
      GOAL="$1"
      shift
      ;;
  esac
done

if [[ -z "$GOAL" ]]; then
  echo "Usage: $0 [--model MODEL] \"<high-level goal>\""
  exit 1
fi

HARNESS_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CEO_PROMPT="$HARNESS_ROOT/prompts/ceo.md"

if [[ ! -f "$CEO_PROMPT" ]]; then
  echo "Error: ceo prompt not found at $CEO_PROMPT"
  exit 1
fi

exec pi \
  --append-system-prompt "$(cat "$CEO_PROMPT")" \
  $MODEL_FLAG \
  --mode json -p --no-session \
  "CEO goal: $GOAL"
