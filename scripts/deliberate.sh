#!/usr/bin/env bash
# deliberate.sh — Run a /deliberate slash command with proper system prompt binding.
#
# Same pattern as ship.sh and ceo.sh: pi doesn't auto-load .prompts/*.md
# as slash commands, so we inject via --append-system-prompt.

set -euo pipefail

MODEL_FLAG=""
QUESTION=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --model)
      MODEL_FLAG="--model $2"
      shift 2
      ;;
    *)
      QUESTION="$1"
      shift
      ;;
  esac
done

if [[ -z "$QUESTION" ]]; then
  echo "Usage: $0 [--model MODEL] \"<question to deliberate>\""
  exit 1
fi

HARNESS_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PROMPT="$HARNESS_ROOT/prompts/deliberate.md"

if [[ ! -f "$PROMPT" ]]; then
  echo "Error: deliberate prompt not found at $PROMPT"
  exit 1
fi

exec pi \
  --append-system-prompt "$(cat "$PROMPT")" \
  $MODEL_FLAG \
  --mode json -p --no-session \
  "Deliberate: $QUESTION"
