#!/usr/bin/env bash
# bus/gh-bot.sh
#
# Wraps `gh` so fleet-automation pushes/PRs authenticate as the GitHub App
# bot (wyre-agent-fleet), never the ambient personal `gh auth` login that
# persists on a shared dev Mac (~/.config/gh/hosts.yml).
#
# Root cause this fixes: `cortextos bus gh-app-token` mints a correct,
# bot-scoped token, but nothing forces a caller to actually use it — a bare
# `gh pr create` / `gh api` call silently falls back to whatever personal
# account is logged into `gh` on the box, with no error. See GUARDRAILS.md's
# "gh CLI call-site discipline" row (task_1790243111192 / task_1790243596388).
#
# Usage:
#   bus/gh-bot.sh [--org LOGIN] <any gh subcommand and args>
#
# --org defaults to the owner segment of the current repo's "origin" git
# remote; pass it explicitly when not inside that repo's checkout, or when
# the remote's owner differs from the GitHub App installation you need
# (e.g. wyre-technology vs WYRE-AI — gh-app-token's own default is
# wyre-technology, which is NOT where conduit lives).
set -euo pipefail

die() { echo "gh-bot: $*" >&2; exit 1; }

ORG=""
if [[ "${1:-}" == "--org" ]]; then
  ORG="${2:-}"
  shift 2
fi

if [[ -z "$ORG" ]]; then
  REMOTE_URL="$(git remote get-url origin 2>/dev/null || true)"
  ORG="$(printf '%s' "$REMOTE_URL" | sed -nE 's#.*[:/]([^/]+)/[^/]+(\.git)?$#\1#p')"
fi

[[ -z "$ORG" ]] && die "could not determine the org (not in a git checkout with an 'origin' remote) -- pass --org <login> explicitly"
[[ $# -eq 0 ]] && die "no gh command given -- usage: bus/gh-bot.sh [--org LOGIN] <gh subcommand and args>"

TOKEN="$(cortex-secret run --context conduit -- cortextos bus gh-app-token --org "$ORG" 2>/dev/null)" \
  || die "failed to mint a GitHub App token for org \"$ORG\" (check GITHUB_APP_ID/GITHUB_APP_PRIVATE_KEY via cortex-secret --context conduit)"
[[ -z "$TOKEN" ]] && die "gh-app-token returned no token for org \"$ORG\""

GH_TOKEN="$TOKEN" exec gh "$@"
