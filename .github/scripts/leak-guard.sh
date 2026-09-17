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
  # `git ls-tree` above (unchanged) always names the RIGHT files for $ref.
  # scan_file(), unchanged, reads each one's CONTENT from a plain on-disk
  # path — correct only when the working directory is already exactly at
  # $ref. It is not, in general: a shared/local checkout can sit on any
  # commit. Resolve both to shas and compare before trusting a raw read.
  ref_sha=$(git rev-parse "$ref" 2>/dev/null) || {
    echo "leak-guard: cannot resolve ref '$ref'" >&2
    exit 2
  }
  head_sha=$(git rev-parse HEAD 2>/dev/null) || {
    echo "leak-guard: cannot resolve HEAD" >&2
    exit 2
  }
  # Same sha is necessary but NOT sufficient for the fast path: `git diff
  # --quiet HEAD --` also has to be clean, or a dirty tracked file makes the
  # fast path scan on-disk content that doesn't match what's actually
  # committed at $ref_sha — the exact bug class the ref-differs branch below
  # exists to fix, just hiding behind the sha-equality check instead of in
  # front of it (murph's catch on #194's own CodeRabbit re-review,
  # 2026-09-17, reproduced directly: a dirty tracked file with a planted
  # leak was scanned and reported even though `--tree HEAD` was asked about
  # the CLEAN committed content). Untracked files are correctly irrelevant
  # here — `git ls-tree` never names them, so scan_file is never asked to
  # read one in --tree mode.
  if [ "$ref_sha" = "$head_sha" ] && git diff --quiet HEAD -- 2>/dev/null; then
    # Fast path: already exactly at $ref AND the tree is clean (the normal
    # case in a fresh CI checkout) -- no worktree needed, the on-disk reads
    # are already correct.
    while IFS= read -r f; do scan_file "$f"; done < <(git ls-tree -r --name-only "$ref")
  else
    # $ref differs from what's checked out, OR it matches but the working
    # tree is dirty. Either way, reading the working directory here would
    # risk silently scanning the WRONG content — confirmed 2026-09-17 (two
    # separate incidents, same underlying bug class): a stale local `main`
    # made `--tree origin/main` report a leak already fixed on the real
    # origin/main; a dirty tracked file made `--tree HEAD` report on
    # uncommitted content instead of what HEAD actually names. Materialize
    # $ref into an isolated, detached worktree (a sha, not the ref name, so
    # this never collides with a branch checked out elsewhere) and scan from
    # inside it instead — a fresh worktree checkout is never dirty.
    #
    # The stale-worktree sweep below, and worktree creation/scanning/cleanup,
    # all touch this repo's shared `git worktree` registry — which is a
    # TOCTOU hazard the moment two `--tree` invocations run concurrently
    # against the same checkout. That is ORDINARY usage here, not a
    # contrived case: this fleet routinely runs several agents against a
    # small number of shared checkouts (see CLAUDE.md's 2026-08-22
    # shared-binary entry), and it is exactly the scenario this whole PR
    # exists to make safe. Before the lock below, the sweep matched on
    # directory name only (`leak-guard-wt.*`) with no notion of "in use", so
    # a second invocation's sweep could force-remove a FIRST invocation's
    # still-active worktree mid-scan; scan_file()'s `[ -f "$f" ] || return`
    # then silently skips the now-missing file instead of failing, so the
    # victim can finish and print "leak-guard: clean" without having
    # scanned a real leak. Reproduced decisively (2026-09-17, CodeRabbit
    # finding on #194 + murph's independent repro): a real planted leak
    # came back exit=0 "clean" once a concurrent invocation's sweep deleted
    # the scanning process's worktree out from under it mid-read.
    #
    # Fix: serialize the whole worktree lifecycle (stale sweep through
    # final cleanup) behind a lock. `mkdir` is atomic and portable (no
    # `flock` binary on macOS, and this fleet runs both macOS and Linux
    # CI); the lock lives under this repo's shared git-common-dir so every
    # worktree of THIS repo contends on the same lock — exactly the domain
    # `git worktree` itself operates on — without over-serializing
    # unrelated repos. A lock that's genuinely stuck (e.g. its holder was
    # SIGKILLed before its own trap ran) times out loudly rather than
    # silently proceeding: the bug this fixes is a silent false-clean, so
    # on doubt this fails closed instead of risking a repeat.
    #
    # The `trap ... EXIT` below covers every NORMAL exit path (both the
    # success and the two explicit `exit 2`s), but not a hard SIGKILL
    # mid-scan -- a killed run can leave the temp dir, its
    # `.git/worktrees/<name>` registration, AND the lock dir behind
    # (`git worktree prune` alone would not catch the worktree: the
    # directory still physically exists, so it isn't "pruneable," just
    # abandoned). The recognizable `leak-guard-wt.` prefix lets a later
    # invocation find and remove exactly its own worktree leftovers (never
    # someone else's unrelated worktree) before adding a new one, rather
    # than accumulating orphans across repeated local runs -- and it is now
    # safe to do so unconditionally, because holding the lock guarantees no
    # OTHER invocation can be actively using any leak-guard-wt.* worktree
    # of this repo at the same time.
    common_dir=$(git rev-parse --git-common-dir 2>/dev/null)
    lock_dir="$(cd "$common_dir" 2>/dev/null && pwd)/leak-guard-wt.lock"
    lock_max_tries="${LEAK_GUARD_LOCK_MAX_TRIES:-150}"
    lock_sleep="${LEAK_GUARD_LOCK_SLEEP:-0.2}"
    lock_tries=0
    while ! mkdir "$lock_dir" 2>/dev/null; do
      lock_tries=$((lock_tries + 1))
      if [ "$lock_tries" -ge "$lock_max_tries" ]; then
        echo "leak-guard: timed out waiting for worktree lock ($lock_dir) -- a stuck holder? failing rather than risking a race" >&2
        exit 2
      fi
      sleep "$lock_sleep"
    done
    orig_dir=$(pwd)
    cleanup_wt() {
      cd "$orig_dir" 2>/dev/null
      [ -n "${wt:-}" ] && git worktree remove --force "$wt" >/dev/null 2>&1
      [ -n "${wt:-}" ] && rm -rf "$wt"
      rmdir "$lock_dir" 2>/dev/null || true
    }
    trap cleanup_wt EXIT

    while IFS= read -r stale_path; do
      [ -n "$stale_path" ] && git worktree remove --force "$stale_path" >/dev/null 2>&1
    done < <(git worktree list --porcelain 2>/dev/null | awk -F' ' '/^worktree /{p=$2} p ~ /leak-guard-wt\./{print p; p=""}')
    wt=$(mktemp -d "${TMPDIR:-/tmp}/leak-guard-wt.XXXXXX")
    if ! git worktree add --detach --quiet "$wt" "$ref_sha" >/dev/null 2>&1; then
      echo "leak-guard: cannot create worktree for ref '$ref' ($ref_sha)" >&2
      exit 2
    fi
    cd "$wt"
    while IFS= read -r f; do scan_file "$f"; done < <(git ls-tree -r --name-only "$ref_sha")
    cd "$orig_dir"
  fi
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
