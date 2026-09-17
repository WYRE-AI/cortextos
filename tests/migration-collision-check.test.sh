#!/usr/bin/env bash
#
# Regression test for .github/workflows/migration-collision-check.yml's
# embedded Python collision-check logic.
#
# Extracts the SAME Python source the workflow actually ships (between the
# `python3 <<'PYEOF'` / `PYEOF` markers) and runs it end-to-end against a
# real local git repo, with `gh` faked on PATH. This tests the real shipped
# code, not a copy — a copy would drift silently the next time the workflow
# changes (same lesson as this repo's own "deliberately duplicated code
# drifts silently" entries).
#
# Primary case (2026-09-17, CodeRabbit finding on #193): `gh api
# .../files --paginate` with no `--slurp` produces multiple concatenated
# top-level JSON arrays for any PR whose file list spans more than one page
# (30 files/page on this endpoint) — not one valid JSON document. Before the
# fix, `json.loads()` on that raised, the except-branch caught it, printed a
# `::warning::`, and SILENTLY SKIPPED that PR's collision check entirely —
# so a 30+-file PR (exactly the kind most likely to actually contain a
# colliding migration) was invisible to this tool. This test proves the
# fixed code correctly flattens a multi-page `--slurp` response and finds a
# collision that exists ONLY on page 2 — a paginated PR must be INCLUDED,
# not silently skipped.
#
# Reusable-workflow constraint: this workflow's Python is embedded inline in
# the YAML (not a separate .py file) BECAUSE it is a `workflow_call` reusable
# workflow — a consuming repo's checkout never contains this repo's own
# .github/scripts/, so a separate script file would not exist at runtime for
# any caller. Extracting-at-test-time is the way to test the real code
# without changing that runtime shape.

set -uo pipefail
cd "$(dirname "$0")/.."
WORKFLOW=".github/workflows/migration-collision-check.yml"
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
fails=0

# ---- Extract the exact embedded Python (same source the workflow ships) ----
START=$(grep -n "python3 <<'PYEOF'" "$WORKFLOW" | head -1 | cut -d: -f1)
END=$(grep -n "^          PYEOF$" "$WORKFLOW" | head -1 | cut -d: -f1)
if [ -z "$START" ] || [ -z "$END" ]; then
  echo "FAIL: could not locate the python3 <<'PYEOF' ... PYEOF markers in $WORKFLOW (extraction broke)"
  exit 1
fi
sed -n "$((START+1)),$((END-1))p" "$WORKFLOW" | sed 's/^          //' > "$TMP/collision_check.py"

# ---- Fake `gh` on PATH ----
# gh pr list -> one other open, non-draft PR (#999).
# gh api .../pulls/999/files --paginate --slurp -> a REAL 2-page slurped
# shape ([[page1 items],[page2 items]]), page 1 all non-colliding filler,
# page 2 holding the ONE file that collides with our PR's new migration
# (030). Anything reading page 1 only, or crashing on multi-page input,
# fails to see it.
mkdir -p "$TMP/bin"
cat > "$TMP/bin/gh" <<'GHEOF'
#!/usr/bin/env bash
case "$*" in
  "pr list "*)
    echo '[{"number": 999, "isDraft": false}]'
    ;;
  "api repos/fake/repo/pulls/999/files --paginate --slurp")
    python3 - <<'PYGEN'
import json
page1 = [{"status": "added", "filename": f"migrations/{100+i:03d}_filler.sql"} for i in range(30)]
page2 = [{"status": "added", "filename": "migrations/030_colliding.sql"}]
print(json.dumps([page1, page2]))
PYGEN
    ;;
  "api repos/fake/repo/pulls/998/files --paginate --slurp")
    # Negative-control PR: same page-count shape, zero collisions anywhere
    # in either page — proves the test isn't just failing/erroring for
    # unrelated reasons, and that flattening doesn't over-match.
    python3 - <<'PYGEN'
import json
page1 = [{"status": "added", "filename": f"migrations/{200+i:03d}_filler.sql"} for i in range(30)]
page2 = [{"status": "added", "filename": "migrations/999_no_collision.sql"}]
print(json.dumps([page1, page2]))
PYGEN
    ;;
  *)
    echo "unexpected fake gh invocation: $*" >&2
    exit 1
    ;;
esac
GHEOF
chmod +x "$TMP/bin/gh"

# ---- Real local git repo: base branch + a PR-head branch with one new migration ----
REPO="$TMP/repo"
ORIGIN="$TMP/origin.git"
git init --bare -q "$ORIGIN"
git init -q "$REPO"
cd "$REPO"
git config user.email "test@test"; git config user.name "test"
git remote add origin "$ORIGIN"
mkdir -p migrations
echo "-- base" > migrations/001_init.sql
git add -A; git commit -q -m base
git branch -M main
git push -q origin main

git checkout -q -b pr-head
echo "-- new" > migrations/030_new_feature.sql
git add -A; git commit -q -m "add migration 030"

export PATH="$TMP/bin:$PATH"
export MIGRATIONS_PATH=migrations
export FILENAME_PATTERN='^([0-9]{3})_'
export BASE_REF=main
export REPO=fake/repo
export GH_TOKEN=fake-token

# ---- Case (a): the colliding other-PR (#999) — MUST detect the page-2 collision ----
export PR_NUMBER=1
out=$(python3 "$TMP/collision_check.py" 2>&1); rc=$?
if [ "$rc" -eq 0 ]; then
  echo "FAIL: script exited 0 (no collision detected) but PR #999's page-2 file should collide"
  echo "$out"
  fails=1
fi
if ! printf '%s\n' "$out" | grep -q "collides in open PR #999"; then
  echo "FAIL: collision was not attributed to PR #999 (page-2-only collision not detected — pagination bug regressed)"
  echo "$out"
  fails=1
fi

# ---- Case (b): control — replace the fake so only #998 (non-colliding, same
#      2-page shape) is the "other open PR", must stay CLEAN ----
sed -i.bak 's/"number": 999/"number": 998/' "$TMP/bin/gh"
export PR_NUMBER=1
out=$(python3 "$TMP/collision_check.py" 2>&1); rc=$?
if [ "$rc" -ne 0 ]; then
  echo "FAIL: script exited non-zero against the non-colliding control PR #998 (false positive)"
  echo "$out"
  fails=1
fi

# ---- Case (c): a still-OPEN PR whose file listing errors (rate limit,
#      network, permission) must FAIL the check, not silently skip it ----
# CodeRabbit finding (2026-09-17, second re-review on #193): before this fix
# any `gh api .../files` failure was logged as a `::warning::` and skipped
# exactly like a closed/irrelevant PR — so a transient API hiccup could
# silently defeat this whole check for the PR most likely to matter. The
# code now confirms via a fresh `gh pr view` that a PR is actually
# closed/merged before treating a listing failure as a legitimate skip.
cat > "$TMP/bin/gh" <<'GHEOF'
#!/usr/bin/env bash
case "$*" in
  "pr list "*)
    echo '[{"number": 997, "isDraft": false}]'
    ;;
  "api repos/fake/repo/pulls/997/files --paginate --slurp")
    exit 1
    ;;
  "pr view 997 --repo fake/repo --json state -q .state")
    echo "OPEN"
    ;;
  *)
    echo "unexpected fake gh invocation: $*" >&2
    exit 1
    ;;
esac
GHEOF
chmod +x "$TMP/bin/gh"
export PR_NUMBER=1
out=$(python3 "$TMP/collision_check.py" 2>&1); rc=$?
if [ "$rc" -eq 0 ]; then
  echo "FAIL: script exited 0 for a still-open PR (#997) whose file listing errored — must fail closed, not silently pass"
  echo "$out"
  fails=1
fi
if ! printf '%s\n' "$out" | grep -q "::error::Could not enumerate files for open PR #997"; then
  echo "FAIL: expected an ::error:: annotation naming PR #997's enumeration failure"
  echo "$out"
  fails=1
fi

# ---- Case (d): control — the SAME listing failure for a PR that IS closed
#      since the initial listing is a legitimate skip, must stay CLEAN ----
cat > "$TMP/bin/gh" <<'GHEOF'
#!/usr/bin/env bash
case "$*" in
  "pr list "*)
    echo '[{"number": 996, "isDraft": false}]'
    ;;
  "api repos/fake/repo/pulls/996/files --paginate --slurp")
    exit 1
    ;;
  "pr view 996 --repo fake/repo --json state -q .state")
    echo "CLOSED"
    ;;
  *)
    echo "unexpected fake gh invocation: $*" >&2
    exit 1
    ;;
esac
GHEOF
chmod +x "$TMP/bin/gh"
export PR_NUMBER=1
out=$(python3 "$TMP/collision_check.py" 2>&1); rc=$?
if [ "$rc" -ne 0 ]; then
  echo "FAIL: script failed for PR #996 which is confirmed CLOSED — this is a legitimate skip, not a defect"
  echo "$out"
  fails=1
fi

# ---- Case (e): a leading "./" on MIGRATIONS_PATH must not disable the
#      cross-PR collision check ----
# CodeRabbit finding: MIGRATIONS_PATH only stripped a trailing "/", so a
# caller-supplied "./migrations" never matched the API's "migrations/x.sql"
# filenames in the startswith() comparison, silently disabling this half of
# the check. Now normalized with os.path.normpath.
cat > "$TMP/bin/gh" <<'GHEOF'
#!/usr/bin/env bash
case "$*" in
  "pr list "*)
    echo '[{"number": 995, "isDraft": false}]'
    ;;
  "api repos/fake/repo/pulls/995/files --paginate --slurp")
    python3 -c 'import json; print(json.dumps([[{"status": "added", "filename": "migrations/030_colliding.sql"}]]))'
    ;;
  *)
    echo "unexpected fake gh invocation: $*" >&2
    exit 1
    ;;
esac
GHEOF
chmod +x "$TMP/bin/gh"
export MIGRATIONS_PATH="./migrations"
export PR_NUMBER=1
out=$(python3 "$TMP/collision_check.py" 2>&1); rc=$?
if [ "$rc" -eq 0 ]; then
  echo "FAIL: script exited 0 with MIGRATIONS_PATH='./migrations' but a real cross-PR collision exists — leading-./ handling regressed"
  echo "$out"
  fails=1
fi
if ! printf '%s\n' "$out" | grep -q "collides in open PR #995"; then
  echo "FAIL: collision not attributed to PR #995 with MIGRATIONS_PATH='./migrations'"
  echo "$out"
  fails=1
fi
export MIGRATIONS_PATH=migrations

cd - >/dev/null

if [ "$fails" -eq 0 ]; then echo "migration-collision-check.test: PASS"; else echo "migration-collision-check.test: FAIL"; exit 1; fi
