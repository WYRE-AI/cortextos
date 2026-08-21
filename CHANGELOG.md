# CHANGELOG

## [Unreleased]

### Added — `bus update-task --append-desc` — a task description can now be corrected without churning its ID

A task description had no edit path after creation: `update-task` only
accepted `status`, `--assignee`, and `--project`. When a description turned
out to be wrong, the only options were to cancel-and-refile under a new task
ID (breaking every existing reference to the old one) or to park the
correction in daily memory, where a reader of the task never sees it. Both
workarounds were observed independently within one hour on 2026-08-15.

Added `--append-desc <text>`, deliberately an append rather than a
`--desc` replace: it adds a `--- APPENDED <UTC timestamp> ---` block to the
existing description rather than overwriting it, so a correction sits next
to the claim it corrects instead of erasing it. Works standalone or combined
with a status/assignee/project change in the same call; the audit log
records that a description was appended (and its length) without dumping
the full text into the audit trail.

Closes task_1786776657887_48026218.

### Fixed — `bus kb-query` rejected any question starting with `-`

Commander parsed `kb-query`'s positional `<question>` argument as an
unrecognized option whenever it began with `-` — `kb-query '- some fact'`
failed with `error: unknown option '- some fact'` at exit code 1, with the
error on stderr and **nothing on stdout**. A caller that only checks stdout
(as the KB freshness-sweep probes do) cannot tell that apart from a genuine
no-match, so it silently scores a false MISS instead of surfacing an error.
Measured impact: probes drawn from markdown bullet lines — which routinely
start with `-` — scored 7.1% and then 0.0% freshness across two instrument
revisions of `kb_ingest_fleet_freshness`, entirely from this, not from stale
content.

Passing `--` doesn't help as a workaround: once commander sees it, *every*
later token becomes positional too, so a caller's `--org`/`--agent`/`--scope`
flags get swept up right along with the question and the command fails with
"too many arguments" instead.

Fixed at the CLI entry point rather than pushing the burden onto every
caller: `shieldKbQueryLeadingDash()` inspects `process.argv` before
`program.parse()` and, only when the token immediately after `kb-query`
starts with `-` and isn't one of `kb-query`'s own registered flags (checked
against the command's live `.options`, not a hand-maintained list, so this
can't drift out of sync with them), prefixes it with a sentinel so commander
accepts it as the positional value. The action handler strips the sentinel
back off before the question ever reaches `queryKnowledgeBase`.

### Fixed — `update-task` had no way to change a task's priority

A task's priority was settable only at creation (`create-task --priority`,
defaulting to `normal`); `update-task` accepted only `<status>`, `--assignee`,
and `--project`. There was no way to correct it afterward short of hand-editing
the task's JSON file on disk. Concretely: a task filed with `[P1]` in its title
would sit at `priority: "normal"` in the record forever, and anything that
sweeps or sorts on the `priority` field — not the title — ranks it as routine.

Added `--priority <level>` to `update-task`, validated against the same
`urgent | high | normal | low` enum as `create-task`, wired through
`updateTask()` in `src/bus/task.ts` the same way `--assignee`/`--project`
already were (independently settable, recorded in the task audit log as
`priority: <old> -> <new>`, no status argument required).

### Fixed — `update-task` had no way to record a blocker discovered after creation

`blocked_by` was only settable at `create-task` time; `update-task` accepted
only `--assignee`/`--project`, so a task moved to `blocked` status after the
fact (the normal case — a gate usually emerges once work is already
underway) had no structured way to record what was blocking it, beyond an
unstructured event-meta note the tooling can't read. `check-stale-blockers`
was scanning 100+ blocked tasks a night and finding almost none of them
checkable for exactly this reason. Added `--blocked-by <ids>` to
`update-task` (and a matching `blockedBy` option on `updateTask`): additive
(never replaces the existing list), deduped, cycle-checked the same way
`create-task` is (rejecting before any write, so a rejected cycle leaves
zero partial state), and it writes the same symmetric `blocks` edge on the
peer task that `create-task` does.

### Fixed — `check-stale-blockers` summary had no coverage denominator

`resolved_dependency: 0` in `StaleBlockerReport.summary` was indistinguishable
from "checked N blocked tasks, found none stale" versus "0 of N were even
checkable" — most blocked tasks carry no `blocked_by` field at all, so the
`resolved_dependency` check can't evaluate them. Added
`resolved_dependency_eligible` (count of scanned tasks that actually carry a
non-empty `blocked_by`) to the summary, and to the `--format text` output, so
a reader can tell the two apart.

### Fixed — a retired account's exhaustion mark permanently poisoned rotation's retry timer

`rotation-manager.ts` derived its ALL-EXHAUSTED retry timestamp as
`Math.min(...Object.values(state.exhausted)) + 5min`, taking the earliest
known reset time across every account ever marked exhausted. Nothing ever
pruned an entry once its account was retired — the only clearing path fires
on a successful rotation *into* that account, which can never happen for one
that's gone. So a retired account's mark from weeks earlier sat in
`exhausted` forever, and `Math.min()` picked it every single time.

Reproduced live: `aaronmsachs-max20` was retired 2026-08-14 (moved out of
`accounts.json`'s `accounts` into its `retired` bucket). Its exhaustion mark —
`2026-07-22T11:00:00Z` — was still on disk in `rotation-state.json` on
2026-08-20, and every rotation attempt since had derived `retryAt` from it
instead of from the real, currently-exhausted accounts. The daemon logged
`ALL OAuth accounts exhausted... Auto-retry at 2026-07-22T11:05:00.000Z` on
every pass, the same stale timestamp, unchanged for a month.

Fixed two ways: `pruneOrphanedExhaustion` drops marks for accounts no longer
in `store.accounts` on every rotation attempt, and the `retryAt` computation
itself now filters `state.exhausted` to live accounts as a second, independent
guard — belt-and-braces, so a future caller of the derived value can't
reintroduce the same class of bug by skipping the prune.

Also: `exhausted` now stores an *observation* per account — `{observedAt,
resetAt, source}` — instead of a bare derived `resetAt` number. A stored
verdict (`ALL_EXHAUSTED: true`, or a single number with no timestamp) goes
stale exactly like this bug did; recording *what was observed and when*
means the observation itself stays true even after the derived guess is
wrong. `list-oauth-accounts` now surfaces both the per-account observation
and the fleet-wide `limitBlocked`/`alertedHalt`/`retryAt` state, previously
only readable by hand-catting `rotation-state.json`. Old bare-number state
files migrate transparently on load (`source: 'legacy-migrated'`).

### Fixed — hang-detector said "delivered" in its reason string while reading an ATTEMPTED field

`evaluateHang`'s fail-safe reason string and the (now-dead, kept for tests only)
`mostRecentDeliveredFireMs` helper both said "delivered" while reading
`last_fire_attempted_at` — a field that advances whether or not the agent
actually consumed the fire. This is not cosmetic: the misnomer produced a
false root cause during the 2026-08-15 11h maintainer outage investigation
(three agents, one misleading identifier, one wasted cycle refuting it).
Renamed the helper to `mostRecentAttemptedFireMs`, changed the reason string
to `'no fire attempt recorded — fail-safe'`, and added a comment at the
`T === null` branch naming the two conditions that actually produce null
(no attempt ever recorded, or every attempt is still within `graceMs`).
No behavior change — `evaluateHang`'s live anchor is unaffected
(`mostRecentAnswerableFireMs`, added in #121, was already correctly named).

### Fixed — `mmrag.py` required a bus wrapper for every subcommand, even ones with none

`kb-ingest`/`kb-query`/`kb-collections` all work via the bus CLI because
`buildKBEnv()` (`src/bus/knowledge-base.ts`) explicitly injects
`MMRAG_CONFIG`/`MMRAG_DIR`/`MMRAG_CHROMADB_DIR` pointing at the real
per-instance/org config before every call. Any subcommand invoked directly —
`mmrag.py delete`, at the time this was found, had no bus wrapper at all —
fell through to `mmrag.py`'s own hardcoded default (`~/.mmrag/config.json`),
which never exists in practice, producing a "Config not found... run
knowledge-base/scripts/setup.sh" error that read like the KB was broken
fleet-wide when only the unwrapped path was.

`mmrag.py` now self-computes the same per-instance/org default
(`~/.cortextos/<instance>/orgs/<org>/knowledge-base`, including the same
org-casing normalization as `normalizeOrgName()`) directly from
`CTX_INSTANCE_ID`/`CTX_ORG`/`CTX_FRAMEWORK_ROOT` when `MMRAG_DIR` isn't
explicitly set — every agent shell in this fleet already has those three
exported, so a bare invocation of any subcommand, wrapped or not, now
resolves to the correct config without needing a wrapper written for it
first. Falls back to the original `~/.mmrag` default when those env vars
aren't present (unchanged behavior for anything outside this fleet).

### Fixed — fenced injection bodies capped at 16KB (tail-truncated)

Every fenced PTY-injection path — inbox message bodies, Telegram/Slack text,
media captions, voice transcripts, the urgent signal — flows through
`wrapFenceSafe`, and none of them had a size limit: one oversized
`--body-file` bus send could eat most of the recipient's context window in a
single poll cycle. `wrapFenceSafe` now tail-truncates bodies over
`MAX_FENCED_BODY_BYTES` (16 KB, ~4k tokens — generous enough that real
traffic including pasted code blocks passes byte-exact) at a UTF-8-safe
boundary, appending an in-fence marker naming the original size. Fence
sizing still runs on the final body, so the unescapable-wrapper property is
preserved. Unit tests cover the boundary, multibyte safety, fence sizing on
truncated content, and the override parameter.

### Changed — merged upstream `grandamenium/cortextos` main (2026-07-27)

Second upstream sync since the fork (247 upstream commits; upstream had
rewritten history for its SEC-1 operator-metadata purge, so most overlap
arrived as echo conflicts). Notable upstream features integrated: opencode
runtime (native `OpencodePTY` adapter, `agent-opencode` template, CLI
scaffolding), context-handoff lifecycle refinements including the
runtime-aware handoff grace window, codex-app-server mid-turn steering
(`turn/steer`) and current-window token accounting, Telegram reply-target
context threading and command-registration retry, CRM-assistant
connect+verify setup, and the non-clobbering pre-push hook installer.
Fork-side work preserved over upstream's older equivalents: the
consecutive-restart context circuit breaker, rate-limit-aware
hang restart with OAuth rotation, dual-source liveness + cross-path
restart locks, agent-pidfile orphan reaping, per-engineer namespaces,
media-route XSS hardening, and the name-free leak-guard port with this
fork's operator identity.

### Fixed — `bus update-cron --prompt ""` wiped the prompt and reported success

The CLI passed `--prompt` straight through whenever it was defined, and an empty
string is defined:

```ts
if (opts.prompt !== undefined) {
  patch.prompt = opts.prompt;   // "" lands here
}
```

The cron that results is the bad kind of broken. It still loads, still reports
`enabled` in `list-crons`, still shows its schedule, and still fires on time —
it just injects nothing. There is no error, no warning, and no surface an
operator would check that looks any different from a working cron. It was hit
for real on 2026-08-16, on `guardrail-expiry-check`, and recovered only because
`crons.json.bak` happened to still hold the previous prompt.

**The validation already existed and was on the wrong side of a two-path API.**
`handleUpdateCron` (`src/daemon/ipc-server.ts`) has rejected an empty prompt all
along — *"Prompt must be non-empty."* The same operation reached through the CLI
did not. Two entry points, one guarded, and the unguarded one silently
succeeded.

So the guard moves to the choke point rather than being copied into the second
caller — the same call made in #120 (write the agent pid at the `start()` choke
point, not at one caller). `updateCron` (`src/bus/crons.ts`) now throws on an
empty or whitespace-only `prompt`, which covers the CLI, the IPC path, and any
future third caller. `cron-scheduler.ts` also calls `updateCron` — for
`last_fire_attempted_at` and similar — and never patches `prompt`, so it is
unaffected. `bus update-cron` catches the throw and reports it the way its other
validation failures already do: one line, exit 1, no stack trace.

Covered by `tests/unit/bus/update-cron-empty-prompt.test.ts`, verified to fail
**4 of 7** against the unfixed code. The three that pass either way are the
positive controls — a non-empty prompt still writes, a patch omitting `prompt`
still writes, and a missing cron still returns `false` — and they are what prove
the guard did not simply break `updateCron`. The load-bearing assertion is not
that it throws but that **the stored prompt is still on disk afterwards**; a test
asserting only the throw would pass against an implementation that threw after
writing.

### Fixed — the dashboard watcher handed globs to a chokidar that has no globs

`getWatchPaths` (`dashboard/src/lib/watcher.ts`) built patterns —
`.../analytics/events/**/*.jsonl` and four more — and passed them to
`chokidar.watch`. Chokidar removed glob support in v4; the dashboard is on
5.0.0. It took each pattern as a **literal path**, matched nothing, raised
no error, reached `ready`, and then sat there watching zero entries and
emitting zero `add`/`change` events, permanently.

Nothing about it looked broken. The startup line read
`[watcher] Watching 8 patterns` — a count of the argument we passed in, not
of what chokidar resolved. Eight patterns in, zero entries watched, and the
log confidently reported the eight. A one-time full sync then backfilled the
database, so the dashboard presented as live while frozen at the moment of
that sync: worse than visibly stale, because the timestamp looked current.

An earlier check ruled this out by testing the patterns against a glob
matcher, which matches them happily. That answers "is this a correct glob?"
(yes) rather than "does chokidar 5 expand globs?" (no).

Measured with the installed chokidar 5.0.0 on an identical synthesised tree:

| arm | `getWatched()` entries | events on append |
|---|---|---|
| glob pattern | 0 | 0 |
| literal directory | 3 | 1 |

Three changes:

1. **`getWatchRoots` returns literal directories** — `tasks`, `approvals`,
   `analytics/events` per org, plus flat `state` and `inbox`.
2. **Watching the directory means seeing everything under it**, so an
   `ignored` predicate prunes the heavy trees (`claude-config` alone is
   22372 of the 22765 entries under `state/`) and `isRelevant` keeps the
   handler to the files `syncFile` can actually act on.
3. **The health signal now counts what chokidar resolved, not what we asked
   for.** On `ready` it reports the watched-entry count and logs an error
   when that count is zero; a watch root that does not exist is reported by
   path. Both conditions were previously silent, and the silence is what
   made this a 37-hour outage rather than a startup failure.

Covered by `watcher-ingests-real-events.test.ts`, which drives the real
chokidar against a real temp tree — verified to fail 4/4 on the old code
(`expected [] to include …`) and pass 4/4 on the new. A mocked-chokidar test
cannot catch this class: it asserts that `watch()` was called with some
argument, and the argument was the defect.

### Fixed — editing a cron's prompt silently re-phased it

`computeReferenceMs` (`src/daemon/cron-scheduler.ts`) took `Math.max` over
`created_at` **and** every fire record, so a freshly-stamped `created_at`
always won. Its own docblock four lines above already stated the correct
rule — *"created_at anchors a cron that has NEVER fired"* — which the code
did not implement.

That combination is only reachable through a prompt edit, and a prompt edit
always reaches it. `add-cron` refuses to overwrite an existing name, so the
only way to change a prompt is remove-then-add; `handleAddCron`
(`src/daemon/ipc-server.ts:419`) stamps a fresh `created_at` on every add;
and `removeCron` (`src/bus/crons.ts:228`) deletes only the `crons.json`
entry, leaving `cron-state.json`'s `last_fire` — the real phase anchor —
intact but outvoted.

An interval cron's phase is invisible state that carries real meaning:
staggering paired observers, avoiding a stampede, covering a specific
window. Nothing announced the change — the listing still showed the same
schedule, the same enabled flag and the same count. Two measured incidents
on 2026-08-15: `check-approvals` moved 18:14/20:14Z → 19:20/21:20Z, losing
coverage of a window it had been covering and forcing a one-shot backstop;
a sweep cron moved 18:11Z → 18:13Z unnoticed.

Two halves, and the first is the load-bearing one:

1. **`removeCron` now leaves a tombstone.** Before deleting the entry it
   persists the cron's last fire to `state/<agent>/cron-state.json` — a file
   that lives outside `crons.json`, that the scheduler already reads and
   threads through as `stateFire`, and that is written here through its
   existing writer so the record shape stays identical to the one
   `bus update-cron-fire` produces. Best-effort: a cron must still be
   removable if the tombstone cannot be written.
2. **`created_at` is now a fallback, not a candidate** in
   `computeReferenceMs`, so the surviving fire record actually wins over the
   fresh stamp. Never-fired anchoring (`10e3011f`) is unchanged; the only
   behavioural difference is `created_at` newer than every fire record.

Known and accepted edge: a name deleted permanently and recreated much later
inherits the old anchor, so an interval cron computes a next-fire in the past
and takes **one** catch-up fire before re-phasing to now. Bounded and
self-correcting, and it cannot arise for cron expressions, whose phase is
pinned to the wall clock.

Two notes for anyone reading the original bug report, both wrong there:
the proposed fix "preserve `created_at` on re-add" is **not implementable**
(`removeCron` deletes the entry, so nothing survives to inherit from), and
`bus update-cron` is **not** a fix anyone shipped for this — it landed in
`dad07797`, the original external-crons feature, and was available the
whole time. It remains the right way to edit a prompt.

### Fixed — a task lookup and an inbox check both reported "nothing there" when they meant "I did not look"

`findTaskFile` returned `null` both when it had scanned every candidate
directory and found no such task, and when a directory existed but could not
be read so the scan aborted. `checkInbox` returned `[]` both when the inbox
was read and empty, and when the lock could not be acquired so it was never
opened. In each case the caller cannot tell a fact from a failure.

The damage is not in the "not found" error strings — those at least stop
loudly. It is where an empty result is consumed as an affirmative all-clear:

- The drift scanner emitted a `resolved_dependency` finding reading
  `blocked_by [...] are all completed, but task is still status=blocked`.
  That sentence is assembled from `blocked_by` alone, so on an unreadable
  tree it asserts as fact something no code ever read — and recommends
  clearing a safety gate on that basis.
- `bus task-deps` printed `no open dependencies — ready to work`.
- `bus check-inbox` printed `[]`, which is how an agent concludes "inbox
  empty, nothing owed to anyone" and records it as session state. The skip
  warning is rate-limited to once per inbox per minute, so under a 1s poll
  59 of every 60 skipped polls are silent in both channels.

Adds `findTaskFileWithStatus` → `{ path, unreadable }`,
`checkTaskDependenciesWithStatus` → `{ open, unresolved }`, and
`checkInboxWithStatus` → `{ messages, skipped }`, following the existing
`readCronsWithStatus`/`readCrons` precedent — each original function is kept
as a back-compat wrapper whose docblock states what it discards. A gate that
cannot verify now holds instead of opening. Behaviour is unchanged on any
healthy tree or inbox, and CLI stdout shapes are unchanged because agents
parse them; the new signal rides stderr and the exit code.
### Fixed — `read-all-heartbeats` reported two dead agents where there were none, and could not report a third condition at all

`readAllHeartbeats` enumerated **subdirectories of `state/`** and consulted no
roster of any kind, so "which agents exist" was answered by a filesystem
artifact. Three consequences, two visible and one not:

- A `state/` dir with **no roster entry** was returned as though it were an
  agent. On the live fleet that is `state/cortextos/` — a watchdog write under
  the wrong key, whose status text reads `[watchdog] warden alive` — plus five
  more in the `wyre-gateway` instance.
- A **disabled** agent was rendered identically to a dead one. `lantern` has
  been `enabled: false` since 2026-06-10 and showed only as `[STALE]`.
- An agent in the roster that has **never beaten** has no `state/` dir, so it
  was **absent from the output entirely** rather than flagged — and an absence
  reads as "no such agent", not as a gap.

Two structural details underneath:

- **The writer and the reader used different axes, in the same file.**
  `BusPaths.stateDir` is the *per-agent* directory (`utils/paths.ts`);
  `updateHeartbeat` writes through it correctly, while `readAllHeartbeats`
  ignored it and recomputed `join(ctxRoot, 'state')`, treating every subdir as
  an agent name.
- **Nothing declared agent-ness** — a parseable `heartbeat.json` implied it.
  `state/oauth/` and `state/usage/` sit on the identical axis and were excluded
  only because they happen to lack that file.

Adds `readAllHeartbeatRows(paths, org?)`, which enumerates the **roster UNION
the `state/` scan** and tags every row with the enumeration that found it, so
`roster+state`, `roster-only` (never beaten) and `state-only` (orphan) are three
renderable states instead of two collapsed into one plus a silent omission. The
roster half reuses `listAgents`, which already merges `enabled-agents.json` with
the org directory scan — reading the JSON alone would relabel a real agent
missing from that file as an orphan, which is BUG-028 rebuilt one layer up. A
mismatch between a heartbeat's `agent` field and its directory name is now
surfaced rather than displayed as a plausible agent name, and an unparseable
file is reported instead of silently skipped.

`readAllHeartbeats` is unchanged and still exported, with its narrow contract
documented: it answers "which agents have written a heartbeat", not "which
agents exist".

The CLI renders the new states, stops labelling a disabled agent `[STALE]`, and
gains `--all-instances`. Its description previously claimed "all agents in the
system" while resolving a single `instanceId`; `~/.cortextos/` holds five
instances, two with rosters, so the wording overclaimed and is now exact.

Note for anyone extending the sweep: pass `org`. The roster's two halves are
scoped differently — `enabled-agents.json` is per-instance but the directory
scan is global (`CTX_FRAMEWORK_ROOT`), so an unscoped multi-instance sweep
imports one instance's agents into another's report as confident "never beaten"
rows. That regression is pinned by a test.

Every fixture is **synthesised**, deliberately. The never-beaten case exists in
neither live instance on this machine (roster-minus-state is empty in `default`
*and* in `wyre-gateway`), so a fixture sampled from live config would have been
green over a real bug. The suite is mutation-validated: five deliberate breaks
of the implementation each fail it.

### Fixed — the concurrent-cron race test reported a bare count, making its own flake undiagnosable

`concurrent-cron-mutations.test.ts` fails intermittently — observed once in
eight full-suite runs, and never once in 1120 standalone invocations
(including under concurrent full-suite load). On failure it printed only how
many updates were lost, which is not enough to tell apart two defects whose
causes point in opposite directions:

- every child exited 0 and an update still vanished — mutual exclusion broke
- a child exited non-zero — lock timeout, or a spawn failure under load

It also `await`ed `Promise.all` directly, so a non-zero exit rejected with the
**first** failure and discarded the other seven children's outcomes.

Each child's exit code and stderr are now captured rather than thrown, the
on-disk cron state is dumped at the moment of failure, and the two shapes are
asserted separately so they can never be collapsed into one number again.
Both diagnostic paths are mutation-verified.

This does not fix the race. Two candidate causes were ruled out while
investigating: a lock **timeout** is excluded by experiment (a held lock makes
`bus update-cron` exit 1 with a distinctive error and the update does not
land, so it could never present as a silent loss), and the **stale-lock steal**
path is excluded by construction (`STALE_LOCK_MS` 30s exceeds the 5s lock
timeout, so a steal cannot occur within a single acquisition wait).

### Fixed — the hang sensor's anchor refreshed itself, blinding it to frequent-cron agents

`evaluateHang` was anchored on the most recent `last_fire_attempted_at`.
That field records the **attempt**, so it keeps advancing whether or not the
agent is alive to receive the fire. For any agent whose tightest cron
interval is at or below the 15-minute grace window, `now - T` was therefore
always within grace: the sensor returned "within grace" on every poll and
never reached the comparison that decides whether a session beat has landed.
The anchor refreshed itself faster than the window could expire.

The perverse consequence was that monitoring an agent more closely made it
*less* detectable. On 2026-08-15 the fleet's tightest-cadence agent (15m)
went unflagged for 11 hours and escaped only when a fire happened to land
late.

The anchor is now the most recent fire the agent has already had a full grace
window to answer. Detection latency becomes bounded by roughly one cron
interval plus grace regardless of cadence, and agents on infrequent crons are
unaffected — for a 4h cron the newest fire is virtually always older than
grace already, so the anchor is identical. The grace window is now a single
constant feeding both the anchor and the evaluator, since divergence between
them would silently restore the blind spot.

**This does not detect an agent that is responsive but doing no useful work.**
That is a different failure — the agent completes a turn every cycle, the
Stop hook writes `last_idle.flag` unconditionally, and the sensor correctly
reports it as not wedged. Tracked separately; a test pins that boundary so
this fix is not misread as closing it.

### Fixed — the agent pid record went stale on every self-restart

`writeAgentPid` was called by `AgentManager` immediately after
`await agentProcess.start()`. That is only **one of five** callers of
`AgentProcess.start()`: the other four are restart paths inside
`AgentProcess` itself — session-refresh, image-poison recovery, rate-limit
recovery, and generic crash recovery — each of which respawns the PTY with a
new pid and wrote nothing.

So the record was accurate exactly once, on the daemon-managed first spawn,
and went stale the moment an agent restarted itself. The rate-limit path
means records drifted during precisely the incidents where establishing
liveness matters most. With no usable pid record, identifying an agent's
process falls back to matching on `lsof` cwd, because the process cmdline
does not contain the agent name.

The write now happens inside `start()` — the one point every agent start
passes through — and is removed from the caller. It stays best-effort and
cannot fail a spawn.

Note this was never able to kill the wrong process: `verifyOwnership`
anchors on process start time, so a recycled pid returns `unverified` and
`reapOrphan` refuses to signal it and logs why. The defect was a missing
record, not an unsafe one.

### Fixed — node-pty's `spawn-helper` lost its executable bit on install, crashing every agent spawn

A plain `npm install`/`npm ci` of `node-pty@1.1.0` leaves
`prebuilds/*/spawn-helper` as `-rw-------` (verified on a clean, isolated
install — not just inferred from the missing script). The daemon spawns every
agent through a PTY, and node-pty `posix_spawn`s that binary directly, so the
OS refuses to run it: every agent loops `Failed to start: Error: posix_spawnp
failed.` while the daemon itself stays `online`, reading as "everything is
crashing."

`cortextos install`/`cortextos doctor` already carry a fix for this
(`fixSpawnHelper` in `src/cli/install.ts`), but neither runs automatically on
a plain `npm install`/`npm ci` or on `cortextos update --apply` (which only
`git merge`s, never reinstalls) — so a routine dependency reinstall on an
already-running box is not covered by either safety net.

Adds a `postinstall` script re-`chmod +x`-ing the prebuild binaries
unconditionally, so the fix applies on every install regardless of which path
triggered it. Verified end-to-end in this repo: with the script in place,
both `npm install` and `npm ci` restore the executable bit; without it,
neither does.

Split out of #34, which also included an already-landed `complete-task`/
`update-task` crash guard — not re-applied here, it's already on `main`.

### Fixed — `check-deploy-drift` gave the same remedy for two opposite conditions

The report collapsed both drifts into `status: "drift"`. That is deliberate — a cron
can alert on one field — but it left consumers unable to tell apart two situations
whose fixes point in opposite directions:

- **pull drift** — `origin/main` has commits the tree does not. Benign. Fix: pull, then build.
- **build drift** — `dist/` does not match local HEAD. Fix: build.

On 2026-08-15 a drift-check cron would have offered a rebuild for pull drift in the
language of restoring sync, and been right only by accident.

`drift_kind` (`pull` | `build` | `both`) is now emitted alongside `status`, which is
unchanged so existing consumers keep working.

### Fixed — build drift could not distinguish "behind" from "built from somewhere else"

Both produced `dist/ was built from a different commit than local HEAD — run npm run
build`. Those are very different situations: an **ancestor** build is merely old and
everything in it was reviewed code on main, while a **non-ancestor** build means `dist/`
carries commits that are not in this history at all — a branch built in the shared
checkout — so the fleet is running code nobody chose to deploy, and a rebuild silently
discards it.

Verified live that day: `dist/` carried an unmerged PR's CLI changes, and the existing
check correctly reported drift but advised the rebuild in the same words it uses for
ordinary staleness.

The classification asks `git merge-base --is-ancestor`, not a symbol comparison. A
name-based probe against a minified bundle collides — `hasTelegram` matching an
unrelated `hasTelegramMessage` produced a false fleet-risk alarm that day and cost an
hour. An unknown or pruned commit is treated as divergent, which fails toward warning
rather than reassuring. `builtSha` is shape-guarded before it reaches the shell.

Coverage in `tests/unit/bus/deploy-drift-kind.test.ts`, including a test that the two
reasons actually *differ* rather than each merely being non-empty, and a non-SHA
manifest case. Verified against the unfixed code as a negative control: 5 of 6 fail.

### Added — `bus get-approval <id>`, and `list-approvals --status` now actually exists

An agent could not find out what happened to an approval it had filed.
`updateApproval` moves a decided approval from `approvals/pending/` to
`approvals/resolved/`, but every CLI read path called `listPendingApprovals`
and looked only at `pending/` — so the moment a decision landed, its outcome
left the only directory the CLI could see. In the wyre store that hid 88
resolved records. The inbox message `updateApproval` sends is delivered
exactly once, so an agent that restarted past it had no way back to the
decision, and bus-only agents have no Telegram fallback.

This collided with the standing convention that a filed approval is *not* an
approved one and the agent must wait for the decision: agents were told to
wait for something the CLI could not show them.

- `bus get-approval <id>` — point lookup across `pending/` then `resolved/`.
  A restarted agent knows its own approval id, so a point lookup, not a list,
  is what closes the gap. Absent from both buckets writes to stderr and exits
  1 so it cannot be read as a result.
- `bus list-approvals --status <pending|approved|rejected>` — the flag
  `TOOLS.md` had documented all along but which was never implemented;
  it previously hard-errored `unknown option`. Unknown values now fail loudly
  rather than returning `[]`, since a silent empty result is indistinguishable
  from a real absence.
- `bus list-approvals --all` — every bucket. **A bare `list-approvals` still
  returns pending only**, unchanged from before. Its callers predate the
  command being able to read `resolved/` and mean "what still needs a
  decision" — the orchestrator heartbeat and its approval-sweep cron among
  them, and that cron reminds the user about anything pending for over an
  hour. Widening the bare invocation would turn every long-settled approval
  into a fresh reminder, so reaching resolved records is opt-in.
- `list-approvals` reports each entry's status, and its resolution note when
  it has one.

`listPendingApprovals` is unchanged in behaviour for existing callers.

### Fixed — autoresearch skill told agents to file approvals with a category the CLI rejects

`.claude/skills/autoresearch/SKILL.md` Step 4 prescribed
`cortextos bus create-approval "..." experiments "..."`. `experiments` is not a
valid category — `bus.ts` accepts only `external-comms`, `financial`,
`deployment`, `data-deletion`, `other`, and rejects anything else with exit 1.

The rejection is loud, but the snippet made it silent at the call site: the
command is wrapped in `APPR_ID=$(...)`, so the error goes to stderr, `APPR_ID`
is left **empty**, and the surrounding steps continue as though an approval had
been filed. An agent following the skill literally would block on, and then
report, an approval that does not exist. Running the command is not the same as
an approval existing.

Two further defects in the same three lines:

- The notify step was an unconditional `send-telegram`, which fails outright for
  bus-only agents (no `BOT_TOKEN`) — so on exactly the agents whose approvals are
  hardest to see, the approval was filed and then announced to nobody.
- "Block until approved" was a comment with no check behind it.

Now: correct category, an explicit non-empty assertion on `APPR_ID` that aborts
rather than continuing, and a notify path that falls back to the bus when there
is no bot token. Applied to all seven tracked copies (4 templates, 3 community).

**Not fixed here:** the ~20 already-deployed per-agent copies under the
gitignored `orgs/` tree. `cortextos update` syncs `AGENTS.md` but not
`.claude/skills/`, so this template fix does not reach running agents on its own.

### Fixed — KB collection model in `community/agents/` and the two memory skills

PR #83 corrected the knowledge-base doctrine in `templates/*/AGENTS.md` — the
documented three-collection model (`memory-{agent}` / `private-{agent}` /
`shared-{org}`) never existed, and the `--collection` flag it told agents to
pass is not accepted by `kb-ingest` or `kb-query`. That fix did not reach the
`community/agents/` catalog or the memory skill templates, so four community
agent definitions and both `skills/memory/SKILL.md` copies still taught the
model and the flag.

Live store: `kb-collections --org wyre` returns `agent-{name}` and
`shared-{org}` only — zero collections match `^memory-` or `^private-`. The
flag is rejected at argument parsing (`error: unknown option '--collection'`),
so the documented invocation does not degrade, it does not run. Agents hit the
error and used the working form instead, which is why no memory was actually
lost — the cost was every agent privately routing around a broken documented
line rather than fixing it.

The affected sections are now byte-identical to the merged
`templates/agent/AGENTS.md`:
`community/agents/{agent,analyst,orchestrator,research-agent}/AGENTS.md` plus
the ingest invocation in `templates/agent/.claude/skills/memory/SKILL.md` and
`templates/agent-codex/plugins/cortextos-agent-skills/skills/memory/SKILL.md`.
`research-agent` had already had its ingest line corrected but still carried
the three-collection table.

Deployed agent `AGENTS.md` files are a separate surface and are unchanged here:
20 of 20 still carry the old model, with zero on the corrected text. That is a
deployment gap tracked separately, not a template defect.

### Fixed — docs pointed at a cron-state path that does not exist, including inside "How to Verify"

`AGENTS.md`, `CLAUDE.md` and several skills documented persistent cron state under
`${CTX_ROOT}/state/${CTX_AGENT_NAME}/`. The real location is
`${CTX_ROOT}/.cortextOS/state/agents/<agent>/` — an extra nested `.cortextOS/` **and**
an `agents/` segment (`src/bus/crons-schema.ts:21`). Affects `crons.json`,
`.crons-migrated` and `cron-execution.log`.

Two of the four checks in the **How to Verify** block were the broken ones, and they
were the *direct-path* checks — `ls .crons-migrated` and `cat crons.json`. The two CLI
checks (`list-crons`, `get-cron-log`) work. So the block punished the reader who
distrusted the CLI summary and went to the underlying file, and it returned two clean
`No such file or directory` results that corroborate into a coherent, entirely false
story: *no crons registered, and migration never ran*. Both wrong answers come from one
wrong prefix, so their agreement carries no more information than either alone.

The failure lands at the worst moment — an agent checking whether its schedule survived
a restart could conclude the schedule was lost and re-register crons that already exist.
Two agents are known to have silently routed around this on 2026-08-15.

**Deliberately not changed:** `${CTX_ROOT}/state/${CTX_AGENT_NAME}/.onboarded`, which
appears in the same blocks and looks like the same family. It is **correct** — verified
15/15 agents at the documented path and 0/15 at the other. A bulk "fix the family"
replacement would have broken the First Boot Check in 31 places.

### Fixed — the documented agent log surface did not match reality, in both directions

Three of the four documented log paths **did not exist**, and seven real
streams were undocumented. Every agent inherits this table, so every agent
inherited a wrong map.

Documented but never written by any code (`git grep` finds zero references in
`src/` to any of them):

| Path | Reality |
|---|---|
| `logs/<agent>/stderr.log` | Cannot exist. Agents run under a **PTY**, which merges stderr into stdout — one stream, one file. |
| `logs/<agent>/activity.log` | The Activity feed is the events JSONL, at `orgs/<org>/analytics/events/<agent>/<YYYY-MM-DD>.jsonl`. |
| `logs/<agent>/fast-checker.log` | The fast-checker runs inside the daemon and has no log file of its own; its output is in `~/.pm2/logs/cortextos-daemon-out.log`. |

Real but undocumented: `crashes.log`, `restarts.log`, `hooks.log`,
`inbound-messages.jsonl`, `outbound-messages.jsonl`, the org-scoped events
JSONL, and the pm2 daemon logs. The Telegram JSONLs are also **conditional** —
written by `src/telegram/logging.ts`, so a bus-only agent has neither and their
absence is not a fault.

**Why this is a correctness bug and not tidiness.** A documented-but-absent
path returns a *clean empty result*. `tail` on a file that was never created,
or `grep --include=stderr.log`, yields nothing — and nothing is
indistinguishable from a genuine "nothing to report." Two of the corrected
lines were troubleshooting steps that told an agent to `tail` a nonexistent
file *while diagnosing a broken agent*, which is exactly when a false
all-clear does the most damage. This was found when a sweep for torn-build
errors used `--include=stderr.log`, matched zero files, and the clean zero was
briefly reported as a real absence.

**Verified per file rather than per inference**, which mattered: the events
path was first read from `src/bus/event.ts` as `<ctxRoot>/analytics/events/…`.
`analyticsDir` in fact resolves org-scoped (`src/bus/system.ts:496`), so the
true path is `<ctxRoot>/orgs/<org>/analytics/events/<agent>/<date>.jsonl` —
confirmed by locating the live file and checking that today's events are
actually in it.

And the wrong path is worse than a wrong path: `<ctxRoot>/analytics/events/`
**does exist**. It holds `aaron`, `fix-the-things`, and `test-agent` — the last
written to as recently as today, so it is not even dormant. An agent following
the inferred path therefore finds a **real, populated, actively-written
directory**, does not find itself in it, and concludes it has logged nothing.
A missing directory raises an error; this one returns a confident wrong answer.

Deleting the three bad rows and trusting the rest would have repeated the
original error at smaller scale — reading the code is still an inference; only
locating the live artifact is verification.

Each corrected table now also carries the general rule: confirm a path exists
before drawing a conclusion from its silence.
### Fixed — boot/restart prompts ordered Telegram-less agents to send Telegram

The daemon-generated startup and `--continue` prompts told **every** agent to
report in over Telegram. The context-handoff variant was emphatic about it —
"your VERY FIRST tool call MUST be a Bash call running
`cortextos bus send-telegram $CTX_TELEGRAM_CHAT_ID …`", to be done *before* the
heartbeat and before any other tool call. On agents with no bot configured that
mandated first action exits 1 with
`Error: BOT_TOKEN not configured`. Five of twenty fleet agents are in that
state, so each began every restart with a guaranteed failure, as the very first
thing a fresh session did. Hit live on 2026-08-15 by two agents independently.

Nothing was broken downstream — agents route around it — but a boot directive is
the least appropriate place to be confidently wrong, because it is the first
thing read and there is no prior context to weigh it against. An agent that
reasoned "my boot instructions tell me to use Telegram, so I must have Telegram"
would be treating a description of what the system is *for* as evidence of what
*is*.

`buildStartupPrompt()` and `buildContinuePrompt()` now gate all three
Telegram directives on a new `hasTelegram()` check, and emit a
`cortextos bus update-heartbeat '<one sentence>'` instruction instead — which
preserves the intent (a human-visible, conversational "I'm back"), since the
heartbeat string is what the dashboard shows.

**The check keys on `BOT_TOKEN` having a value, not on the `BUS_ONLY` marker.**
`BUS_ONLY` currently selects exactly the right five agents, but it is a
classification standing in for the property that actually decides whether
`send-telegram` succeeds. The two diverge on any newly-created agent:
`cortextos add-agent` writes a literal `BOT_TOKEN=` and no `BUS_ONLY` field, so
a `BUS_ONLY`-based check would tell every fresh agent to send Telegram it cannot
send — the same defect on a population that did not exist when the marker was
introduced. Precedence matches `cortextos bus send-telegram` itself: agent
`.env` first, then the process environment.

`CHAT_ID` is deliberately not a tell. It is set to the same value on all fifteen
agents in the primary org whether or not they have a bot, so it has no
discriminating power at all.

Coverage in `tests/unit/daemon/agent-process-telegram-capability.test.ts`,
including the empty-token, whitespace-only-token, fresh-`add-agent`, and
`CHAT_ID`-is-not-a-tell cases. Verified against the unfixed code as a negative
control: 5 of 8 fail without the change.

### Fixed — `restart <agent>` reported a healthy agent as stopped

`cortextos restart <agent>` issues `stop-agent` then `start-agent` back to
back. The stop IPC returns as soon as the stop is *dispatched*, but the agent
only leaves the registry once its PTY has actually exited — so the start can
land while the entry is still present and come back `DEDUPED`. `restart.ts`
treated any unsuccessful start as fatal and printed
`Agent is now stopped. Recover with: cortextos start <agent>` — while the
agent was in fact coming up. Following that advice then errors as deduped too,
reading as a second failure against a perfectly healthy agent. Hit live on
2026-08-14: the command reported failure and exited 1 while `cortextos status`
showed the agent running with 2s uptime on its newly configured model.

The IPC response already carried a structured `code` (`DEDUPED` / `NOT_FOUND` /
`NOT_RUNNING`); `restart.ts` simply ignored it. It now treats `DEDUPED` as
"starting or already running" and points at `cortextos status`, while genuine
failures still exit non-zero. Behaviour coverage added to
`tests/unit/cli/restart-command.test.ts`, which previously pinned only command
wiring; the DEDUPED case was verified load-bearing by mutation.

### Known issue — injected messages can be silently dropped (investigated, not fixed)

`injectMessage` (`src/pty/inject.ts`) pastes in bracketed-paste mode then
submits with a fixed 300ms `setTimeout` Enter. On 2026-08-14 an inbound
Telegram message reached `boss`'s input box, rendered there, and was never
submitted — no `user` entry in the session jsonl — while the agent sat idle for
four minutes and the operator saw silence.

Deliberately **not** patched, because the mechanism is not established: the
payload was 1048 bytes, under `MAX_CHUNK`, so it was a single `write()` (not
chunk interleaving), and PTY bytes are an ordered stream, so paste-then-Enter
should arrive in order even with the app busy. Something in the TUI discards or
defers the keystroke, and that has not been reproduced.

**A retry Enter is not a safe fix here.** `Enter` is overloaded: `fast-checker`
writes `KEYS.ENTER` to confirm AskUserQuestion option selections and
multi-select submits. A blind second Enter from `injectMessage` could
auto-confirm whatever dialog opened in between — worse than a dropped message.
Viable directions: reproduce the busy-TUI state first; verify submission
against the PTY output `AgentProcess` already consumes rather than a fixed
timeout; and make the inbox ACK in `fast-checker` contingent on confirmed
submission, since today it ACKs as soon as `injectMessage` returns, so a dropped
message is also ACKed and never redelivered.

### Fixed — unquoted `date` format strings: the remaining 14 files

Completes the earlier "template docs drift batch" fix below, which landed in 9
files and left 34 occurrences across 14 more. Same bug, same fix: on BSD/macOS
`date`, the unquoted `UTC` in `$(date -u +%H:%M UTC)` parses as an operand
(`illegal time format`), so every memory entry written verbatim from the
template got an EMPTY timestamp. Now quoted: `$(date -u '+%H:%M UTC')`.

Swept files: `community/agents/{agent,agentic-crm-assistant,analyst,orchestrator,research-agent,security}`,
`community/skills/memory`, `templates/agent/.claude/skills/memory`, and
`templates/agent-codex/plugins/cortextos-agent-skills/skills/memory`.

**Why the first pass missed them — worth knowing, it will bite other sweeps.**
The agent shell's `grep` is not `/usr/bin/grep`: the Claude Code shell snapshot
shadows it with a function that execs `ugrep` under `--ignore-files`, which
honours `.gitignore`. Files that are **tracked in git but textually matched by
an ignore rule are silently skipped** — no error, no warning, just a smaller
number. This repo has exactly that overlap: a bare `AGENTS.md` rule
(`.gitignore:55`) and a `memory/` rule (`templates/agent/.gitignore:3`),
both meant for per-agent runtime dirs, also match tracked framework templates.

The three searches disagreed and only the last two were right:

| search | result |
|---|---|
| `grep -rn …` (shimmed ugrep) | 17 |
| `grep -rn … community templates` (explicit dirs) | 26 |
| `git grep` / `/usr/bin/grep -rn` | **34** |

`community/agents/research-agent/AGENTS.md` *was* found by the shim, because
`.gitignore:69` un-ignores it with `!community/agents/research-agent/**` —
which is what pinned the mechanism down rather than leaving it a guess.

Rule for completeness sweeps in this repo: drive them from `git grep`, and
verify the residual with `/usr/bin/grep`. A bare `grep -r` under-reports here.

### Fixed — cherry-picked two upstream fixes (`grandamenium/cortextos`)

This fork diverged from upstream on 2026-04-06 and is now +390 / -264 commits
against that base, so a full merge is a project rather than a pull. These two
were content-verified as genuinely missing here (most of the upstream delta —
the PTY-injection Unicode-whitespace hardening, task-id path validation, 50MB
stdout rotation, `next@16.2.4`, the TRUST_PROXY/CF-Connecting-IP rate-limit
logic — is already present under different SHAs, so the raw "264 behind" count
badly overstates the gap).

**`fix(security)`: sanitize the display-name in `formatTelegramReaction`**
(upstream `5362a5a2`, #708). `formatTelegramReaction` interpolated the Telegram
display name raw. The caller's `stripControlChars` deliberately keeps `\n`/`\r`,
so a crafted display name could forge a `=== TELEGRAM ===` containment header
into an agent's PTY stream — the #592/#597 injection class. This was the last
unhardened `formatTelegram*` path; the other five were already sanitized here,
which is what made it a live residual rather than a deliberate omission. The
commit's two tests were verified load-bearing by mutation: reverting the
sanitization fails "neutralizes a display-name header forgery" and "a bare-CR
forgery is folded to LF and quoted".

**`fix(pty)`: auto-accept the Claude Code 2.1.x Bypass Permissions screen**
(upstream `a15baad4`). Without it a headless agent wedges on that screen at
first run and crash-loops — the same shape as the interactive-dialog hangs
already recorded in this repo's CLAUDE.md learnings.

Both retain their original upstream authorship. Two bugs found here on
2026-08-14 are **not** fixed upstream either — `injectMessage`'s fixed 300ms
`setTimeout` Enter (bus task `…53511893`) and `restart <agent>` reporting a
start-dedupe as "Agent is now stopped" (bus task `…76411072`) — upstream's
copies of both files are identical to ours, so those are push-upstream
candidates, not pull.

### Fixed — dashboard served by `next dev` in production because `next build` failed

`dashboard/src/lib/config.ts` falls back to `path.resolve(process.cwd(), '..')`
for `CTX_FRAMEWORK_ROOT`. Turbopack reads that as a directory asset reference
and walks the entire parent repo at module-graph time, where it reaches
`knowledge-base/venv/bin/python3.14 -> /opt/homebrew/opt/python@3.14/...` — an
absolute symlink out of the project root that it refuses to trace — and fails
the whole build with a `TurbopackInternalError`. Because `next build` could not
complete, PM2 was running the dashboard with `npm run dev`, so **every route
paid a multi-second on-demand compile on its first hit after each restart**.
Measured on this box before the fix: `/knowledge-base` 27.2s, `/api/events`
6.5s cold, first `/login` compile 60–110s. Pinning `turbopack.root` to
`dashboard/` in `next.config.ts` stops the parent-repo traversal; those reads
are runtime `fs` access rather than bundled imports, so narrowing the
build-time root does not change them, and nothing under `src/` imports from
outside `dashboard/` (only a `.test.ts` type import, excluded from builds).
With the build succeeding, PM2 now runs `npm run start`: the same pages serve
in 0.03–0.15s and `/api/events` in ~0.00s.

### Fixed — `/api/comms/feed` read every message on disk to return 200 of them

The route treated `logs/message-history.jsonl` as its primary source and the
inbox/processed directory scan as a fallback — but **nothing in the daemon ever
writes that file**; only the dashboard reads it. So every request took the
fallback: a synchronous walk of every agent inbox/inflight/processed directory,
`readFileSync` + `JSON.parse` per message, then a sort, then a slice to 200.
On this box that was **32,350 files per request**, uncached, growing without
bound as the fleet works.

Bus message filenames already carry their timestamp
(`2-1786740815529-from-boss-3znol.json`), so `src/lib/comms-messages.ts` now
enumerates directory entries — cheap, no file reads — sorts by that epoch
descending, and opens files only until `limit` messages pass the caller's
filter. Because the merged result was always sorted by timestamp descending and
sliced to `limit` anyway, the newest `limit` acceptable messages are exactly the
ones that survived before: same result set, a fraction of the I/O.

The equivalence rests on filename epoch ordering agreeing with `msg.timestamp`
ordering, which was verified against all 32,350 messages on this box: zero
filenames failed to parse, zero messages had the two values more than 60s
apart, and the newest-200 by filename epoch was identical to the newest-200 by
timestamp. Files with an unparseable name sort last rather than being dropped.

`/api/comms/feed?limit=200`: **5.96s cold / 0.65s warm → 0.14s / 0.065s.**

`/api/comms/channel/[pair]` was left alone: it is already scoped to the two
agents in the pair and uses a different on-disk layout, and measures 0.02s. The
6.9s previously seen on `/api/comms/channels` was dev-mode compilation, not
data cost — it is 0.02s on a production build.

### Fixed — unbounded dashboard lists made Comms, Activity and Approvals unnavigable

These pages rendered their whole capped result set at once inside an
`overflow:auto` container with no document-level scrollbar. Comms rendered 200
message cards as a single 27,690px column — 33 screens. Added
`usePagination` (`src/hooks/use-pagination.ts`), which slices an
already-fetched array, and a shared `PaginationControls`
(`src/components/ui/pagination-controls.tsx`) that hides itself at one page.
Applied to the comms feed, the activity event feed, the approvals pending and
"your tasks" lists, and the approval history list. Client-side by design: these
endpoints already cap what they return, and the three APIs paginate
inconsistently today (events has `limit`/`offset`, comms has `limit` plus a
cursor, approvals has neither), so slicing the fetched array avoids reworking
three API contracts to fix a rendering problem. Tall action cards page at 10,
compact message/event rows at 25. Comms 33 → 4 screens, Activity 8 → 2,
Approvals 6 → 2. The activity feed is live over SSE: page 0 keeps tracking the
newest events, deeper pages shift as events arrive.

### Fixed — Action Required pluralised by suffixing an 's' to the whole phrase

`{item.label}{item.count !== 1 ? 's' : ''}` rendered "15 task assigned to
you**s**", since the noun is not the last word in that phrase. `ActionItem`
gains an explicit `plural` field and the component selects between `label` and
`plural` on count instead of appending a character.

### Known issue — agents with unfilled IDENTITY.md render raw HTML comments as their name

An agent whose `IDENTITY.md` still holds its onboarding placeholders is
displayed in the fleet list and on `/agents/<name>` as
`<!-- Optional emoji identifier --><!-- Agent name (set during onboarding) -->`.
Observed on this box for `boss`, the orchestrator. `orgs/` is gitignored, so
filling the file in is per-deployment operator work — but the dashboard should
arguably fall back to the agent's directory name rather than rendering comment
markup verbatim. Not fixed here.

### Added — `disabled` flag on OAuth accounts (supported seat retirement)

A cancelled subscription still AUTHENTICATES: it passes the setup-token
liveness preflight (a 5-token ping sails through) and only fails on real
workloads — so `rotate-oauth` could silently move the whole fleet onto a
dead seat, and retiring one meant hand-editing `accounts.json` (which the
candidate builder ignored anyway). Accounts now support `disabled: true`:

- **rotation candidate filter** excludes disabled accounts BEFORE preflight
  (the preflight cannot detect a cancelled seat, so filtering after it
  would be no protection at all);
- **`set-oauth-account`** refuses to activate a disabled account;
- **`list-oauth-accounts`** renders the `(disabled)` marker;
- **daemon rotation path** (`rotation-manager.ts` — the unattended
  limit-banner path, a SECOND independent candidate builder found in
  warden's review): same pre-preflight filter, plus a graceful
  skip-to-next-candidate if an account is disabled mid-rotation instead
  of an uncaught throw crashing the attempt.

### Fixed — analyst template HEARTBEAT.md was missing the KB re-ingest step entirely

Every other agent template's heartbeat checklist re-ingests MEMORY.md +
daily memory into the KB each cycle; the analyst template never had the
step, so analyst agents' semantic memory silently never populated (found
via the kb_ingest_fleet_coverage experiment: analyst had 441KB of
MEMORY.md unindexed while faithfully following its checklist). Added as
Step 9.

### Added — `bus set-oauth-account <name>` for operator-directed account switching

`rotate-oauth` walks its candidate list and takes the **first account that
passes preflight**, which is the right behaviour for automatic
utilization-driven rotation but the wrong one when a specific account has
died and the operator has already chosen the replacement. There was no CLI
path to "switch to *this* account": the candidate order is
`Object.entries(accounts)` minus the current one, sorted by
`five_hour_utilization` — and for setup-tokens (`sk-ant-oat01-`) that field
is permanently `0`, so the sort is an arbitrary tie order rather than a
ranking. Worse, the setup-token preflight is a one-word inference ping, and
a cancelled subscription still *authenticates* — it only fails on real
workloads with `rate_limit_error` — so the ping happily green-lights a dead
account. Combined, `rotate-oauth --force` off a dead account would land
wherever insertion order happened to point, not where the operator wanted.

The remaining option was hand-editing `accounts.json`, which skips the
`rotation_log` entry and leaves every agent `.env` holding the old token.
`set-oauth-account` closes that gap by composing the two already-tested
primitives the daemon's own rotation manager uses — `setActiveAccount`
(flip + log) and `writeTokenToAgents` (surgical `CLAUDE_CODE_OAUTH_TOKEN=`
line replace, atomic write, `chmod 600`) — so a manual switch is recorded
and propagated exactly like an automatic one. It deliberately performs **no**
preflight, matching `setActiveAccount`'s documented contract: the operator
named the target, and the only signal available for setup-tokens is the ping
that cannot distinguish a live account from a cancelled one. Supports
`--agent` (scope the `.env` write), `--reason` (logged to `rotation_log`),
and `--json`. New coverage in `tests/unit/cli/bus-set-oauth-account.test.ts`
(6 cases: targets a non-first candidate, propagates while preserving
surrounding `.env` keys, logs the *outgoing* account's utilization,
`--agent` scoping, unknown-account rejection leaving both `accounts.json`
and every `.env` untouched, and `--json` shape).

### Fixed — evaluate-experiment's --score silently overwrote result_value/baseline_value

`evaluateExperiment` (`src/bus/experiment.ts`) reassigned its `measuredValue`
local to `options.score` whenever `--score` was given, then persisted that
reassigned value into `experiment.result_value` — so a qualitative
evaluation (the documented pattern: pass `0` as a measuredValue placeholder,
the real value in `--score`) silently destroyed the record of what was
actually passed as `measuredValue`, and there was no independent field to
recover it from. `Experiment` gains a `score: number | null` field;
`result_value` now always records the raw `measuredValue` argument
unconditionally, `score` records `--score` independently, and the
keep/discard decision (plus the next baseline, on keep) still uses the
"effective" value — score when given, else the raw measured value — matching
the original intent for qualitative metrics without corrupting the stored
record. `results.tsv` gains a `score` column **appended last**, after
`timestamp` — not inserted mid-row — since the header is only ever written
for a brand-new file; a pre-existing `results.tsv` keeps its original
8-column header forever, so a mid-row insert would have silently shifted
`baseline`/`decision`/`hypothesis`/`timestamp` one position out of alignment
with that old header on every future scored row (caught in review: an
agent's own live theta-wave `results.tsv` would have misaligned on its next
append). The `learnings.md` entry format for a scored evaluation now shows
the score, the raw measured_value, and the baseline separately instead of
one ambiguous number. New coverage in `tests/sprint3-experiments.test.ts` (7
cases: raw value preserved under `--score`, decision driven by score not the
placeholder, `score` is `null` when not given, both tsv-column shapes, and a
dedicated pre-existing-8-column-file case proving old rows and their header
stay untouched while new rows land correctly with `score` trailing).

### Fixed — template docs drift batch: broken date commands, phantom CLI flags, undocumented checker caveat

- **Unquoted `date` format strings** (9 files: AGENTS.md / HEARTBEAT.md /
  analyst memory skill across agent, agent-codex, analyst, orchestrator):
  the mandated memory-entry heredocs used `$(date -u +%H:%M UTC)` — on
  BSD/macOS date the unquoted `UTC` parses as an operand (`illegal time
  format`) and every memory entry written verbatim from the template got an
  EMPTY timestamp. Reproduced independently by two agents the same night.
  Now quoted: `$(date -u '+%H:%M UTC')`.
- **Phantom `--status` flag** removed from the `list-approvals` row in 5
  TOOLS.md templates — the CLI has no such option.
- **`check-deploy-drift` documented** in TOOLS.md Lifecycle tables with the
  load-bearing caveat: "clean" means source and build agree — the checker
  cannot see a running daemon still on older code (process-vs-dist drift),
  so a rebuild still needs a daemon restart to be fully deployed.

### Added — unique-prefix task id resolution in findTaskFile

Operators habitually copy truncated task ids (list-tasks' display
truncated them for a long time — fixed in #14 — and stale dists kept
showing the old format), and a truncated id dead-ended in "not found in
any org" even with the task sitting right there. `findTaskFile` now has a
tier-3 fallback after both exact-match tiers miss: a prefix matching
exactly one task resolves to it; an ambiguous prefix throws naming every
candidate (id + org) so the operator can disambiguate; no match preserves
the caller's existing not-found error. Exact-match behavior is untouched.
Benefits every consumer (update-task, complete-task, claim-task,
dependency checks) through the shared chokepoint.

### Added — bus-native activity broadcast fallback (fleet broadcast without Telegram)

`bus post-activity` previously required a Telegram activity channel
(`orgs/<org>/activity-channel.env` with `ACTIVITY_BOT_TOKEN` +
`ACTIVITY_CHAT_ID`) and went silently dark without one — while its failure
message pointed at the wrong file and key (`ACTIVITY_CHAT_ID` in
`secrets.env`, which `postActivity` never reads).

- **`src/bus/system.ts`**: new `broadcastActivityViaBus()` — fans the
  message out as a normal-priority `[ACTIVITY]`-prefixed inbox message to
  every enabled agent in the sender's org except the sender. Fleet-wide
  broadcast now has zero Telegram dependency, which matters for fleets
  with bus-only agents (no BOT_TOKEN at all).
- **`src/cli/bus.ts`**: `post-activity` falls back to the bus broadcast
  when no Telegram channel is configured (Telegram still wins when
  present), logs an `agent_activity/activity_broadcast` event, and the
  corrected failure text now names the real config file and both keys.
- Deliberately NOT wired into `approval.ts`'s `postActivity` call: approval
  posts carry Telegram inline-keyboard buttons that a bus message cannot
  render — silently downgrading them to inert text would break the
  approval flow. Fallback stays at the plain-message call site.

### Fixed — agent templates documented a KB CLI surface that does not exist

The AGENTS.md of the `agent`, `agent-codex`, `analyst`, and `orchestrator`
templates told every agent to pass a `--collection` flag that neither
`bus kb-ingest` nor `bus kb-query` accepts, and described a three-collection
model (`memory-{agent}` / `private-{agent}` / `shared-{org}`) that has never
existed in code — the real model is two collections, `agent-{agent}` and
`shared-{org}`, derived from `--scope`/`--agent`. Agents following the
template verbatim got hard CLI errors on the documented heartbeat re-ingest
command. Docs now match the implemented CLI exactly and state explicitly
that no `--collection` flag exists. (Template HEARTBEAT.md files were
already correct on main; found while restoring the fleet KB outage.)

### Fixed — empty env value in a later secrets file clobbered the real key, killing KB ingest fleet-wide

`loadSecretsEnv()` (`src/bus/knowledge-base.ts`) merges the framework `.env`
and the org `secrets.env` with later-file-wins semantics — and an EMPTY
value counted as a win. A placeholder `GEMINI_API_KEY=` line in
`orgs/<org>/secrets.env` (shipped by the org template) silently wiped the
valid key loaded from the framework `.env`, so every `bus kb-ingest` exited
with "No Gemini API key" and the fleet's semantic index went dark.

- **`src/bus/knowledge-base.ts`**: an empty value no longer overrides a
  non-empty value from an earlier file. Non-empty values still override
  normally, and an empty value with no earlier value is preserved.
- Deliberately scoped to the KB merge path: the PTY env injection in
  `src/pty/agent-pty.ts` shares the merge shape, but there an empty
  agent-`.env` line plausibly serves as an intentional "blank to disable"
  override (e.g. a bus-only agent blanking an org-level `BOT_TOKEN`), so
  changing it needs a deliberate design decision, not a drive-by.

### Fixed — `list-experiments` and `checkGoalStaleness` silently scoped to a subset, not the whole fleet

`bus list-experiments` with no `--agent` fell back to the caller's own
agentDir instead of scanning every agent — a completeness scan silently
returning a subset with no error. `checkGoalStaleness` had its own inline
`orgs/*/agents/*` scan that never covered namespaced personal agents
(`orgs/ORG/engineers/ENGINEER/agents/*`). Both were independent
reimplementations of "enumerate every agent" (a third being `list-agents`'s
own inline version) already drifting apart.

- **`src/utils/agent-dir.ts`**: new `discoverAllAgents()` — the single
  canonical fleet enumerator (enabled-agents.json + shared org agents +
  namespaced personal agents), extracted from `list-agents`'s inline logic.
- **`src/bus/experiment.ts`**: new `listAllExperiments()` — fleet-wide
  orchestration over `discoverAllAgents()`, independently testable.
- **`src/bus/system.ts`**: `checkGoalStaleness` migrated onto
  `discoverAllAgents()`, closing the namespaced-agent gap as a side effect
  of the same fix.
- `list-agents`, `list-experiments`, `check-goal-staleness` (bus CLI) all
  now share one enumerator — this class of drift is structurally closed,
  not just patched at two call sites.

### Fixed — auto-updater race on the shared `claude` binary took the fleet down

Every agent runs under its own `CLAUDE_CONFIG_DIR`, so every Claude Code
instance believes it is a standalone install and independently schedules its
own auto-update — but all agents share ONE binary
(`~/.local/bin/claude -> versions/<version>`). N private updaters, one shared
file, no lock.

On 2026-08-04 two agents' updaters fired 250ms apart (`14:05:30.564Z` and
`14:05:30.812Z`), both reported `install_failed`, and left
`~/.local/bin/claude` dangling at an already-deleted `2.1.220` for ~12
minutes. node-pty hands back a pid for a dangling symlink, then the child
exits 1 having written zero bytes — verified directly:

```
pid assigned: 69035
exitCode: 1  signal: 0
output bytes: 0 ""
```

The daemon could not distinguish that from an agent crash, so it charged the
daily crash budget with exponential backoff: `boss` burned 8 of 10, `analyst`
hit the cap and HALTED. The same shape had already fired 13 hours earlier
(analyst updated 00:46Z, crash-looped 01:08–01:28Z, HALTED) and went
unnoticed because the hang-detector happened to rescue it.

- **`src/pty/agent-pty.ts`** — `getBaseEnv()` now sets `DISABLE_AUTOUPDATER=1`
  for every agent PTY. Updating the runtime is an operator action taken when
  the fleet is quiet, not something N unsupervised agents each attempt against
  one shared file. *(Prevention.)*
- **`src/pty/agent-pty.ts`** — new exported `isBinaryAvailable(binary)`:
  resolves against PATH and checks `X_OK`. `existsSync` follows symlinks, so a
  dangling symlink and a partially-written binary both report unavailable.
- **`src/daemon/agent-process.ts`** — `handleExit()` gained a third
  "upstream condition, not agent malfunction" exemption alongside the
  image-poison and rate-limit blocks: an exit that is (1) code 1, (2) zero
  bytes written this lifecycle, and (3) accompanied by a binary that is not
  executable on PATH right now is retried WITHOUT charging
  `max_crashes_per_day`, logged as `BINARY_UNAVAILABLE_RECOVERY`. All three
  conditions must hold, so a genuine crash that merely coincides with an
  install window still counts. *(Resilience — also covers any other cause of a
  vanished runtime: botched upgrade, unmounted volume, bad PATH.)*
- **Retry cadence** is two-tier, keyed on how long the binary has been gone:
  30s for the first 15 minutes of an outage (a real install window is minutes,
  and a failed exec costs ~1ms, so polling is effectively free), then 5min
  after that — an outage that long is a broken runtime needing a human, not an
  in-flight install, and the slower tier bounds `restarts.log` growth without
  ever giving up (nothing else would bring the agent back). Outage age is
  derived from timestamps rather than an attempt counter, so no reset has to
  stay in sync with `start()`: a gap longer than the slow tier is itself the
  signal that the previous outage ended, and the next failure starts fresh.

### Added — canonical branch protection on `main`

`main` previously had zero branch protection (no required status checks, no
required reviews, no rulesets) — the only thing standing between a push and
`main` was individual discipline. Added, matching `conduit`'s live shape:

- Required status checks: `Build & Type Check`, `Dashboard Build`,
  `Unit Tests`, `Operational-leak scan` (all `github-actions`, app id 15368).
- 1 required approving review (`require_code_owner_reviews: false` — no
  `CODEOWNERS` file exists yet; can layer that on separately if one is added).
- `enforce_admins: false` — preserves the existing admin/agent squash-merge
  path (used throughout tonight's PR triage) for cases with no second
  reviewer available, same pattern already proven on `conduit`.
- No force-pushes, no deletions.

Step 0 of the low-risk auto-merge lane design
(`task_1785685546659`) — the lane should merge through required-checks, not
around an unprotected `main`.

### Fixed — hang-detector class 3: PreToolUse activity beat as a third liveness source

The Stop hook (`last_idle.flag`) only writes on turn COMPLETION, so a single
work turn longer than the hang-detector's 15min grace window — a build, a
full test suite, a long research pass — that spans a delivered cron fire
read as beatless for the turn's entire duration, even though the session was
actively working throughout. A healthy agent doing exactly that could
force-fresh-restart mid-work.

- **`src/hooks/hook-activity-beat.ts`** (new): PreToolUse hook, writes
  `state/<agent>/last_activity.flag` on EVERY tool call — mid-turn, unlike
  the Stop hook. Same minimal, fail-safe shape as `hook-idle-flag.ts`.
- **`src/daemon/hang-detector.ts`**: `maxBeat` generalized from two inputs to
  N; `evaluateHang`, `evaluateBootstrapHang`, and `hasBeatSinceRestart` now
  take an optional third source, `lastActivityBeatAt`, combined the same way
  `lastIdleFlagAt` was added in the 2026-07-13 dual-source fix.
- **`src/daemon/fast-checker.ts`**: `checkHangStatus()` reads
  `last_activity.flag` alongside the existing two sources and threads it
  through both hang evaluators and the restart-loop-counter reset check.
- **`src/cli/bus.ts`** / **`tsup.config.ts`**: wired `hook-activity-beat` as
  a CLI subcommand and build entry point (the exact miss that caused
  `hook-idle-flag` to ship silently-inert once before — see that commit).
- Registered in the `PreToolUse` hook array of every `.claude/settings.json`
  template (`templates/{agent,analyst,orchestrator}`,
  `community/agents/{security,research-agent}`) — applies to newly created
  agents. **Not** propagated to already-live agents' gitignored
  `orgs/*/agents/*/.claude/settings.json` copies — that's a fleet-wide
  runtime-behavior rollout decision left for a deliberate follow-up, not a
  silent side effect of this fix.
- Tests: `tests/unit/daemon/hang-detector.test.ts` (triple-source cases for
  both `evaluateHang` and `evaluateBootstrapHang`, plus `hasBeatSinceRestart`)
  and `tests/unit/daemon/fast-checker.test.ts` (`checkHangStatus` integration
  coverage mirroring the existing dual-source wiring tests).

### Fixed — `bus complete-task` / `update-task` uncaught-exception crash

An agent hit this live: `cortextos bus complete-task <id> --result "..."`
and `cortextos bus update-task <id> <status>` crashed on a task ID that
didn't resolve (`findTaskFile` returns `null`) — an uncaught exception
past the commander action handler, printing a raw Node stack dump that
ends in a `Node.js vX.Y.Z` trailer line. Piped through `tail` (as the
reporting agent had done while diagnosing), only that trailer survived,
reading as a mysterious bare crash.

- **`src/cli/bus.ts`**: wrapped both actions' calls (`completeTask` /
  `updateTask`) in try/catch, mirroring the pattern `claim-task`'s action
  already used — `console.error(err.message); process.exit(1)` instead of
  letting the throw become an uncaught exception. `completeTask`/
  `updateTask` themselves were already correct (throwing on a genuinely
  missing task is the right behavior) — the gap was purely at the CLI
  layer not catching it.
- **`bus/complete-task.sh`**: separately found and fixed while
  investigating — the wrapper only ever read `$2` as a bare positional
  result value, so `complete-task.sh <id> --result "<text>"` (the form
  every agent bootstrap doc teaches) set `RESULT="--result"` and silently
  dropped the real text (landed in `$3`, never read), storing the literal
  string `"--result"` as the completion result. Fixed by forwarding all
  args after `<id>` to the CLI as-is — it already accepts both the
  positional and `--result`-flag forms.
- Regression tests: `tests/integration/bus-task-error-handling-cli.test.ts`
  (drives the compiled CLI as a subprocess against a nonexistent task ID,
  asserts a clean one-line stderr message with no `Node.js v` trailer or
  stack frame, and that the happy path still works) and
  `tests/integration/bus-complete-task-wrapper.test.ts` (drives the bash
  wrapper directly, both invocation forms).

### Added — SP3b: Slack Socket Mode inbound channel

Agents can now be talked to on Slack, not just Telegram — critical path for
deploying a Hermes agent for a user whose only channel is Slack. Builds on
SP3a (outbound-only: `src/slack/api.ts`, `identity.ts`).

- **`src/slack/socket-mode.ts`** (new): `SlackSocketModeClient` — one shared
  WebSocket connection for the whole daemon (Slack is one app per workspace,
  not one bot per agent, unlike Telegram's per-agent `TelegramPoller`). Uses
  Node's native global `WebSocket` (stable since Node 22 — `engines.node`
  bumped `>=20.0.0` → `>=22.0.0` accordingly, no new runtime dependency
  added). Acks every `events_api` envelope within Slack's ~3s window
  (transport requirement, independent of downstream processing). An
  epoch/generation-counter guard makes stale-connection frames a no-op by
  construction after a reconnect — a positive invariant rather than relying
  on teardown-ordering correctness (the classic hand-rolled-reconnect bug
  class).
- **`src/slack/dispatcher.ts`** (new): routes one inbound Slack message to
  every agent whose `slack.json` allows it — channels are N:1 (multiple
  agents can watch one channel), unlike Telegram's inherent 1:1.
- **Fail-closed user allowlist**: `slack.json` gains `allowed_users`, keyed
  on `"<team_id>:<user_id>"` composite identity (not bare `user_id` — Slack
  user ids are workspace-scoped, not globally unique). Channel membership
  alone was judged too weak a gate (channels are N-member, membership drifts)
  — mirrors Telegram's `ALLOWED_USER` fail-closed default. An agent with an
  empty or missing `allowed_users` accepts messages from no one.
- **`src/daemon/fast-checker.ts`**: `queueSlackMessage` +
  `formatSlackTextMessage`, a queue parallel to (not shared with)
  `queueTelegramMessage` so Slack traffic doesn't drive the Telegram typing
  indicator. Reuses the existing content-hash `isDuplicate` dedup unmodified.
- **`src/daemon/agent-manager.ts`**: the org's orchestrator starts the one
  shared `SlackSocketModeClient` at boot (mirrors the existing org-level
  activity-channel-poller pattern), gated on `SLACK_APP_TOKEN` +
  `SLACK_BOT_TOKEN` being present.
- **`cortextos slack send`** (new, stable command name): what the injected
  "Reply using:" line invokes. `test-send` is unchanged.
- Setup runbook: `docs/runbook/sp3b-slack-socket-mode-setup.md`.

### Added — daemon-side rate-limit detection + OAuth auto-rotation

Twice in 28 hours (2026-07-14 weekly limit, 2026-07-15 5-hour session limit) the
whole fleet blocked on Claude Code's interactive rate-limit dialog; the hang
detector saw no-beat-after-fire and restart-looped agents into the same wall.
Recovery is now automatic:

- **`src/daemon/limit-detector.ts`** — pure banner detection over ANSI-stripped,
  whitespace-normalized PTY output (cursor-positioning escapes sit between words).
  Fires only on limit phrase + blocking-dialog marker together, so an agent merely
  quoting a limit message never triggers it. Parses `(UTC)` reset hints.
- **`src/daemon/rotation-manager.ts`** — reacts to limit events: marks the agent
  limit-blocked (`state/oauth/rotation-state.json`), preflights bench accounts,
  flips `accounts.json` active, rewrites agent `.env` tokens, restarts only the
  blocked agents, and Telegram-alerts once. All-dry → halt with a single alert and
  auto-retry at the earliest known reset. Recovered-in-place active accounts are
  detected and reused without a flip. 10-min rotation cooldown; 30-min proactive
  preflight of the active account rotates ahead of exhaustion.
- **`src/daemon/account-preflight.ts`** — preflight is a one-word **Opus**
  inference ping in an isolated `CLAUDE_CONFIG_DIR` (limits are model-bucketed,
  and setup-tokens lack the `user:profile` scope the usage API requires).
- **FastChecker** suppresses hang-restarts for limit-blocked agents — the
  rotation manager owns that recovery.
- **`src/bus/oauth.ts`** — new `setActiveAccount` helper; `writeTokenToAgents`
  exported for the daemon.

Verified live end-to-end (PTY banner → detection → rotation → targeted restart →
alert → cooldown) via a shimmed agent binary on 2026-07-16.

### Fixed — topology guard: argv/env instance agreement + single-daemon-per-instance boot guard

- **The daemon now parses `--instance` argv and refuses to start when it
  disagrees with env `CTX_INSTANCE_ID`** (new `src/daemon/instance-guard.ts`).
  Env-only resolution was the 2026-07-13 two-daemon root cause: a
  `pm2 start --update-env` from a shell without `CTX_INSTANCE_ID` re-baked the
  gateway-named app onto instance `default` — duplicate fleet, bus
  double-delivery. The mismatch error names both values and the exact operator
  fix.
- **Single-daemon-per-instance boot guard**: the daemon refuses to boot when
  its instance's `daemon.pid` already points at a live process that isn't
  itself, instead of silently overwriting the pidfile and joining a
  split-brain. Unknown states (missing/stale/corrupt pidfile) boot normally —
  it only refuses on a positively-indicated live daemon. Ownership is
  verified via a new `daemon.start-time` anchor (epoch-ms process start time,
  written anchor-first/atomically): a live pid whose start time mismatches
  the anchor is a **recycled pid** (crash-orphaned pidfile) and boots instead
  of false-refusing; `daemon.pid` itself stays bare-int for operator `cat`s
  and the deploy-runbook invariant. NOTE: the daemon uses pm2 restart /
  stop-then-start, NEVER `pm2 reload` — reload spawns-new-before-kill-old, so
  this guard structurally refuses it by design.

### Fixed — cron scheduler: infeasible dom+month expressions rejected before the minute scan

- `nextFireFromCron` now pre-checks that at least one expanded month admits at
  least one expanded day-of-month. An impossible-but-per-field-valid expression
  (`0 0 31 2 *` — Feb 31) previously walked the entire 366-day scan window —
  527K `formatToParts` calls, ~1.2s measured against ~3.5ms for a normal
  expression — just to return NaN, on every schedule reload and every
  `list-crons` next-fire preview. The pre-check rejects in O(fields) before the
  Intl formatter is built. `29 2` (Feb 29) deliberately remains feasible; leap
  years are the scan's question. Fast-follow to the timezone fix below, which
  introduced the per-minute Intl cost.

### Fixed — freeze-cure: context-handoff default-ON + fleet-wide bridge wiring

The daemon shipped a full context-handoff mechanism (thresholds, tiers, handoff
prompt, `.force-fresh` pre-arm) that **never fired**, so agents ran to context
exhaustion and froze (one orchestrator reached ~928k / ~93% of a 1M window before
freezing for ~51h). Two dead gates in series were responsible:

- **Primary (make-or-break): the context-status bridge was unwired.** The monitor
  reads `state/<agent>/context_status.json`, which is only written by the
  `cortextos bus hook-context-status` statusLine hook — and that hook was wired
  into **0** agents. `checkContextStatus` returned at `!existsSync` before any
  threshold logic ran, so `pct` was always null and the whole mechanism was inert.
  - The three agent **templates** (`agent`, `analyst`, `orchestrator`) now ship
    the `statusLine` hook so new agents emit context data.
  - New `scripts/wire-statusline.mjs` (idempotent, `--dry-run`) wires the hook into
    existing agents' gitignored local `.claude/settings.json` — a `statusLine`-only
    patch that does not touch permissions. Agents must be restarted to apply.
- **Secondary: handoff was observe-only by default.** An unset
  `ctx_handoff_threshold` meant observe-only (log, never act). It now **defaults ON**
  at warn 30% / handoff 60% of the model window; an explicit `ctx_handoff_threshold
  <= 0` is the deliberate opt-out.

Safety envelope so default-ON is at least as safe as the source mechanism:

- **Fleet handoff lease** (`src/daemon/context-handoff-lease.ts`): caps concurrent
  handoffs (2) and staggers the rest, so the first-ever fleet-wide context flow
  can't become a thundering-herd restart storm. Release-safe (by name, session-id
  independent, on fresh session / Tier-3 teardown) so a slot never leaks.
- **Cooperative-restart loop backstop**: the circuit breaker now also counts Tier-2
  handoff fires in a persisted 15-min window and trips (30-min pause + alert) if a
  runtime fails to reset context on the handoff restart — so a handoff treadmill
  self-limits regardless of cause.
- **Overflow-banner corroboration guard**: the PTY-overflow backstop now only fires
  when context usage corroborates it (exceeds 200k, or pct ≥ 85), so a fresh boot
  re-reading memory/source that *documents* the overflow phrase no longer
  force-restarts on every boot.

Covered by `tests/unit/daemon/context-handoff-lease.test.ts` (herd drain + leaked-
lease edges) and `tests/unit/daemon/context-handoff-defaulton.test.ts` (default
truth-table + loop backstop + overflow guard). Ported/reconciled from upstream #685
against this fork's already-evolved handoff machinery (#194 `.force-fresh` pre-arm
was already present).

### Added — freeze-cure: hang detection (DETECTION half)

Complements the context-handoff PREVENTION path: catches the *non-context* freeze mode
— a `--continue`-resumed session frozen mid-turn that processes no cron fires — which no
context-% threshold can see (this is what took out several fleet agents).

- **`last_session_heartbeat`** on the heartbeat record — advanced ONLY by a genuine
  session-authored `update-heartbeat --source session` (the new default). The 50-min
  watchdog beat (`--source watchdog`) and the log-event timestamp bump preserve it and
  never advance it, so the sensor keys on the *real* signal (session processing) rather
  than `last_heartbeat`, which the watchdog keeps fresh even for a dead session.
- **`update-heartbeat --source <session|watchdog>`** flag; the daemon idle-watchdog
  (`fast-checker`) now beats with `--source watchdog`. `updateHeartbeat` carries the prior
  `last_session_heartbeat` forward on a watchdog beat (it rewrites the whole object).
- **`src/daemon/hang-detector.ts`** (pure, unit-tested sensor): HUNG iff a delivered cron
  fire (`crons.json` `last_fire_attempted_at`) is older than a grace window (~15min) AND
  the most-recent session beat predates it. Batching-aware (keys on the most-recent
  delivered fire). **Fail-safe by construction** — absent field, absent fire, parse error,
  or any ambiguity falls through to *not* hung. Idle-exit ≠ hang: a resumed idle session
  writes a Part-A beat after its fire, so it never trips.
- **Actuator** (`fast-checker` `checkHangStatus`/`forceHangRestart`): force-fresh restart
  (never `--continue`, which re-hangs) with a persisted **halt-after-3-in-30min** breaker
  so the auto-healer can't itself loop, plus a cooldown and a daemon-sent Telegram alert
  to the agent's chat on restart and on HALT. Governing bias: **fail safe toward
  not-restarting** (a missed hang is re-caught on the next fire; a false restart disrupts
  a healthy agent). Covered by `hang-detector.test.ts` + `heartbeat-source.test.ts`.

### Fixed — daemon agent-registry ↔ PTY-liveness reconcile

- **reapOrphan accretion guard** (follow-up to the reconcile below): `reapOrphan`
  now clears the pidfile and reports `reaped: true` ONLY when the process is
  actually gone (exited on SIGTERM, or a confirmed-ownership SIGKILL). On the
  fail-closed skip path — alive but no longer ownership-verified before SIGKILL —
  it leaves the pidfile in place so the orphan is retried by the next boot-reap
  instead of becoming untracked (accretion), and returns `reaped: false`.
- **Restart-tooling divergence**: `cortextos stop <agent>` could silently no-op
  while the agent stayed alive ("stop didn't kill it"), and `cortextos start`
  could return "deduped — already in registry" on a *dead* agent. Root cause: the
  daemon's in-memory agent registry (`AgentManager.agents`) was never reconciled
  against real PTY liveness; agents are PTY children of the daemon (not pm2 apps),
  so when the Map diverged from reality the ops no-op'd against reality.
  - **start**: a dead-but-registered entry is now evicted before the dedup guard,
    so a fresh start proceeds instead of DEDUPE-ing forever. Never kills — the
    process is already gone.
  - **stop / boot orphan-reap**: a PTY that survived a prior daemon generation is
    now reaped, but ONLY after ownership verification — the pid must be alive AND
    its process start-time must match the recorded spawn. This guards the
    catastrophic pid-recycling case (a reused pid belonging to an unrelated
    process is NEVER killed); it fails closed on any doubt.
  - New `src/utils/agent-pidfile.ts` persists each agent's PTY pid + start-time +
    spawning-daemon pid to `state/<agent>/agent.pid`; new `AgentProcess.getPid()`.
    Covered by `tests/unit/utils/agent-pidfile.test.ts` (incl. explicit
    recycling-guard tests that assert an unverified live pid is never killed).

### Hook Framework — Loop Detection (B1)

- **`hook-loop-detector`**: new PreToolUse hook that detects and blocks repeated Claude tool-call loops. Two patterns are detected: (a) the same tool invoked with identical arguments 15+ times within the last 30 calls, and (b) two tools ping-ponging (24+ alternations within a 12-call dominant-pair window). Blocked calls are NOT recorded into history, so the wedge cannot self-perpetuate. History is time-windowed (60s) so a stale prior-session tail does not block the first call of a new session. After 30 minutes of continuous block, exactly one tool call is allowed through ("emergency escape") so the agent can issue a Telegram alert before re-entering the blocked window.
- **`cortextos bus hook-loop-detector`**: CLI subcommand to invoke the hook, follows the existing hook-runner pattern.
- **Settings wiring**: agent / orchestrator / analyst templates and the security community agent now ship with the hook enabled by default in `.claude/settings.json` (PreToolUse, no matcher, 5s timeout).
- **State**: `${CTX_ROOT}/state/<agent>/loop-detector.json`. Recoverable from corruption (bad JSON → empty state).

### Added
- SP3a — Slack outbound. New `src/slack/` (SlackAPI client + per-agent
  identity loader). `cortextos slack {test-send, discover-channels}` CLI.
  `bus/_slack-curl.sh` + `bus/send-slack.sh` shell entry points. Per-agent
  `slack.json` schema (display_name, icon_emoji, channels, allowed_channels).
  Cloud-init pulls `slack-bot-token` from Key Vault into `/etc/cortextos.env`
  at boot. Runbook walkthrough for the one-time Slack app registration
  (`docs/runbook/sp3a-slack-app-setup.md`). App registered & installed to the
  WYRE workspace (app id `A0B8MN37YSC`); verified end-to-end on the live VM
  by posting to #general as `boss` with the per-agent username override.
- SP2c-4 — dashboard env auto-provisioning at first boot. Cloud-init
  generates `ADMIN_PASSWORD` and `AUTH_SECRET`, writes them to
  `dashboard/.env.local`, and stores recoverable copies in Key Vault as
  `dashboard-admin-password` and `dashboard-auth-secret`. Idempotent via
  sentinel file. VM managed identity granted `Set` on Key Vault. A fresh
  VM now presents a working dashboard login on first visit with no
  manual env hacking.
- Per-engineer agent namespaces: personal agents live under
  `orgs/<org>/engineers/<engineer>/agents/<name>`, addressed as `<engineer>/<name>`.
- `cortextos add-engineer <name>` command to scaffold a namespace.
- `templates/engineer` namespace template.
- Centralized agent-directory resolution (`src/utils/agent-dir.ts`).
- `pm2ProcessName` helper for future per-agent PM2 entries.
- SP2b — first-boot bootstrap and steady-state systemd units. A freshly
  provisioned VM (via `infra/terraform/`) boots into a working cortextOS
  install: data disk formatted and mounted at `/var/lib/cortextos`,
  `cortextos` system user, repo cloned to `/opt/cortextos` with `orgs/`
  symlinked into the data disk, `cortextos init` scaffolding the org,
  and `cortextos.service` running the daemon + dashboard under
  `pm2-runtime`.
- `infra/bin/check-systemd-drift.sh` keeps the embedded and standalone
  systemd unit definitions in `cloud-init.yaml.tftpl` and `infra/systemd/`
  in sync (Python+YAML based).
- SP2c-1 — daily data-disk backups via Azure Backup (Data Protection): backup
  vault, daily disk-snapshot policy (14-day retention), and a backup instance
  protecting the data disk, with snapshots in a dedicated snapshot resource
  group. Verified end-to-end (on-demand backup job + snapshot).
- `docs/runbook/sp2-host.md` — operations runbook (SP2c-3: backup, teardown, day-to-day ops, disk growth, tunnel re-auth, restore drill, rollback, break-glass, SSO troubleshooting).
- SP2c-2 — Cloudflare Tunnel + Zero-Trust Access. The dashboard is reachable at
  `https://wyre-agents.wyre.ai` and ops SSH at `wyre-agents-ssh.wyre.ai`
  through a Cloudflare Tunnel (no public IP), gated by Entra-SSO Access limited
  to `@wyretechnology.com`. `cloudflared.service` runs the tunnel from a token
  stored in Key Vault and fetched at first boot via the VM's managed identity.
  Host-based subdomain routing — no dashboard code change.

### Changed
- `cortextos ecosystem` now uses `next start` when `NODE_ENV=production`
  (was hardcoded `next dev`, which caused 30-second cold compiles per
  route on deployed installs). Cloud-init bootstrap also passes
  `NODE_ENV=production` when calling `cortextos ecosystem`.
- `listAgents` also discovers namespaced agents.
- `cortextos ecosystem` agent count now includes namespaced agents.
- `cortextos ecosystem` now emits the daemon entry even when zero agents
  are configured, with a warning. Previously refused to generate the file,
  which broke the first-boot bootstrap path.
- `AGENT_NAME_REGEX` exported from `src/utils/validate.ts` for reuse.
- Forked to `wyre-technology/cortextos`; `CONTRIBUTING.md` documents upstream sync.

### Fixed
- **Test suite green: repaired the three remaining pre-existing failures and
  the import-broken integration files.** (1) hooks: the symlink-escape tests
  used un-canonicalized `mkdtempSync` paths, so on macOS (`/var` →
  `/private/var`) the permission-gate's containment check failed before the
  symlink logic ran — tests now `realpathSync` their temp dirs; confirmed the
  gate itself is correct and fail-closed, and the symlink-security assertions
  now genuinely exercise the real code path on macOS. (2) add-agent: the
  BUG-041 PascalCase test asserted the old `validateAgentName()` error quoting;
  the namespace-support change moved validation to `parseQualifiedName()`
  (same guarantee — rejection before any filesystem write) with double-quoted
  names. Assertion is now quote-tolerant. (3) Four integration test files
  (`phase4-dashboard-backtest`, `phase4-performance`, `phase5-e2e-simulation`,
  `phase5-user-journeys`) runtime-imported `next/server`, a dashboard-only
  dependency absent from root installs, so the whole files failed to load on
  fresh checkouts. The workflows route handlers only use the standard WHATWG
  Request surface, so the tests now build plain `Request`s via a
  `makeRouteRequest` helper (type-only NextRequest cast, erased at transpile).
  38 construction sites converted; 72 previously-unloadable tests now run.
- **BUG-011 "regression" alarms were false positives from cross-org duplicate
  discovery — with a real resurrection side effect.** The default instance
  discovers ALL orgs (legacy behavior kept by BUG-061), and production has the
  same five agent names in both `orgs/wyre` and `orgs/wyre-gateway`. Every
  daemon boot, the duplicate copies hit `startAgent()` while the originals
  were registered, firing "BUG-011 REGRESSION CHECK: X still in registry"
  warnings and poisoning `pendingRestarts` with entries that later fired on
  any intentional stop — resurrecting explicitly-stopped agents, and
  resurrecting agents **mid-shutdown** during `stopAll()`, where the fresh
  FastChecker is killed moments later by `process.exit()` mid-poll: the exact
  kill window that orphans inbox `.lock.d` mutexes (see the stale-lock fix).
  Two changes: (1) `discoverAndStart()` dedupes by agent name — one name, one
  agent; the daemon's own startup org wins the claim deterministically,
  first-discovered otherwise; duplicates are skipped with an info log and
  never reach `startAgent()`. (2) `stopAgent()` no longer honors queued
  restarts while `stopAll()` is in flight; shutdown discards the queue with a
  log line. The genuine-race safety net (queue on live-registry collision,
  honor on single-agent stop) is preserved and pinned by tests. Also repaired
  the three BUG-043 multi-org tests that BUG-061's instance-scoping had left
  stale (they now construct the manager as the `default` instance).
- **Permanent inbox deadlock from orphaned `.lock.d` (silent no-reply agents).**
  `acquireLock()` treated a `.lock.d` whose `pid` file was missing or
  empty/corrupt as "holder mid-acquire, retry" with no staleness escape — but a
  holder killed between `mkdirSync(.lock.d)` and `writeFileSync(pid)` (pm2
  restart, daemon crash, shutdown) never writes a valid pid, so the
  PID-liveness stale check could never run and the lock wedged **forever**.
  `checkInbox()` compounded it by silently returning `[]` on lock failure, so
  wedged agents kept answering Telegram/crons while never receiving bus
  messages (observed 2026-07-01: 8 inboxes across two instances stranded
  ~84 messages for 2–4 days — the "inconsistent agent replies" bug).
  `acquireLock()` now steals a missing/corrupt-pid lock once it is older than
  30s (`STALE_LOCK_MS`, ~6 orders of magnitude above the real mkdir→write
  gap), preserving mid-acquire protection; live-holder and dead-pid-recovery
  semantics unchanged. `checkInbox()` now logs a rate-limited warning (once
  per inbox per minute) when it cannot acquire the lock, so a wedged inbox
  can never be silent again.
- **BUG-061 — multi-instance roster bleed.** A non-default daemon instance
  (e.g. `--instance wyre-gateway`, `CTX_ORG=wyre-gateway`) started the *wrong*
  roster: `AgentManager.discoverAgents()` scans every org under the shared
  framework root, and the instance enable-list is disable-only (absence ⇒
  enabled, per BUG-028), so a second instance re-discovered and started the
  default instance's agents (a different org). Instances were isolated by
  `CTX_ROOT` (state) but not by agent roster. `discoverAndStart()` now skips
  any discovered agent whose `resolveAgentOrg(name)` differs from the daemon's
  `CTX_ORG` — **only for non-default instances**; the `default` instance keeps
  the legacy discover-all-orgs behavior (multi-org / single-install catch-all),
  so there is zero change to existing single-instance installs. Paired with the
  `ecosystem.config.js` PM2 process-name suffix (`cortextos-daemon-<instance>`
  for non-default instances; `default` stays `cortextos-daemon`) so multiple
  instances run side-by-side without renaming/restarting the running default
  fleet.

## [0.2.0] — 2026-05-04 — External Persistent Crons

Crons move from session-local (`/loop`, `CronCreate`) to daemon-managed `crons.json` files under `${CTX_ROOT}/state/{agent}/`. Auto-migrates from existing `config.json` on first daemon boot. Fully backward-compatible additive feature.

### Phase 5.4 — Race Hardening & Workspace Teaching

- **iter 9 fix**: `lastGoodSchedule` fallback now distinguishes a legitimately-empty `crons.json` from a corrupt parse failure, so emptying a file no longer keeps stale crons firing.
- **iter 10 fix**: persist `last_fire_attempted_at` to prevent crash-mid-fire double-fire on next daemon restart.
- **iter 11 fix**: defer scheduler reload while a fire is in flight, and lazy-create the scheduler when a reload hits a start-window gap (no missed first fire after re-enable).
- **iter 12 fix**: serialize bus `add-cron` / `update-cron` / `remove-cron` operations to fix lost-update race when concurrent edits land on the same agent.
- **Race test pins**: dedicated regression tests for iter 9 / 10 / 12 race conditions plus remove-cron mid-fire (no double-fire).
- **`bus upgrade-cron-teaching` CLI scanner**: scans CLAUDE/AGENTS/ONBOARDING/SKILL files for stale `CronCreate` / `/loop` references and reports advisories. Pure advisory by default; `--apply` for safe substitutions.
- **`migrate-crons` cron-teaching upgrade banner**: daemon emits one advisory line per agent on first migration, drops `.cron-teaching-checked` marker (idempotent).

### Phase 5.3 — Failure Mode & Recovery

- **`lastGoodSchedule` snapshot in `CronScheduler`**: if a `reload()` produces an empty schedule (transient corruption), the scheduler retains the last successfully loaded schedule in memory and keeps firing until the file is repaired. In-memory only — does not survive daemon restarts.
- **`.bak` rotation in `writeCrons`**: `atomicWriteSync` now accepts a `keepBak` flag; `writeCrons` passes `keepBak: true` so every atomic write preserves the previous `crons.json` as `crons.json.bak`.
- **`.bak` fallback in `readCrons`**: on primary-file parse failure, `readCrons` automatically retries with `crons.json.bak`. Single-step automatic recovery without operator intervention.
- **ENOSPC/EACCES catch in `tick()`**: disk-full and read-only-filesystem errors when persisting `last_fired_at` are caught and logged; the in-memory schedule is preserved and crons continue firing.

### Phase 4 — Cron Dashboard

- **`/workflows` fleet overview page**: health summary panel + paginated read-only cron table across all agents, with agent and name search filters.
- **`/workflows/health` dedicated health page**: gap detection, health-status breakdown, and per-cron health rows for the entire fleet.
- **`/workflows/[agent]/[name]` cron detail page**: edit form (schedule, prompt, enabled, description), execution history viewer, and test-fire button.
- **`/workflows/new` page**: create a new cron for any enabled agent.
- **POST/PATCH/DELETE API routes** at `/api/workflows/crons/...`: routed through IPC (`handleAddCron`, `handleUpdateCron`, `handleRemoveCron`) with full input validation and scheduler reload after each mutation.
- **Test-fire button** (`/api/workflows/crons/[agent]/[name]/fire`): confirmation dialog, inline pending state, 30-second cooldown enforced client-side and server-side (IPC `handleFireCron`). Auto-refreshes execution history 6s after success.
- **`manualFireDisabled` flag**: setting this field on a cron definition disables the test-fire button (HTTP 403) for that cron. Useful for crons that must only fire on schedule.
- **Execution log pagination + filter + export**: history viewer supports status filter (All/Success/Failure), "Older"/"Newer" pagination with total count, and CSV/JSON export via dedicated executions API route.
- **Fleet health caching**: `computeFleetHealth` caches results for 30 seconds; cache is invalidated after any mutation or manual fire.
- **IPC commands**: `add-cron`, `update-cron`, `remove-cron`, `fire-cron`, `fleet-health`, `list-cron-executions` added to `IPCServer.handleRequest`.

### Phase 1–3 — External Persistent Cron Engine

- Crons migrated from session-local (`/loop` / `CronCreate`) to daemon-managed `crons.json` files under `${CTX_ROOT}/state/{agent}/`.
- `CronScheduler` with 30-second tick, 5-field cron expression parser, interval shorthand support, catch-up-once policy, and 3-attempt exponential backoff (1s/4s/16s).
- `readCrons` / `writeCrons` / `addCron` / `updateCron` / `removeCron` / `getCronByName` in `src/bus/crons.ts`.
- Auto-migration from `config.json` on first daemon boot per agent (`.crons-migrated` marker).
- Execution log (JSONL) with `fired` / `retried` / `failed` status entries.
- IPC `reload-crons`, `list-all-crons` commands.

---

## [0.1.1] — 2026-03-30

### Improvements

- **`/api/kb/search` result fields**: Added `filename`, `chunk_index`, `total_chunks`, and `content_full_length` to the KB search response. These fields come from mmrag.py's per-result metadata and are useful for UI display (show basename, chunk position within a document). `agent_name` and `org` now pull from the top-level JSON envelope when available rather than falling back to the request parameters.

- **`max_crashes_per_day` config field**: Added to `AgentConfig` type and all three agent templates (`config.json`). Default raised from 3 to 10 — the previous default halted agents after three transient crashes, which was too aggressive for production. Agents in high-activity environments can set a custom limit.

- **README — Agent Configuration section**: New section documenting all `config.json` fields with types, defaults, and descriptions. Includes cron format reference.

---

## [0.1.0] — 2026-03-30

### cortextOS Node.js — Initial Release

Complete TypeScript/Node.js implementation of the cortextOS agent framework. Full feature parity with the bash reference implementation. 307 unit and integration tests, 0 failures. npm-ready.

---

## What is cortextOS

cortextOS is a persistent 24/7 multi-agent framework built on Claude Code. Agents run as PM2-managed PTY processes, communicate over a file-based message bus, manage tasks, log analytics events, and are controlled via Telegram. This Node.js package ships the entire framework as a single `npm install` with a unified `cortextos` CLI.

---

## Core Features Shipped

### Message Bus

File-based inter-agent messaging with strict format parity with the bash reference implementation.

- **Priority queue**: `urgent > high > normal > low`. `checkInbox()` always returns messages sorted by priority.
- **Inbox lifecycle**: `send → inbox → inflight (on read) → processed (on ACK)`. Three-directory atomic flow.
- **Filename convention**: `{pnum}-{epochMs}-from-{sender}-{rand5}.json` where `pnum` encodes priority (0=urgent, 1=high, 2=normal, 3=low) for filesystem-native sort ordering.
- **Message ID format**: `{epochMs}-{from}-{rand5}` — globally unique, sortable, human-readable.
- **reply_to field**: Present on every message (null if no reply). Auto-ACKs the original on bus reply.
- **Undelivered redelivery**: Un-ACK'd messages in inflight redeliver after 5 minutes (daemon-level).
- **Urgent signal**: `notifyAgent()` writes `.urgent-signal` to state dir AND sends a bus message for persistence.

### Task Management

17-field task format with full lifecycle tracking.

- **Fields**: `id, title, description, type, needs_approval, status, assigned_to, created_by, org, priority, project, kpi_key, created_at, updated_at, completed_at, due_date, archived`
- **Status states**: `pending → in_progress → completed` (plus `blocked`, `cancelled`)
- **Task ID format**: `task_{epochMs}_{rand3}` — sortable, collision-resistant
- **`createTask()`**: Creates with all 17 fields, atomic write to `orgs/{org}/tasks/{id}.json`
- **`updateTask()`**: Updates status and `updated_at`, preserves all other fields
- **`completeTask()`**: Sets `status: completed`, `completed_at`, and `result` summary
- **`listTasks()`**: Scans task directory, excludes archived, supports `{ agent, status, org }` filters
- **`checkStaleTasks()`**: Identifies in-progress tasks untouched >2h, pending tasks unstarted >24h, and overdue tasks past `due_date`
- **`archiveTasks()`**: Moves completed tasks older than 7 days to `tasks/archive/`, sets `archived: true`. Supports `dry_run` mode.
- **`checkHumanTasks()`**: Finds tasks assigned to `human` or `user` that are stale (>24h pending, >2h in-progress)
- **Blocked task flow**: `update-task blocked "reason" <blocker_id>` — records `blocked_by` field, auto-sends unblock message when blocker completes

### Event Logging (Analytics)

JSONL-based event stream for dashboard Activity feed and analytics aggregation.

- **`logEvent()`**: Appends to `orgs/{org}/analytics/events/{agent}/{YYYY-MM-DD}.jsonl`
- **Event schema**: `{ id, timestamp, agent, org, category, event, level, data }`
- **Categories**: `action`, `task`, `milestone`, `error`, `system`
- **Levels**: `info`, `warning`, `error`
- **`getEvents()`**: Reads JSONL files with date-range filtering and agent/org filtering
- **`aggregateMetrics()`**: Aggregates events into task counts, session counts, KPI scores per agent

### Heartbeat System

Periodic liveness signals with context for dashboard status cards.

- **`updateHeartbeat()`**: Atomic write to `heartbeats/{agent}.json`
- **Heartbeat schema**: `{ agent, org, timestamp, last_heartbeat, status, current_task, mode, loop_interval }`
- **`readAllHeartbeats()`**: Scans heartbeats directory, returns all agents' current status
- **Running detection**: Heartbeat age <60s → agent considered `running: true`
- **`readHeartbeat()`**: Single agent read, returns null if file missing

### Approval Workflow

Pre-action approval gate for external or sensitive operations.

- **`createApproval()`**: Writes to `orgs/{org}/approvals/pending/{id}.json`
- **Approval ID format**: `approval_{epochMs}_{rand6}`
- **Fields**: `id, title, category, context, status, requesting_agent, org, created_at, resolved_at, decision_note`
- **Categories**: `external-comms`, `financial`, `deployment`, `data-deletion`, `other`
- **`updateApproval()`**: Moves from `pending/` to `resolved/` on approve/reject
- **Status values**: `pending`, `approved`, `rejected`
- **Blocked task integration**: Approval ID stored in task's `blocked_by` field; auto-unblocks on decision

### Knowledge Base (RAG / mmrag)

Semantic memory via the multimodal-rag Python library (mmrag.py).

- **`queryKnowledgeBase()`**: Runs mmrag.py query, returns `{ results: [{content, score, source}], total }`
- **`ingestKnowledgeBase()`**: Indexes documents from a path into a named collection
- **`listCollections()`**: Lists all ChromaDB collections with document counts
- **Collections**: `shared-{org}` (org-wide, all agents) and `agent-{name}` (private per-agent)
- **Environment setup**: Auto-sets `MMRAG_DIR`, `MMRAG_CHROMADB_DIR`, `MMRAG_CONFIG` for every subprocess call
- **Instance isolation**: KB root derived from `CTX_ROOT` basename — each cortextOS instance has its own KB
- **Auto-init**: `kb-ingest.sh` auto-calls `kb-setup.sh` if `config.json` is missing
- **`kb-setup.sh`**: Creates venv, installs mmrag deps, writes default `config.json`

### Experiment System (Theta Wave)

Structured hypothesis-test-evaluate loop for autonomous agent experimentation.

- **`createExperiment()`**: Creates experiment file with `id, metric, hypothesis, status, created_at`
- **`runExperiment()`**: Executes experiment, records `started_at`, transitions to `running`
- **`evaluateExperiment()`**: Records outcome, transitions to `completed` or `failed`
- **`manageCycle()`**: Manages full experiment cycle with pass/fail/continue logic
- **`loadExperimentConfig()`**: Reads `experiments/config.json` for `approval_required` and other settings
- **Approval gate**: If `experiments/config.json` has `approval_required: true`, `create-experiment` CLI auto-creates an approval and blocks until approved

### Agent Discovery

- **`listAgents()`**: Reads `config/enabled-agents.json` as authoritative source. Falls back to `orgs/` directory scan only when `CTX_FRAMEWORK_ROOT` is explicitly set in environment.
- **`buildAgentInfo()`**: Enriches agent entries with heartbeat data (status, current_task, mode), role from `IDENTITY.md`, enabled status from `config.json`
- **`notifyAgent()`**: Writes urgent signal file + sends bus message

### Catalog / Skills Marketplace

- **`browseCatalog()`**: Lists available skills from the community catalog
- **`installCommunityItem()`**: Installs a skill into an agent's skills directory
- **`prepareSubmission()`**: Packages a skill for community submission
- **`submitCommunityItem()`**: Submits a skill package to the catalog

### System / Lifecycle

- **`postActivity()`**: Sends activity update to Telegram (reads BOT_TOKEN/CHAT_ID from `.env`)
- **`selfRestart()`**: Writes `.restart-planned` marker, triggers soft restart (preserves conversation history via `--continue`)
- **`hardRestart()`**: Writes `.force-fresh` + `.restart-planned` markers, triggers fresh session
- **`uninstall()`**: Stops PM2, removes `enabled-agents.json`. With `--keep-state`: preserves CTX_ROOT. Without: full removal.

---

## CLI Reference (`cortextos`)

### Agent Management

| Command | Description |
|---------|-------------|
| `cortextos init` | Initialize a new cortextOS instance |
| `cortextos add-agent <name> --template <type>` | Create a new agent from template |
| `cortextos enable <name>` | Enable an agent (adds to enabled-agents.json) |
| `cortextos start <name>` | Start an agent (via PM2) |
| `cortextos stop <name>` | Stop an agent (via PM2) |
| `cortextos status` | Show all agents' status, heartbeat age, current task |
| `cortextos list-agents [--org <org>]` | List agents with heartbeat/role info |
| `cortextos list-skills` | List available skills |
| `cortextos install` | Install/configure cortextOS on this machine |
| `cortextos uninstall [--keep-state]` | Remove cortextOS |
| `cortextos doctor` | Diagnose common configuration issues |
| `cortextos dashboard` | Start the Next.js dashboard |

### Bus Subcommands (`cortextos bus <cmd>`)

#### Messaging
| Command | Description |
|---------|-------------|
| `bus send-message <to> <priority> '<text>' [reply_to]` | Send agent-to-agent message |
| `bus check-inbox` | Read and display pending inbox messages |
| `bus ack-inbox <msg_id>` | ACK a message (moves to processed) |
| `bus send-telegram <chat_id> '<text>'` | Send Telegram message |

#### Tasks
| Command | Description |
|---------|-------------|
| `bus create-task '<title>' ['<desc>']` | Create a new task |
| `bus update-task <id> <status> ['<note>'] ['<blocker_id>']` | Update task status |
| `bus complete-task <id> ['<result>']` | Mark task complete with result summary |
| `bus list-tasks [--agent <name>] [--status <s>] [--org <o>]` | List tasks with filters |
| `bus check-stale-tasks` | Report stale in-progress, stale pending, and overdue tasks |
| `bus archive-tasks [--dry-run]` | Archive completed tasks older than 7 days |
| `bus check-human-tasks` | Find tasks assigned to human/user that need attention |

#### Events
| Command | Description |
|---------|-------------|
| `bus log-event <category> <event> <level> [json_data]` | Append event to analytics JSONL |
| `bus get-events [--agent <a>] [--days <n>]` | Read recent events |

#### Heartbeat
| Command | Description |
|---------|-------------|
| `bus update-heartbeat '<status>'` | Write heartbeat with current status |
| `bus read-all-heartbeats` | Read all agents' heartbeats |

#### Approvals
| Command | Description |
|---------|-------------|
| `bus create-approval '<title>' '<category>' '<context>'` | Create approval request |
| `bus update-approval <id> <approved\|rejected> ['<note>']` | Resolve an approval |

#### Experiments
| Command | Description |
|---------|-------------|
| `bus create-experiment '<metric>' '<hypothesis>'` | Create experiment (auto-approval if configured) |
| `bus run-experiment <id>` | Start an experiment run |
| `bus evaluate-experiment <id> <pass\|fail> ['<notes>']` | Record experiment outcome |
| `bus list-experiments [--status <s>]` | List experiments |
| `bus manage-cycle` | Run the full experiment cycle |

#### Knowledge Base
| Command | Description |
|---------|-------------|
| `bus kb-query '<question>' --org <o> [--agent <a>] [--scope <s>]` | Semantic search |
| `bus kb-ingest <path> --org <o> [--agent <a>] [--scope shared\|private]` | Index documents |
| `bus kb-collections --org <o>` | List collections with document counts |

#### System
| Command | Description |
|---------|-------------|
| `bus self-restart --reason '<why>'` | Soft restart (preserves history) |
| `bus hard-restart --reason '<why>'` | Hard restart (fresh session) |
| `bus notify-agent <target> '<message>'` | Send urgent signal to agent |

---

## Dashboard API Endpoints

All routes require `Authorization: Bearer <token>` header (except `/api/auth/*`).

### Agents

| Method | Route | Description |
|--------|-------|-------------|
| GET | `/api/agents` | List all agents with heartbeat, role, status |
| GET | `/api/agents/[name]` | Get single agent details |
| POST | `/api/agents` | Create new agent |
| GET | `/api/agents/[name]/crons` | List agent's cron jobs |
| POST | `/api/agents/[name]/crons` | Create cron job |
| DELETE | `/api/agents/[name]/crons` | Delete cron job |
| POST | `/api/agents/[name]/lifecycle` | Start/stop/restart agent |
| GET | `/api/agents/[name]/logs` | Stream agent activity log |
| GET | `/api/agents/[name]/memory` | Read agent's memory file |
| POST | `/api/agents/[name]/typing` | Set typing indicator |

### Tasks

| Method | Route | Description |
|--------|-------|-------------|
| GET | `/api/tasks` | List tasks (filters: agent, status, org, priority) |
| POST | `/api/tasks` | Create task |
| GET | `/api/tasks/[id]` | Get single task |
| PATCH | `/api/tasks/[id]` | Update task status/fields |
| DELETE | `/api/tasks/[id]` | Delete task |

### Approvals

| Method | Route | Description |
|--------|-------|-------------|
| GET | `/api/approvals` | List approvals (filters: status, org) |
| POST | `/api/approvals` | Create approval |
| GET | `/api/approvals/[id]` | Get single approval |
| PATCH | `/api/approvals/[id]` | Approve or reject |

### Messages

| Method | Route | Description |
|--------|-------|-------------|
| POST | `/api/messages/send` | Send message to agent |
| GET | `/api/messages/history/[agent]` | Get message history (inbox + processed) |
| GET | `/api/messages/stream/[agent]` | SSE stream for real-time messages |
| POST | `/api/messages/upload` | Upload image/file for message |

### Analytics

| Method | Route | Description |
|--------|-------|-------------|
| GET | `/api/analytics/overview` | Aggregated metrics: tasks, events, cost, KPIs per agent |
| GET | `/api/events` | Recent activity events (filters: agent, category, days) |
| GET | `/api/events/stream` | SSE stream for real-time activity feed |

### Experiments (Theta Wave)

| Method | Route | Description |
|--------|-------|-------------|
| GET | `/api/experiments` | List experiments (filters: status, org) |
| POST | `/api/experiments` | Create experiment |

### Knowledge Base

| Method | Route | Description |
|--------|-------|-------------|
| GET | `/api/kb/search?q=<query>&org=<org>` | Semantic search across KB collections |
| GET | `/api/kb/collections?org=<org>` | List collections with document counts |

### Skills / Catalog

| Method | Route | Description |
|--------|-------|-------------|
| GET | `/api/skills` | List available skills and community catalog |

### Sync

| Method | Route | Description |
|--------|-------|-------------|
| POST | `/api/sync` | Sync file-system state to SQLite (tasks, approvals, events) |

### Goals / Org

| Method | Route | Description |
|--------|-------|-------------|
| GET | `/api/goals` | Read org goals from `goals.json` |
| GET | `/api/orgs` | List organizations |

### Auth / Mobile

| Method | Route | Description |
|--------|-------|-------------|
| GET/POST | `/api/auth/[...nextauth]` | NextAuth session management |
| POST | `/api/auth/mobile` | Mobile app token authentication |
| POST | `/api/notifications/register` | Register push notification token |

### Media

| Method | Route | Description |
|--------|-------|-------------|
| GET | `/api/media/[...filepath]` | Serve local media files (images, logs) |

---

## Shell Wrapper Scripts (`bus/`)

All scripts delegate to `dist/cli.js bus <cmd>` after sourcing `_ctx-env.sh` for environment variables.

| Script | Bus Command |
|--------|-------------|
| `send-message.sh` | `bus send-message` |
| `check-inbox.sh` | `bus check-inbox` |
| `ack-inbox.sh` | `bus ack-inbox` |
| `send-telegram.sh` | `bus send-telegram` |
| `create-task.sh` | `bus create-task` |
| `update-task.sh` | `bus update-task` |
| `complete-task.sh` | `bus complete-task` |
| `log-event.sh` | `bus log-event` |
| `update-heartbeat.sh` | `bus update-heartbeat` |
| `read-all-heartbeats.sh` | `bus read-all-heartbeats` |
| `create-approval.sh` | `bus create-approval` |
| `update-approval.sh` | `bus update-approval` |
| `create-experiment.sh` | `bus create-experiment` |
| `run-experiment.sh` | `bus run-experiment` |
| `evaluate-experiment.sh` | `bus evaluate-experiment` |
| `list-experiments.sh` | `bus list-experiments` |
| `manage-cycle.sh` | `bus manage-cycle` |
| `kb-setup.sh` | (direct Python, no bus equivalent) |
| `kb-query.sh` | `bus kb-query` |
| `kb-ingest.sh` | `bus kb-ingest` |
| `kb-collections.sh` | `bus kb-collections` |
| `self-restart.sh` | `bus self-restart` |
| `hard-restart.sh` | `bus hard-restart` |
| `browse-catalog.sh` | `bus browse-catalog` |
| `install-community-item.sh` | `bus install-community-item` |
| `prepare-submission.sh` | `bus prepare-submission` |
| `submit-community-item.sh` | `bus submit-community-item` |

---

## Agent Templates

Three templates ship in `templates/`:

### `templates/agent/`
General-purpose persistent agent. 24/7, Telegram-controlled, task-focused.
- `CLAUDE.md` — session start protocol, task workflow, messaging format, cron setup, restart procedures
- `IDENTITY.md` — name, role, personality (fill in for each agent)
- `SOUL.md` — values and operating principles
- `GOALS.md` — current objectives and KPIs
- `HEARTBEAT.md` — heartbeat protocol and cron configuration
- `MEMORY.md` — long-term memory index
- `USER.md` — user profile (who the agent reports to)
- `TOOLS.md` — available bus commands reference
- `SYSTEM.md` — system architecture notes
- `config.json` — cron definitions, max session seconds
- `.claude/settings.json` — hooks: plan mode approval, permission requests, ask-user-question, all routed to Telegram

**Skills included**:
- `skills/tasks/` — task lifecycle, KPI logging, stale task detection
- `skills/comms/` — Telegram and agent-to-agent message formats
- `skills/cron-management/` — cron setup, persistence, troubleshooting
- `skills/agent-management/` — spawn, enable, disable, restart agents
- `skills/m2c1-worker/` — autonomous software builds via M2C1 framework
- `skills/worker-agents/` — ephemeral worker session management

### `templates/orchestrator/`
Multi-agent coordinator. Manages task assignment, morning briefings, agent health.
- All agent files plus orchestrator-specific `CLAUDE.md` with 4 crons: morning briefing, task scan, evening wrap, agent health check
- `skills/agent-management/` — full lifecycle management for subordinate agents
- `skills/m2c1-worker/` — spawn M2C1 build sessions
- `skills/worker-agents/` — manage ephemeral workers

### `templates/analyst/`
Research and analytics specialist. Reads metrics, generates reports, tracks KPIs.
- 5 crons: weekly analytics, daily KPI scan, monthly cost report, experiment review, competitive analysis
- Ecosystem config for org-wide analytics
- `skills/agent-management/` — monitor and report on agent health

---

## Test Suite

**307 tests, 0 failures, 0 skipped.**

| Suite | File | Tests | Coverage |
|-------|------|-------|---------|
| Sprint 1 — Templates | `sprint1-templates.test.ts` | 24 | All template files, config schemas, no bash $CTX_FRAMEWORK_ROOT/bus/ references |
| Sprint 2 — Lifecycle | `sprint2-lifecycle.test.ts` | 8 | Agent enable, onboarding flag, config validation |
| Sprint 3 — Experiments | `sprint3-experiments.test.ts` | 12 | Full experiment CRUD, cycle management, approval gate |
| Sprint 4 — Catalog | `sprint4-catalog.test.ts` | 8 | Browse, install, prepare, submit community items |
| Sprint 5 — Metrics | `sprint5-metrics.test.ts` | 15 | Event aggregation, cost tracking, KPI scoring |
| Sprint 6 — Fast Checker | `sprint6-fastchecker.test.ts` | 18 | Telegram polling, callback routing, AskUserQuestion TUI |
| Sprint 7 — Environment | `sprint7-environment.test.ts` | 10 | CTX_ROOT resolution, env var parsing, path isolation |
| Sprint 8 — Dashboard | `sprint8-dashboard.test.ts` | 12 | Sync, SQLite integrity, API payload validation |
| Unit — Messages | `unit/bus/message.test.ts` | 22 | Send, receive, priority sort, format parity with bash |
| Unit — Tasks | `unit/bus/task.test.ts` | 9 | Create, update, complete, list with filters |
| Unit — Task Management | `unit/bus/task-management.test.ts` | 18 | Stale detection, archive, human tasks, backdated fixtures |
| Unit — Agents | `unit/bus/agents.test.ts` | 8 | listAgents, notifyAgent, heartbeat enrichment, IDENTITY.md parsing |
| Unit — System | `unit/bus/system.test.ts` | 6 | postActivity, env parsing, token validation |
| Unit — Daemon | `unit/daemon/*.test.ts` | 24 | FastChecker, message handling, callback routing |
| Unit — Hooks | `unit/hooks/*.test.ts` | 14 | Plan mode hooks, permission hooks, ask hooks |
| Unit — Utils | `unit/utils/*.test.ts` | 12 | Path resolution, atomic write, ID generation |
| Unit — Telegram | `unit/telegram/*.test.ts` | 18 | Message formatting, photo handling, keyboard markup |
| E2E — Lifecycle | `e2e/lifecycle.test.ts` | 15 | Full round-trips: message bus, task lifecycle, multi-agent coordination, approval workflow, format parity |
| Integration | `integration/*.test.ts` | 14 | CLI integration, bus command round-trips |


## Infrastructure

### CI/CD

`.github/workflows/ci.yml` — three-job GitHub Actions pipeline:

1. **`build`**: TypeScript type check (`tsc --noEmit`) + full build (`npm run build`) + CLI smoke test (`cortextos --version`)
2. **`test`**: Vitest full suite (depends on `build` job passing)
3. **`dashboard-build`**: Next.js type check + production build

Triggers: push to `main`, `feat/*`, `fix/*` branches; all pull requests.

### Directory Structure

```
cortextos/
├── src/
│   ├── bus/          # Core bus modules (message, task, event, heartbeat, approval, experiment, knowledge-base, agents, catalog, system, metrics)
│   ├── cli/          # CLI entry points (bus.ts, dashboard.ts, doctor.ts, ecosystem.ts, enable-agent.ts, init.ts, install.ts, list-agents.ts, list-skills.ts, notify-agent.ts, start.ts, status.ts, stop.ts, uninstall.ts)
│   ├── daemon/       # FastChecker daemon (Telegram polling, message routing, callback handling)
│   ├── hooks/        # Claude Code hook handlers (plan mode, permissions, ask-user-question, crash alert)
│   ├── types/        # TypeScript type definitions
│   └── utils/        # Atomic write, path resolution, ID generation
├── bus/              # Shell wrapper scripts (delegate to dist/cli.js bus)
├── dashboard/        # Next.js 14 dashboard (App Router, TypeScript, Tailwind)
├── templates/
│   ├── agent/        # General-purpose agent template
│   ├── orchestrator/ # Multi-agent coordinator template
│   └── analyst/      # Research/analytics agent template
├── skills/           # Community skills catalog
├── tests/
│   ├── unit/         # Unit tests (bus, daemon, hooks, utils, telegram)
│   ├── e2e/          # End-to-end lifecycle tests
│   ├── integration/  # CLI integration tests
│   └── sprint1–8/    # Sprint-level feature tests
└── .github/
    └── workflows/
        └── ci.yml    # Build, test, dashboard CI pipeline
```

---

## Migration Notes (from bash cortextOS)

The Node.js implementation is **format-compatible** with the bash reference implementation. All file formats match exactly:

- Message JSON: identical field set (`id, from, to, priority, timestamp, text, reply_to`)
- Task JSON: identical 17-field schema
- Heartbeat JSON: identical field set including `last_heartbeat`, `current_task`, `mode`
- Event JSONL: identical schema
- Approval JSON: identical schema (note: `rejected` not `denied`)
- Inbox filename convention: `{pnum}-{epochMs}-from-{sender}-{rand5}.json` matches bash

**One breaking difference from earlier Node.js versions**: task status was `'done'` in pre-release builds. The canonical value is `'completed'`, matching bash and dashboard. If you have existing task files with `"status": "done"`, run:

```bash
find orgs/*/tasks -name "*.json" -exec sed -i '' 's/"status": "done"/"status": "completed"/g' {} +
```
