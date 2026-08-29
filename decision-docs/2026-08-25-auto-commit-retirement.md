# Decision: retire `bus auto-commit`

**Date:** 2026-08-25
**Author:** maintainer
**Related tasks:** `task_1787696130065_71362301` (original finding, filed by boss from analyst's
incident), `task_1787696228763_70067934` (this decision + PR)
**Status:** proposed — PR open for morning review, not merged

## Background

`analyst`'s `local_version_control` ecosystem feature ran a `bus auto-commit` cron intended to take
periodic git snapshots of an individual agent's own workspace under `orgs/<org>/agents/<agent>/`, as a
crash-recovery / undo mechanism independent of the daily-memory protocol.

Tonight it staged another agent's (Aaron's) live, uncommitted dashboard work-in-progress via a
cron-triggered run against the shared framework checkout — a real incident, routed to this agent by
boss from analyst's report. The assigned task was framed as "design decision: bus auto-commit scope
vs `orgs/` gitignore" — i.e., should the target directory be rescoped to fix this. Investigation found
the mechanism cannot be fixed by rescoping; see below.

## Investigation

Two independent defects, verified empirically (not theorized) in an isolated scratch test:

**1. The scope is already what it appears to be, and that scope cannot work.**
`orgs/` is gitignored repo-wide (`.gitignore:14`). `git add` on a path under a gitignored directory
exits 1 and stages nothing — confirmed directly: `git add <file-under-orgs/>` → exit 1, `git status`
shows nothing staged. Rescoping `autoCommit`'s target from the whole repo down to an individual
`agentDir` does not change this: the same outer repo and the same root `.gitignore` govern `git add`
from any subdirectory. There is no rescoping of the *target path* that makes per-agent workspace
snapshotting via `git add` possible in this repository — the gitignore, not the scope, is the
constraint.

**2. The failure was silent, and worse, self-reporting as success.**
`autoCommit()`'s own error handling —
```ts
try { execFileSync('git', ['add', file]) } catch { /* ignore */ }
```
swallows the `git add` failure from (1) entirely. Its JSON report then claims `status: 'staged'` for
files that were never actually staged. Any agent or dashboard relying on that report to confirm a
snapshot was taken would be reading a false positive. This is a defect independent of the scope
question — it would misreport even against a non-ignored path if `git add` failed for any other reason
(detached HEAD, lock file, permissions).

**3. The one thing the mechanism could actually do was the thing that caused the incident.**
Because `orgs/` snapshotting silently no-ops, the only paths `autoCommit` could ever successfully
stage were **tracked files anywhere in the shared framework repo** — the same repo all 15 agents share
as their working tree. That is exactly what happened tonight: a cron fired `auto-commit`, `git add`
succeeded against tracked files outside `orgs/`, and it staged a different agent's live WIP.
Indiscriminately auto-staging a 15-agent shared checkout is dangerous on its own merits, independent
of whether the `orgs/` targeting question is ever resolved.

## Decision

**Retire `bus auto-commit` and the `local_version_control` ecosystem feature entirely.** Not "fix the
scope" — there is no scope that makes the stated goal (per-agent workspace snapshotting) achievable
via `git add` in this repository, and the mechanism's only working code path is an active hazard to
the shared checkout.

If a future agent needs workspace-level undo/crash-recovery, the correct construction is a dedicated
repo (or git-tracked directory) scoped to that agent alone, entirely outside the shared framework
checkout's working tree — not a feature that operates against a shared repo's gitignore rules from
inside a cron.

## What changed

- Removed `autoCommit()`, `AutoCommitReport`, and its five helper constants from `src/bus/system.ts`;
  trimmed now-unused imports.
- Removed the `auto-commit` CLI command and its registration/import in `src/cli/bus.ts`.
- Removed the `autoCommit`/`AutoCommitReport` export from `src/bus/index.ts`.
- Deleted `bus/auto-commit.sh` (dead wrapper).
- Removed `local_version_control?: EcosystemFeatureConfig` from `EcosystemConfig` in
  `src/types/index.ts`; updated `import-agent.ts`'s default ecosystem accordingly.
- Removed the `auto-commit` cron and `local_version_control` ecosystem key from `templates/analyst/`
  (`config.json`, `CLAUDE.md`, `ONBOARDING.md`); deleted the `local-version-control` skill directory
  entirely.
- Removed the corresponding `TOOLS.md` row and `bus-reference/SKILL.md` doc section across all five
  agent templates (`agent`, `orchestrator`, `analyst`, `agent-codex`, `agent-opencode`).
- Removed two pre-existing latent `local_version_control: { enabled: true }` ecosystem entries in
  `templates/agent/config.json` and `templates/orchestrator/config.json` that had no corresponding
  cron (a pre-existing inconsistency, cleaned up as part of this removal).
- Updated `tests/unit/bus/system.test.ts` and `tests/sprint1-templates.test.ts` to match.
- `CHANGELOG.md` — `### Removed` entry added.

## Explicitly out of scope

`community/` (`community/agents/analyst/*`, other `community/agents/*/TOOLS.md` and
`bus-reference/SKILL.md`, `community/skills/local-version-control/SKILL.md`) still references
`auto-commit`/`local_version_control`. It was **not** touched in this PR. `community/` had already
independently diverged from `templates/` before this change (e.g. `community/agents/analyst/config.json`
lacks the `runtime` field and `usage-monitor` cron present in `templates/analyst/config.json`), so
bringing it in sync is real but separate, lower-urgency follow-up work — not something this PR leaves
newly or silently inconsistent.

## Rollout

No fleet rollout and no agent restarts as part of this change — this PR only changes source, templates,
and docs in the framework repo. Existing agents already running `local_version_control` crons keep them
until their own config is regenerated from an updated template or manually edited; that is a separate,
deliberate follow-up, not automatic from this merge.

## Verification

- `npx tsc --noEmit` — clean.
- `npx vitest run tests/unit tests/sprint1-templates.test.ts` — 106 files, 1779 passed, 1 skipped.
- `grep -rlE "auto-commit|autoCommit|local_version_control|local-version-control" templates/ src/
  tests/ bus/` — only remaining hits are in `tests/sprint1-templates.test.ts`, in comments/assertions
  documenting the retirement.
