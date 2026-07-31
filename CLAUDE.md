# Contributing to cortextOS

## Development Setup

```bash
git clone https://github.com/grandamenium/cortextos.git
cd cortextos
npm install
npm run build
npm test
```

## Before Submitting Changes

1. `npm run build` — TypeScript must compile cleanly
2. `npm test` — all tests must pass
3. Match existing patterns in `src/` for new features
4. Add unit tests in `tests/` for any new code

## Project Structure

- `src/` — TypeScript source (bus, cli, daemon, hooks, types, utils)
- `bus/` — Shell wrapper scripts (delegate to `dist/cli.js bus`)
- `dashboard/` — Next.js 14 web dashboard
- `templates/` — Agent templates (agent, orchestrator, analyst, agent-codex, agent-opencode)
- `community/` — Community skills and agent catalog
- `tests/` — Unit, integration, and E2E tests

## Code Style

- TypeScript strict mode
- No external runtime dependencies beyond what's in `package.json`
- File operations use atomic writes (see `src/utils/atomic.ts`)
- All bus operations go through `src/bus/` modules

## Learnings - 2026-07-28

- Upstream (grandamenium/cortextos) rewrote its published history for the
  SEC-1 operator-metadata purge, so this fork's merge-base is pinned at the
  initial release forever. Every upstream sync re-conflicts on shared files,
  mostly "echo conflicts" (identical cherry-picked changes under different
  SHAs). Scope syncs with `git merge-tree --write-tree` first, and after
  resolving, grep for silently double-applied blocks outside conflict
  markers — `tsc` caught duplicated methods in agent-manager.ts and
  agent-pty.ts during the 2026-07-27 sync (merge 975a1e8c).
- `.gitignore` blanket-ignores `docs/` (upstream SEC-1 posture). Curated
  docs are deliberately force-added past it (`git add -f`), matching the
  existing tracked runbooks. Run `.github/scripts/leak-guard.sh <files>` on
  anything force-added; the `--tree HEAD` form is slow (minutes).
- Known environment-flaky tests on the primary dev Mac (fail under load at
  ANY commit, verified at pre-merge HEAD in a clean worktree): the four
  fast-checker "heartbeat watchdog" fake-timer tests, phase4-performance p95
  assertions, and phase5-performance SC-2. They pass on a quiet machine —
  not regressions.
