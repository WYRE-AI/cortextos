#!/usr/bin/env bash
#
# leak-guard.sh — server-side operational-leak scanner for the PUBLIC repo.
#
# Ported from upstream grandamenium/cortextos#698. Catches the class of leak
# where internal fleet operational detail (operator home paths, real org
# content, secrets) gets committed to the public framework repo. This is the
# server-side backstop that a local pre-push hook cannot provide: it runs in
# CI on every pull_request and push to main, so it covers fork PRs and GitHub
# UI-merges too.
#
# DESIGN: block on the LEAK SHAPE, not on framework convention. The framework
# legitimately uses generic placeholder names and fixture org names in
# hundreds of lines — those are NOT leaks and must NOT trip this guard. We
# match only high-signal shapes that never appear in legitimate framework
# code.
#
# 4TH CHECK, GENERALIZED (not a direct port): upstream's roster+cron check
# hardcodes their own fleet's literal agent names (boris/paul/sentinel/...).
# Doing that here would mean committing wyre's REAL live roster into this
# public fork's CI script — the first wyre-specific identifier ever tracked
# in this tree (orgs/ is fully gitignored; zero wyre-specific data exists in
# the tracked tree today). That would trade the exact exposure this check
# exists to prevent for detection of it. Instead: match the SHAPE (a bare
# identifier sitting alone in a markdown table cell, co-occurring with a
# cron-schedule-shaped string, within a small line window) rather than a
# fixed name list. Survives roster changes, keeps the fork name-free.
#
# Usage:
#   leak-guard.sh <file>...        scan the given files
#   leak-guard.sh --tree <ref>     scan every tracked file at <ref>
# Exit 0 = clean, exit 1 = leak(s) found (details on stderr).

set -uo pipefail

fail=0
report() { printf '::error file=%s::LEAK-GUARD: %s\n' "$1" "$2" >&2; printf '  %s: %s\n' "$1" "$2" >&2; fail=1; }

# ---- Patterns (each is high-signal for a real leak, low false-positive) ----

# 1. Operator home paths — the real operator's machine paths never belong in
#    the public framework. Match the KNOWN operator identity specifically so
#    generic example paths (/Users/foo, /home/victim, /Users/.../) do not FP.
#    Extend OPERATOR_USERS as needed; this is the exact leaked-path class.
OPERATOR_USERS='asachs'
HOME_PATH_RE="(/Users/(${OPERATOR_USERS})/|/home/(${OPERATOR_USERS})/)"

# 2. Secret shapes — real credentials. Obvious placeholders (xxxx/1234567890/
#    example) are excluded per-line in scan_file so doc token examples do not FP.
SECRET_RE='(sk-ant-[A-Za-z0-9_-]{20}|sbp_[a-f0-9]{40}|[0-9]{8,}:AA[A-Za-z0-9_-]{30}|AIza[A-Za-z0-9_-]{35}|apify_api_[A-Za-z0-9]{30})'
SECRET_PLACEHOLDER='x{6,}|1234567890|123456789|EXAMPLE|example|YOUR_|<[a-z]|placeholder|xxxx'

# 3. Operational-artifact PATH shapes — dev reports that should never be public.
ARTIFACT_PATH_RE='(^|/)(docs/phase-reports/|[A-Za-z0-9_-]*INSTALL_REPORT\.md$|PHASE[0-9]+-[A-Z-]+-REPORT\.md$)'

# 4. Fleet-roster + cron-schedule TABLE shape, generalized (see note above) —
#    no fixed name list. NAME_CELL_RE matches a bare short identifier sitting
#    alone in its own markdown-table cell (the actual leaked shape: a roster
#    name as its own "| name |" column, not a name mentioned in prose).
#    CRON_SHAPE_RE matches either a 5-field cron expression in parens, e.g.
#    "(0 13 * * *)", or the framework's own interval-cron shorthand attached
#    to an identifier, e.g. "heartbeat(4h)" / "nightly-metrics(24h)" — both
#    are real schedule shapes, not fleet-specific vocabulary. Framework
#    SOURCE and TEST fixtures legitimately build agent+cron structures, so
#    this check is scoped to non-test files only (see scan_file) — the leak
#    was in docs/, not code.
#    NOTE: literal `(` `)` `|` are written as bracket expressions ([(] [)] [|])
#    rather than backslash-escapes (\( \) \|) — macOS's bundled awk (the "one
#    true awk"/BWK awk) fails dynamic (-v-supplied) regex strings that
#    backslash-escape those characters ("illegal primary in regular
#    expression"); the POSIX bracket-expression form is unambiguous and
#    portable across awk implementations. Verified directly against both
#    BWK awk (macOS default) and GNU awk before shipping.
NAME_CELL_RE='[|][[:space:]]*[a-z][a-z0-9_-]{2,14}[[:space:]]*[|]'
CRON_SHAPE_RE='([(][0-9*][0-9*/,-]*[[:space:]]+[0-9*/,-]+[[:space:]]+[0-9*/,-]+[[:space:]]+[0-9*/,-]+[[:space:]]+[0-9*/,-]+[)]|[a-z][a-z-]*[(][0-9]+[hdms][)])'

scan_file() {
  local f="$1"
  # Skip this guard's own script + workflow (they legitimately contain patterns).
  case "$f" in
    .github/scripts/leak-guard.sh|.github/workflows/leak-guard.yml) return ;;
  esac

  # Path-shape check (applies to any path).
  if printf '%s' "$f" | grep -qE "$ARTIFACT_PATH_RE"; then
    report "$f" "operational-artifact path (dev report — must not be in public repo)"
  fi

  # Content checks only for existing, non-binary files.
  [ -f "$f" ] || return
  grep -Iq . "$f" 2>/dev/null || return   # skip binary

  # Operator home path — any match is a real leak (operator-specific pattern).
  if grep -nEq "$HOME_PATH_RE" "$f" 2>/dev/null; then
    report "$f" "operator home path: $(grep -nE "$HOME_PATH_RE" "$f" | head -1 | tr -s ' ' | cut -c1-100)"
  fi

  # Roster+cron table shape — scope OUT test files/fixtures (they legitimately
  # build agent+cron structures); the leak class was operational docs, not tests.
  case "$f" in
    tests/*|*.test.*|*.spec.*|*/__tests__/*|*/fixtures/*) ;;
    *)
      if awk -v W=3 -v NAME_RE="$NAME_CELL_RE" -v CRON_RE="$CRON_SHAPE_RE" '
          $0 ~ NAME_RE { name = NR }
          $0 ~ CRON_RE { cron = NR }
          (name && cron && name - cron <= W && cron - name <= W) { found = 1; exit }
          END { exit(found ? 0 : 1) }
        ' "$f" 2>/dev/null; then
        report "$f" "roster-shaped table cell + cron-schedule shape within 3 lines (possible fleet-metadata table)"
      fi ;;
  esac

  # Secret shapes — skip lines that are obvious placeholders/examples.
  while IFS= read -r line; do
    printf '%s' "$line" | grep -qE "$SECRET_PLACEHOLDER" && continue
    report "$f" "secret-shaped token: $(printf '%s' "$line" | cut -c1-60)"
  done < <(grep -nE "$SECRET_RE" "$f" 2>/dev/null)
}

if [ "${1:-}" = "--tree" ]; then
  ref="${2:-HEAD}"
  while IFS= read -r f; do scan_file "$f"; done < <(git ls-tree -r --name-only "$ref")
else
  for f in "$@"; do scan_file "$f"; done
fi

if [ "$fail" -ne 0 ]; then
  echo "" >&2
  echo "leak-guard FAILED: operational leak(s) detected above. If a match is a" >&2
  echo "false positive on legitimate framework content, refine the pattern in" >&2
  echo ".github/scripts/leak-guard.sh — do NOT bypass the check." >&2
  exit 1
fi
echo "leak-guard: clean"
exit 0
