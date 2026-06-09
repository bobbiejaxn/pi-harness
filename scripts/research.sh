#!/usr/bin/env bash
# research.sh — Run a /research slash command for parallel research.
#
# Uses the parallel-research.md prompt to research a topic using
# multiple parallel subagent calls, then synthesize findings.
#
# Same pattern as ship.sh and ceo.sh.

set -euo pipefail

MODEL_FLAG=""
TOPIC=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --model)
      MODEL_FLAG="--model $2"
      shift 2
      ;;
    *)
      TOPIC="$1"
      shift
      ;;
  esac
done

if [[ -z "$TOPIC" ]]; then
  echo "Usage: $0 [--model MODEL] \"<topic to research>\""
  exit 1
fi

HARNESS_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PROMPT="$HARNESS_ROOT/prompts/parallel-research.md"

if [[ ! -f "$PROMPT" ]]; then
  echo "Error: research prompt not found at $PROMPT"
  exit 1
fi

exec pi \
  --append-system-prompt "$(cat "$PROMPT")" \
  $MODEL_FLAG \
  --mode json -p --no-session \
  "Research: $TOPIC"
