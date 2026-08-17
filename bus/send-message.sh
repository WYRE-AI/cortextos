#!/usr/bin/env bash
# send-message.sh — wrapper for Node.js CLI
# Usage: send-message.sh <to> <priority> [text] [reply_to_id] [--body-file <path>]
# Omit text (or pass "") to read the message body from stdin — the safe way
# to send a body containing backticks, $(, or apostrophes byte-identical
# (2026-08-15: inline shell args silently lose content to command
# substitution; see src/utils/resolve-message-body.ts).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CLI="${SCRIPT_DIR}/../dist/cli.js"

TO="${1:-}"
PRIORITY="${2:-normal}"
TEXT="${3:-}"
REPLY_TO="${4:-}"

if [[ -z "$TO" ]]; then
  echo "Usage: send-message.sh <to> <priority> [text] [reply_to_id] [--body-file <path>]" >&2
  exit 1
fi

ARGS=("$TO" "$PRIORITY")
[[ -n "$TEXT" ]] && ARGS+=("$TEXT")
[[ -n "$REPLY_TO" ]] && ARGS+=(--reply-to "$REPLY_TO")

# Pass through any extra flags (e.g. --body-file <path>) given after the
# four positional slots above.
if [[ $# -gt 4 ]]; then
  ARGS+=("${@:5}")
fi

exec node "$CLI" bus send-message "${ARGS[@]}"
