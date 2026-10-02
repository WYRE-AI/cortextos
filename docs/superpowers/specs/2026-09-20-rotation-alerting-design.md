# Daemon rate-limit/rotation alerting: notify on block, fix alert routing

**Date:** 2026-09-20
**Status:** Draft — scope items 1-3 fully specified by boss (`task_1789871169166_86948952`);
items 4-5 added during this doc after a scope-relevant discovery, confirmed by boss
(msg `1789899314935-boss-dr2cv`).
**Context:** 2026-09-18/19/20 incident — 10 of 14 agents parked on Claude Code's own
interactive `/rate-limit-options` menu for ~32 hours because all 3 candidate OAuth
accounts were simultaneously exhausted on the same shared weekly window. Detection
(`limit-detector.ts`'s `LimitScanner`, wired live per-agent) and recovery
(`rotation-manager.ts`'s `doRotation`, auto-restarting every blocked agent the
instant a working account was found) both already existed and worked correctly and
automatically — see `MEMORY.md`'s `RESOLVED 2026-09-20T02:1xZ` entry for the full
mechanism trace. **The only real gap: nobody was told this was happening for the
~32h it was known and scheduled.** This doc is that fix.

## Goals

1. Alert immediately when an agent transitions into limit-blocked (not on every
   re-fire of an already-known block).
2. Alert when `doRotation` finds zero viable candidates, with the earliest known
   reset ETA across all candidates.
3. State-change alerts only — no per-PTY-chunk or per-tick spam. Reuse existing
   suppression (`LimitScanner`'s own `REFIRE_SUPPRESS_MS`, `ROTATION_COOLDOWN_MS`).
4. The alert actually reaches a human who is watching for it, deterministically —
   not whichever agent happened to register Telegram first.
5. When an alert send fails, that failure is observable — not silently swallowed.

Non-goals: rearchitecting the rotation/detection state machine (goal 1-2's
mechanisms already work, per the incident trace); a general daemon-side
fire-attempted-vs-turn-consumed comparison framework (raised by analyst re:
`task_1789870803680_27937547` — out of scope for this task, different piece of
work, not assumed here).

## Investigation: item 2 already exists

Before writing anything, checked whether the halt alert (goal 2) already exists —
per this org's own repeatedly-learned lesson (2026-09-20 hook-freeze trap #4:
"check for partial/full implementation before building fresh"). It does:
`rotation-manager.ts:377-394` (`doRotation`'s tail) already computes
`retryAt = min(known resetAt across exhausted+limitBlocked) + 5min` and sends
exactly one alert, gated by `state.alertedHalt`, containing that ETA. Verified via
existing tests (`tests/unit/rotation-manager.test.ts:89-101`,
`:153-206`) and via tonight's own incident (`pm2` log shows the identical halt
message logged 34+ times over the 32h window — logged every time `doRotation`
re-reaches the branch, but `sendAlert` only actually fires once per the
`alertedHalt` gate, exactly as designed). **No code change needed for goal 2.**

## Investigation: why "nobody was told" despite a working halt alert

This is the part that changed the scope of the fix, so it's written up in full
rather than just asserted.

`agent-manager.ts:519`: `if (telegramApi && chatId && !this.alertHandle)
this.alertHandle = { api: telegramApi, chatId }` — the single Telegram handle
`RotationManager.sendAlert` uses fleet-wide is claimed by whichever agent's
`startAgent()` call registers Telegram *first* in the daemon process's lifetime,
permanently (guarded by `!this.alertHandle`, never re-evaluated), with no log line
naming the winner and no way to configure it.

Traced the *actual* current process, not an inference from pattern-matching:
`$CTX_ROOT/daemon.start-time` = `1788796809000` =
`2026-09-07T16:00:09Z`, matching `pm2`'s `pm_uptime` for pid 1263 exactly
(`restart_time: 0`). The pm2 out-log contains 20 `[daemon] Starting cortextOS
daemon` markers (prior process lifetimes appended to the same file); the last one,
at line 169838, is this boundary. Immediately following it: `adoption` starts (no
Telegram — empty token), then **`analyst`** at line 169850 — `[analyst] Telegram
configured` — 16 lines before `boss`'s own registration at line 169866. `analyst`
claimed `alertHandle` 11 days before the incident, not `boss`.

Since `CHAT_ID` is the same numeric value across all 15 agents (a 1:1 Telegram DM's
chat_id equals the human's own user id regardless of which bot it is), the question
became: did the alert actually get delivered via analyst's bot (a different
conversation thread than boss's bot, even though the chat_id number matches), or
did the send itself fail? Two independent checks, both pointing the same way:

- Live `getMe` against analyst's current `BOT_TOKEN` → `200 OK` (`wyreAnalystBot`,
  id `8708815017`). Token is valid right now.
- Grepped the entire retained pm2 log for any `analyst`-tagged Telegram error —
  zero hits for 401/Unauthorized/Conflict/error across the whole file. Only
  ordinary "poller started" lines tied to normal agent restarts.

A token dead for exactly the 32h incident window and healthy immediately before
and after, with zero failure signature anywhere in the log, is very unlikely —
tokens don't self-heal. **Conclusion: the halt alert (and the per-agent
limit-blocked rotation logs before it) were almost certainly sent successfully —
into analyst's bot conversation thread, not a channel anyone was watching as a
fleet-ops alert destination.** That is the actual 32-hour gap, not a code defect
in the alert-firing logic itself.

One more thing surfaced while checking this, worth fixing regardless of the above:
**there is no log instrumentation of delivery outcome at all.**
`agent-manager.ts:165` is `handle.api.sendMessage(handle.chatId,
text).catch(() => {})` — silently swallows any failure (401, timeout, network),
and there is no log line on success either. The forensic question "did it send,
did it fail" was answerable here only by going around the logs entirely (the
`daemon.start-time` file + a live `getMe` probe). That should not be necessary
next time.

## Components

### 1. `src/daemon/rotation-manager.ts` — per-agent block alert (goal 1)

In `onLimitEvent`, before writing `state.limitBlocked[agent]`, check whether
`agent` is already a key (i.e., this is a *new* block, not a re-observation of an
existing one — `LimitScanner` already re-fires roughly every 5 minutes per stuck
agent via its own `REFIRE_SUPPRESS_MS`, so without this check a prolonged incident
with several stuck agents would alert every few minutes, which is exactly the
spam goal 3 rules out). On a genuinely new block, `sendAlert` a short message
naming the agent, `ev.kind`, and the parsed reset time if known (`ev.resetAt`),
before calling `attemptRotation` as today. No new state fields — `state.limitBlocked`
already carries exactly what's needed to detect the transition.

Goal 2 needs no change (see Investigation above).

### 2. `src/daemon/agent-manager.ts` — alert routing (goal 4)

Replace first-past-the-post claiming with a named, configured recipient:

- New optional env var on the daemon, e.g. `ROTATION_ALERT_AGENT` (default
  `"boss"` if unset — matches this org's existing convention of boss owning
  fleet-ops/Aaron comms, per `MEMORY.md`).
- In the `startAgent` registration path (where `alertHandle` is currently
  claimed): if `name === configuredAlertAgent` and Telegram is configured for it,
  claim `alertHandle` (overwriting any earlier fallback claim). If the configured
  agent never registers Telegram (disabled, missing token), keep the existing
  first-registered-wins behavior as a fallback — but log it clearly, e.g.
  `[agent-manager] ROTATION_ALERT_AGENT="boss" has no Telegram configured — fleet
  alerts falling back to "<name>" instead`.
- Log the winner unconditionally at the moment `alertHandle` is set, both for the
  configured-match and fallback cases — closes "no log line says who won" outright,
  independent of which policy path fires. This alone would have made tonight's
  32-hour gap immediately diagnosable instead of requiring the boot-order forensic
  trace above.

### 3. `src/daemon/agent-manager.ts` — delivery logging (goal 5)

Change `sendAlert`'s callback from a bare `.catch(() => {})` to log both
outcomes: success (`[agent-manager] rotation alert delivered to "<name>"`) and
failure (`[agent-manager] rotation alert FAILED to send via "<name>": <error>`).
Cheap, no behavior change on the RotationManager side (still fire-and-forget —
alert delivery must never block or fail rotation itself), just makes the outcome
observable for the first time.

## Verify items (per boss — not blockers, carried forward)

1. **`restartAgent` kill cleanliness.** Read `AgentProcess.stop()`
   (`agent-process.ts:290`): sends the runtime-appropriate clean-exit signal
   (`/exit` + CRLF for Claude Code, Ctrl-D for hermes, Ctrl-C for opencode, a
   no-op wait for codex-app-server's exec-per-turn model), sleeps, and the
   surrounding `stopAgent`/`restartAgent` (`agent-manager.ts:1109,1184`) fully
   `await`s it before `startAgent` runs again, under a cross-path restart lock
   (`tryAcquireRestartLock`). Read as sound; found no gap requiring a change here.
   Not independently verified with a live forced-kill test — leaving as an open
   verify item exactly as boss framed it, not escalating to a blocker.
2. **Scenario: a non-exhausted candidate is available but a blocked agent still
   fails to restart.** Already handled: `doRotation`'s restart loop
   (`rotation-manager.ts:291-299`, `:339-345`) catches `restartAgent` errors
   per-agent, logs, and leaves that agent in `state.limitBlocked` rather than
   dropping it — so it's retried on the next tick. Confirmed the next tick
   actually re-attempts: a successful rotation sets `retryAt = null`
   (`:301`,`:348`), and `tick()`'s condition (`:183`) is
   `retryAt === null || t >= retryAt`, so the very next 60s tick retries
   immediately. No silent-loss path found.

## Testing

New `tests/unit/rotation-manager.test.ts` cases:
- `onLimitEvent` alerts exactly once for a *new* block, message names agent +
  kind + resetAt.
- `onLimitEvent` does NOT re-alert when the same agent re-fires while already
  blocked (repeated banner re-render).
- Existing halt-alert tests (`:89-101`, the PR #54 infra-vs-exhaustion suite)
  unchanged — goal 2 has no code delta.

New `tests/unit/agent-manager` coverage (or wherever `alertHandle` claiming is
currently untested — check first, per the same "verify before building" rule
applied above):
- Configured `ROTATION_ALERT_AGENT` with Telegram present claims the handle even
  when a different agent registers first.
- Configured agent absent/no-Telegram falls back to first-registered, with the
  fallback log line asserted.
- `sendAlert` logs on both a resolved and a rejected `sendMessage` promise
  (injected fake `TelegramAPI`).

## Rollout

Per the 2026-08-22 standing lesson (root `CLAUDE.md`): this repo backs the live
15-agent daemon binary via a shared checkout — all development and testing for
this task happens in `.worktrees/rotation-alerting` (branch
`feat/rotation-alerting`), never directly in `~/cortextos`. Build via `tsup` as
usual; deploy = `pm2 restart cortextos-daemon` (agents keep running, matches the
existing rotation-manager rollout note in the 2026-07-16 spec this one extends).
