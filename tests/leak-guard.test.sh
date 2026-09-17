#!/usr/bin/env bash
#
# Falsifiability test for the leak-guard scanner (.github/scripts/leak-guard.sh).
#
# Adapted from upstream grandamenium/cortextos's leak-guard.test.sh for wyre's
# generalized (not name-hardcoded) roster+cron check — see the design note at
# the top of leak-guard.sh for why. A scanner nobody has watched FAIL on a
# real leak is unproven. This asserts:
#   (a) it FAILS on a planted leak carrying the shape that leaked upstream on
#       2026-07-01 — a table-cell-shaped name token + a cron-schedule-shaped
#       string + an operator abs-path;
#   (b) it PASSES on the current clean tree (no false positives on legitimate
#       framework content — verified separately against the full wyre tree
#       before this test was written; this asserts it stays that way).
#
# The planted leak is generated in a temp dir at runtime — never committed —
# because a committed file carrying the operator path would itself trip the
# tree scan. The operator username is split ("asach""s") so THIS test file
# carries no operator-path literal.

set -uo pipefail
cd "$(dirname "$0")/.."
GUARD=".github/scripts/leak-guard.sh"
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
U="asach""s"
fails=0

cat > "$TMP/planted.md" <<EOF
# Fleet Ops Report
| Agent    | Schedule                    |
|----------|------------------------------|
| foxtrot  | heartbeat(4h), nightly-metrics(24h) |
Checked at /Users/$U/cortextos/orgs/acme/agents/foxtrot/AGENTS.md
EOF

# (a) MUST FAIL on the planted leak, and report all three detections.
out=$(bash "$GUARD" "$TMP/planted.md" 2>&1) \
  && { echo "FAIL: scanner PASSED a planted leak (should have failed)"; fails=1; }
printf '%s\n' "$out" | grep -q 'operator home path' \
  || { echo "FAIL: operator home path not detected in planted leak"; fails=1; }
printf '%s\n' "$out" | grep -q 'roster-shaped table cell' \
  || { echo "FAIL: roster+cron table shape not detected in planted leak"; fails=1; }

# (c) Windowed heuristic: a MULTI-LINE ops table splits the name cell and its
#     cron-schedule cell across adjacent rows, evading same-line detection.
#     The windowed check (WINDOW=3) must still FLAG it. Non-test path required.
cat > "$TMP/multiline.md" <<'EOF'
# Fleet Ops Table
| Field    | Value                      |
|----------|----------------------------|
| foxtrot  |                            |
| Cadence  | nightly-metrics(24h)       |
EOF
bash "$GUARD" "$TMP/multiline.md" >/dev/null 2>&1 \
  && { echo "FAIL: scanner PASSED a multi-line roster+cron table (should have failed)"; fails=1; }
printf '%s\n' "$(bash "$GUARD" "$TMP/multiline.md" 2>&1)" | grep -q 'within 3 lines' \
  || { echo "FAIL: multi-line roster+cron not caught by windowed check"; fails=1; }

# (d) Control: a table-cell name and a cron shape FAR apart (well beyond the
#     window) must stay CLEAN — the window must not over-match across a
#     whole document.
{ printf '| foxtrot | role |\n'; for i in $(seq 1 12); do printf 'filler line %s\n' "$i"; done; printf 'nightly-metrics(24h) runs daily\n'; } > "$TMP/farapart.md"
bash "$GUARD" "$TMP/farapart.md" >/dev/null 2>&1 \
  || { echo "FAIL: windowed check flagged name+cron far apart (false positive)"; fails=1; }

# (e) Control: ordinary prose mentioning a name and an interval-shaped word
#     in passing (not table cells, not the identifier(Nh) shape) must stay
#     CLEAN — the point is TABLE-CELL co-occurrence, not any name near any
#     duration.
cat > "$TMP/prose.md" <<'EOF'
# Release Notes
The foxtrot release ships in about 4h once CI is green. See heartbeat docs
for cadence details — nothing here is a schedule table.
EOF
bash "$GUARD" "$TMP/prose.md" >/dev/null 2>&1 \
  || { echo "FAIL: ordinary prose (name + '4h' mention, no table, no identifier(Nh) shape) false-positived"; fails=1; }

# (b) MUST PASS on the current clean tree.
bash "$GUARD" --tree HEAD >/dev/null 2>&1 \
  || { echo "FAIL: scanner flagged the CLEAN tree (false positive)"; fails=1; }

# (f) `--tree <ref>` must read $ref's own content, not whatever the working
#     directory happens to be checked out to right now (2026-09-17 real
#     incident: a stale local `main` made `--tree origin/main` report a leak
#     that had already been fixed on the real origin/main — a false
#     positive; the mirror-image false NEGATIVE is worse and equally real,
#     confirmed the same day against this repo's own history: `--tree
#     89e706be0` from a later, clean checkout wrongly said "clean" on the
#     pre-fix code, even though that exact commit has a real leak).
#
# Build a throwaway repo with two commits — A (clean) and B (planted leak,
# generated at runtime, never committed to THIS repo) — so both directions
# are provable without depending on any specific commit ever existing in
# this repo's own history (which could be rewritten/squashed later).
GUARD_ABS="$(cd "$(dirname "$GUARD")" && pwd)/$(basename "$GUARD")"
GT="$TMP/git-tree-test"; mkdir -p "$GT"
git -C "$GT" init -q
git -C "$GT" config user.email test@test; git -C "$GT" config user.name test
echo "clean content, nothing here" > "$GT/note.md"
git -C "$GT" add -A; git -C "$GT" commit -q -m "A: clean"
A_SHA=$(git -C "$GT" rev-parse HEAD)
printf 'Checked at /Users/%s/cortextos/orgs/acme/agents/foxtrot/AGENTS.md\n' "$U" > "$GT/note.md"
git -C "$GT" add -A; git -C "$GT" commit -q -m "B: planted leak"
B_SHA=$(git -C "$GT" rev-parse HEAD)
git -C "$GT" checkout -q "$A_SHA"   # working tree now sits on the CLEAN commit

# (f-1) False-negative direction: checked out at clean A, ask about leaking
#       B — MUST fail. Reading the working tree (A) instead of $ref (B)
#       would wrongly report clean, the bug's most dangerous shape for a
#       security scanner (a real leak reported as clean).
if (cd "$GT" && bash "$GUARD_ABS" --tree "$B_SHA" >/dev/null 2>&1); then
  echo "FAIL: --tree <leaking-ref> passed clean while checked out at a DIFFERENT, clean commit (false negative — the dangerous direction)"
  fails=1
fi

# (f-2) Sanity baseline for f-1/f-3: checked out at clean A, ask about clean
#       A itself via its sha (not "HEAD", so this exercises real ref
#       resolution rather than reusing check (b) above) — MUST pass.
if ! (cd "$GT" && bash "$GUARD_ABS" --tree "$A_SHA" >/dev/null 2>&1); then
  echo "FAIL: --tree <clean-ref>, checked out at that same clean ref, reported a leak (should never happen)"
  fails=1
fi

# (f-3) False-positive direction, the actual regression case: checked out at
#       leaking B, ask about clean A — MUST pass. Reading the working tree
#       (B) instead of $ref (A) would wrongly report a leak that isn't
#       there — the direction that actually bit on 2026-09-17.
git -C "$GT" checkout -q "$B_SHA"   # working tree now sits on the LEAKING commit
if ! (cd "$GT" && bash "$GUARD_ABS" --tree "$A_SHA" >/dev/null 2>&1); then
  echo "FAIL: --tree <clean-ref> flagged a leak while checked out at a DIFFERENT, leaking commit (false positive)"
  fails=1
fi

if [ "$fails" -eq 0 ]; then echo "leak-guard.test: PASS"; else echo "leak-guard.test: FAIL"; exit 1; fi
