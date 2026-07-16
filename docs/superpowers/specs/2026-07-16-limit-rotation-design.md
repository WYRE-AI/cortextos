# Daemon-side rate-limit detection + OAuth auto-rotation

**Date:** 2026-07-16
**Status:** Approved (Aaron, 2026-07-16)
**Context:** Twice in 28 hours (2026-07-14 weekly limit, 2026-07-15 5-hour session
limit) the whole fleet blocked on Claude Code's interactive rate-limit dialog. The
hang detector correctly saw no-beat-after-fire and restart-looped agents into the
same wall. Recovery was manual both times. The OAuth rotation system
(`src/bus/oauth.ts`) has accounts + rotation + `.env` writing but nothing invokes
it automatically, and its usage-API preflight 403s on setup-tokens (they lack the
`user:profile` scope).

## Goals

1. The daemon recognizes a rate-limit-blocked session and stops treating it as hung.
2. The daemon rotates the fleet to a healthy account automatically and restarts
   only the blocked agents.
3. When every account is exhausted, the daemon halts restarts, alerts once via
   Telegram, and auto-retries at the earliest known reset time.
4. A periodic preflight rotates *ahead* of exhaustion so agents rarely block at all.

Non-goals: per-agent account assignment (single-active-account model stays),
usage-API integration (incompatible with setup-tokens), multi-org support beyond
what `writeTokenToAgents` already handles.

## Components

### 1. `src/daemon/limit-detector.ts` (new, pure)

- `scanForLimit(window: string): LimitEvent | null` where `LimitEvent =
  { kind: 'weekly' | 'session' | 'usage' | 'unknown', resetAt: number | null,
  matchedText: string }`.
- Input is an ANSI-stripped rolling window (~4 KB) of an agent's PTY output.
- Fires only when BOTH appear in the window: the limit phrase
  (`You've hit your … limit`) AND the blocking-dialog marker
  (`What do you want to do?` or `/rate-limit-options`). The pair requirement
  prevents false positives from agents quoting limit messages in conversation.
- `parseResetHint(text, now)` extracts `resets 3am (UTC)` / `resets Jul 20 at 6am
  (UTC)` style hints into epoch ms (null when unparseable). Times without a date
  resolve to the next future occurrence relative to `now`.
- Pure functions, injected `now`, fixture-tested with real banners from the
  2026-07-14/15 incident logs.

### 2. `src/daemon/rotation-manager.ts` (new)

State file: `state/oauth/rotation-state.json` —
`{ limitBlocked: { [agent]: { detectedAt, kind, resetAt } }, lastRotationAt,
haltedUntil, retryAt }`.

On limit event for agent A:
1. Mark A limit-blocked (persist).
2. If within rotation cooldown (10 min since `lastRotationAt`), stop — A stays
   blocked and suppressed; it will be restarted by the in-flight/next rotation.
3. Candidate order: accounts != active in `accounts.json` insertion order,
   skipping any with a known future `resetAt` recorded in rotation-state
   (`exhausted: { [account]: resetAt }`, written when a preflight fails with
   limit text and cleared once `now > resetAt`).
4. Preflight = one-word **Opus** inference ping (`claude -p` with isolated
   `CLAUDE_CONFIG_DIR` + candidate token). Opus because limits are model-bucketed;
   a haiku pass proves nothing about the bucket the fleet burns. Ping runs with a
   3-minute timeout; timeout/nonzero exit with limit text = candidate exhausted;
   other failures = candidate skipped (not marked exhausted).
5. First passing candidate: update `accounts.json` (active + rotation_log entry),
   call existing `writeTokenToAgents`, restart ONLY agents in `limitBlocked`,
   clear their flags, send one Telegram summary, set `lastRotationAt`.
6. No passing candidate: set `haltedUntil`/`retryAt` = min(known resetAt) + 5 min,
   fallback now + 30 min. Send ONE Telegram alert (dedup while halted). At
   `retryAt`, re-run rotation attempt.

### 3. Hang-detector integration (`src/daemon/fast-checker.ts`, minimal edit)

Where the hang verdict currently triggers auto-restart: if the agent is
limit-blocked (per rotation-state), skip the restart and log
`[agent] limit-blocked — hang restart suppressed (rotation manager owns recovery)`.
Flag clears on rotation-restart or when the agent's `last_idle.flag` advances past
`detectedAt` (proof of recovery, e.g. limit window reset on its own).

### 4. Proactive preflight (in rotation-manager, timer in daemon startup)

Every 30 min, ping the ACTIVE account (same Opus ping). On limit-failure, run the
rotation flow proactively (no agents blocked yet → restart set is empty; working
agents roll over lazily via their own banner events). On other failures, log only.

### 5. Wiring (`agent-pty.ts` / `agent-process.ts` / daemon startup)

- Per-agent rolling window updated in the existing `onData` handler; strip ANSI,
  append, trim to 4 KB, scan. Debounce: after an event fires for an agent,
  suppress re-fires for 5 min or until the flag clears (TUI re-renders the same
  banner constantly).
- Rotation manager instantiated once in the daemon; PTY scanners and the
  preflight timer feed it events. Telegram via the daemon's existing send path.

## Testing

- Vitest units: limit-detector (real-banner fixtures, quote-only negative case,
  reset-hint parsing incl. date rollover), rotation-manager decision logic with
  injected clock + fake preflight/restart/telegram (follows `hang-detector.ts`'s
  injected-`now` pattern).
- Live verify: point one agent's `.env` at the exhausted aaronmsachs token,
  restart it, watch detection → suppression → rotation → restart complete.

## Rollout

Build via tsup as usual; deploy = `pm2 restart cortextos-daemon` (agents keep
running). Rotation constants live at module top: `ROTATION_COOLDOWN_MS = 10 min`,
`PREFLIGHT_INTERVAL_MS = 30 min`, `RETRY_FALLBACK_MS = 30 min`,
`REFIRE_SUPPRESS_MS = 5 min`, `WINDOW_BYTES = 4096`.
