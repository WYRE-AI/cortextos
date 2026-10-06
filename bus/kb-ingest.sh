#!/usr/bin/env bash
# kb-ingest.sh — Ingest files or directories into the cortextOS knowledge base
#
# Usage:
#   bash bus/kb-ingest.sh <path> [<path>...] [options]
#
# Options:
#   --org ORG          Organization name (required if CTX_ORG not set)
#   --agent AGENT      Agent name (required for --scope private)
#   --scope shared|private  shared = org-wide collection, private = agent-only (default: shared)
#   --collection NAME  Override collection name directly
#   --force            Re-ingest even if already indexed
#   --instance ID      Instance ID (default: default)
#
# Env: CTX_ORG, CTX_AGENT_NAME, CTX_INSTANCE_ID, CTX_FRAMEWORK_ROOT, GEMINI_API_KEY

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
FRAMEWORK_ROOT="${CTX_FRAMEWORK_ROOT:-$(cd "$SCRIPT_DIR/.." && pwd)}"

# Source env if available
ENV_FILE="${FRAMEWORK_ROOT}/.env"
[[ -f "$ENV_FILE" ]] && set -o allexport && source "$ENV_FILE" && set +o allexport

# Defaults
ORG="${CTX_ORG:-}"
AGENT="${CTX_AGENT_NAME:-}"
SCOPE="shared"
COLLECTION=""
FORCE=""
INSTANCE_ID="${CTX_INSTANCE_ID:-default}"
PATHS=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --org) ORG="$2"; shift 2 ;;
    --agent) AGENT="$2"; shift 2 ;;
    --scope) SCOPE="$2"; shift 2 ;;
    --collection) COLLECTION="$2"; shift 2 ;;
    --force) FORCE="--force"; shift ;;
    --instance) INSTANCE_ID="$2"; shift 2 ;;
    -*) echo "Unknown flag: $1"; exit 1 ;;
    *) PATHS+=("$1"); shift ;;
  esac
done

if [[ -z "$ORG" ]]; then
  echo "ERROR: --org or CTX_ORG required"
  exit 1
fi

if [[ ${#PATHS[@]} -eq 0 ]]; then
  echo "ERROR: at least one path required"
  echo "Usage: bash bus/kb-ingest.sh <path> [<path>...] --org ORG"
  exit 1
fi

# Determine collection name
if [[ -z "$COLLECTION" ]]; then
  if [[ "$SCOPE" == "private" ]]; then
    if [[ -z "$AGENT" ]]; then
      echo "ERROR: --agent or CTX_AGENT_NAME required for --scope private"
      exit 1
    fi
    COLLECTION="agent-${AGENT}"
  else
    COLLECTION="shared-${ORG}"
  fi
fi

# Paths
KB_ROOT="$HOME/.cortextos/$INSTANCE_ID/orgs/$ORG/knowledge-base"
CHROMADB_DIR="$KB_ROOT/chromadb"
VENV_DIR="$FRAMEWORK_ROOT/knowledge-base/venv"
MMRAG_PY="$FRAMEWORK_ROOT/knowledge-base/scripts/mmrag.py"

# Source org secrets for GEMINI_API_KEY
SECRETS_FILE="$FRAMEWORK_ROOT/orgs/$ORG/secrets.env"
if [[ -f "$SECRETS_FILE" ]]; then
  set -o allexport && source "$SECRETS_FILE" && set +o allexport
fi

if [[ -z "${GEMINI_API_KEY:-}" ]]; then
  echo "ERROR: GEMINI_API_KEY not set. Add it to orgs/$ORG/secrets.env"
  exit 1
fi

# Ensure venv exists
if [[ ! -d "$VENV_DIR" ]]; then
  echo "Knowledge base not set up. Run: bash bus/kb-setup.sh --org $ORG"
  exit 1
fi

# Ensure chromadb dir exists
mkdir -p "$CHROMADB_DIR"

# Ensure config.json exists (run setup if missing)
CONFIG_FILE="$KB_ROOT/config.json"
if [[ ! -f "$CONFIG_FILE" ]]; then
  echo "Config not found — running kb-setup.sh first..."
  bash "$SCRIPT_DIR/kb-setup.sh" --org "$ORG" --instance "$INSTANCE_ID"
fi

# Run ingest
export MMRAG_DIR="$KB_ROOT"
export MMRAG_CHROMADB_DIR="$CHROMADB_DIR"
export MMRAG_CONFIG="$CONFIG_FILE"
export GEMINI_API_KEY

echo "Ingesting into collection: $COLLECTION"
for path in "${PATHS[@]}"; do
  echo "  Source: $path"
done

# mmrag.py's exit code is NOT reliable: cmd_ingest catches per-file
# exceptions, tallies them into a printed "Errors: N" line, and always
# returns 0 regardless of N. A 429 RESOURCE_EXHAUSTED (embedding quota,
# not availability — clears within single-digit minutes, not a full 4h
# cycle; see HEARTBEAT.md's KB-INGEST-429-RULE-v2) is the common case, but
# the rc=0-with-Errors:N shape applies to any per-file failure. So this
# script captures mmrag.py's output itself rather than trusting $?, and on
# a 429/RESOURCE_EXHAUSTED retries once after a jittered delay — the same
# 60-180s wait + single retry an agent would otherwise have to remember to
# do by hand per that rule. Re-running is safe: mmrag.py dedups already-
# ingested content, so a retry only re-attempts the file(s) that failed.
OUT_FILE="$(mktemp)"
trap 'rm -f "$OUT_FILE"' EXIT

run_mmrag_ingest() {
  set +e
  "$VENV_DIR/bin/python3" "$MMRAG_PY" ingest "${PATHS[@]}" \
    --collection "$COLLECTION" \
    ${FORCE} 2>&1 | tee "$OUT_FILE"
  # Capture the whole array in one assignment -- reading PIPESTATUS[0] and
  # PIPESTATUS[1] on separate statements loses index 1, because each
  # subsequent command (even a bare assignment) resets PIPESTATUS to
  # reflect only itself.
  local statuses=("${PIPESTATUS[@]}")
  local rc="${statuses[0]}"
  local tee_rc="${statuses[1]:-0}"
  set -e
  # If tee itself failed, OUT_FILE may be missing/truncated — the later
  # per-file "Errors: N" check would then default to 0 and this script
  # would report completion without ever having verified the real output.
  # Treat a failed capture as a failure regardless of mmrag.py's own rc.
  if [[ "$tee_rc" -ne 0 ]]; then
    echo "ERROR: failed to capture mmrag.py output (tee exit $tee_rc) — cannot verify per-file errors" >&2
    return 1
  fi
  return "$rc"
}

run_mmrag_ingest
exit_code=$?

if grep -qE '429|RESOURCE_EXHAUSTED' "$OUT_FILE"; then
  delay=$((60 + RANDOM % 121))
  echo ""
  echo "Detected a 429/RESOURCE_EXHAUSTED per-file error — waiting ${delay}s (jittered) and retrying once"
  sleep "$delay"
  run_mmrag_ingest
  exit_code=$?
fi

error_count=$(grep -oE 'Errors: [0-9]+' "$OUT_FILE" | tail -1 | grep -oE '[0-9]+' || true)
error_count="${error_count:-0}"

if [[ $exit_code -ne 0 ]]; then
  echo "Ingest failed (exit $exit_code)"
  exit $exit_code
elif [[ "$error_count" -gt 0 ]]; then
  echo ""
  echo "Ingest NOT clean → collection: $COLLECTION — ${error_count} per-file error(s) remain after retry, see output above. Skipping for now; retry at next heartbeat."
  exit 1
else
  echo ""
  echo "Ingest complete → collection: $COLLECTION"
fi
