// Hang detector — the SENSOR half of the freeze-cure DETECTION path (analyst spec,
// 2026-07-07 TRIGGER-SPEC). Distinct from the context-handoff PREVENTION path: this
// catches non-context / environmental hangs where a `--continue`-resumed session is
// frozen and processes no cron fires, which no context-% threshold can detect.
//
// The signal: a delivered fire with NO proof-of-activity since is an unambiguous hang.
// We key on that — NEVER on last-seen staleness, which the 50-min watchdog beat and
// log-event bumps keep fresh even for a dead session.
//
// DUAL-SOURCE (2026-07-13 correction): "proof-of-activity" is the more recent of TWO
// signals — last_session_heartbeat (only advances on an explicit `update-heartbeat`
// call) and last_idle.flag (the Stop hook, which fires on EVERY turn completion
// regardless of which cron triggered it). The ORIGINAL design assumed an
// "always-heartbeat-FIRST convention" — that a healthy session's first action on ANY
// delivered fire is a session-authored update-heartbeat. That assumption was FALSE:
// only the `heartbeat` cron's own prompt instructs update-heartbeat; the other cron
// prompts (check-approvals, morning-review, etc.) never do. A healthy agent silently
// processing one of those for 15+min with no intervening heartbeat-cron fire has a
// frozen last_session_heartbeat despite being genuinely alive — confirmed root cause
// of the 2026-07-13 ~15:02 UTC false restart (and the self-perpetuating restart storm
// it triggered, since a freshly-spawned session reproduces the identical false
// baseline). last_idle.flag closes this: it can't lie about real turn-processing the
// way an unfired heartbeat-cron can look like silence.
//
// TRIPLE-SOURCE (class-3 fix): last_idle.flag itself only writes on turn COMPLETION
// (the Stop hook). A single work turn longer than the grace window — a build, a full
// test suite, a long research pass — that spans a delivered cron fire is beatless on
// BOTH prior sources for the turn's entire duration, even though the session is
// actively working throughout. last_activity.flag (the PreToolUse hook, written on
// EVERY tool call, mid-turn) closes this: it's proof of liveness that doesn't wait
// for the turn to end.
//
// CONFIRMED INTERACTION — loop-detector can keep an agent reading "not hung" while it
// is genuinely stuck spinning (PR #55 review, 2026-08-01). hook-loop-detector.ts (a
// SEPARATE PreToolUse hook, registered as its own array entry alongside this one) can
// actively BLOCK a repeated-tool-call loop. Per Claude Code's documented hook-execution
// model, PreToolUse hooks in different array entries run in PARALLEL with NO
// short-circuit on block (verified against the official hooks reference, not
// inferred) — so hook-activity-beat's subprocess still runs and still writes
// last_activity.flag on EVERY tool-call ATTEMPT, including ones loop-detector denies.
// The masking is therefore CONTINUOUS for as long as the agent keeps attempting calls,
// not just on loop-detector's periodic 30-min emergency-escape allowance.
//
// This is INTENTIONAL, not a bug to fix here: a tool-call loop is a different failure
// class than a hang — the agent is alive and actively trying things, just unproductively
// — and that class belongs to loop-detector (alert + block), not this module (blind
// restart). A --continue restart of a loop-stuck agent would just resume it back into
// the same loop, since the loop lives in the conversation/tool-call pattern, not in a
// frozen process. So last_activity.flag correctly staying fresh here, and hang-detector
// correctly NOT firing, is the right behavior IF AND ONLY IF loop-detector's own
// block/escape signal reliably reaches a human for diagnosis+intervention — see the
// loop-detector-alert-routing follow-up this pin depends on. Two ways to close the gap
// if that routing ever proves unreliable: (a) make the alert-routing itself reliable
// (preferred — it's the more precise signal, purpose-built for this exact failure), or
// (b) bound activity-beat's masking here in hang-detector.ts: don't let it suppress a
// hang indefinitely when BOTH last_idle_flag AND last_session_heartbeat are stale
// beyond a larger secondary threshold (that combination — lots of tool activity, zero
// turn completions, zero heartbeats — IS the loop signature; a legitimately long-but-
// healthy turn still completes or heartbeats eventually, so it stays protected either
// way). Pick one path before this fix is allowed to activate (i.e. before it ships in a
// coordinated restart) — see docs/runbook/daemon-restart-2026-08.md's pre-restart
// checklist.
//
// GOVERNING PRINCIPLE — FAIL SAFE TOWARD NOT-RESTARTING: a missed hang is cheap (the
// next delivered fire re-catches it); a false restart disrupts a healthy agent and, at
// fleet scale, is itself a mini-storm. So on ANY uncertainty — absent last_session
// _heartbeat AND absent last_idle_flag (deploy-transition / never-beat-yet), absent
// delivered fire, unparseable timestamp — we DO NOT flag. HUNG requires a positive
// assertion on every input.

export interface Cronish {
  /** ISO 8601 of the most recent fire DISPATCHED to the session (persisted pre-dispatch). */
  last_fire_attempted_at?: string | null;
  enabled?: boolean;
}

export interface HangEvalInput {
  now: number;
  /** Grace window N (ms). A healthy session beats within ~1-3min of a fire; N ~= 15min. */
  graceMs: number;
  /** Most-recent DELIVERED fire (ms), or null if none/unparseable. From crons.json. */
  deliveredFireAt: number | null;
  /** Last genuine session-authored beat (ms), or null if absent. From heartbeat.json. */
  lastSessionHeartbeat: number | null;
  /**
   * 2026-07-13 dual-source fix: mtime-equivalent of `state/<agent>/last_idle.flag`
   * (ms), or null/absent if never written. Written by the Stop hook on EVERY turn
   * completion, regardless of which cron triggered it — unlike `lastSessionHeartbeat`,
   * which only advances when the agent explicitly calls `update-heartbeat` (only the
   * `heartbeat` cron's own prompt instructs that). Without this, a healthy agent
   * processing any OTHER cron (check-approvals, morning-review, etc.) for 15+min
   * false-positives as hung — confirmed root cause of the 2026-07-13 ~15:02 UTC
   * false restart. Optional (omit entirely) to preserve pre-fix single-source
   * behavior for any caller that hasn't wired the new read yet.
   */
  lastIdleFlagAt?: number | null;
  /**
   * Class-3 fix: mtime-equivalent of `state/<agent>/last_activity.flag` (ms), or
   * null/absent if never written. Written by the PreToolUse hook on EVERY tool
   * call — unlike `lastIdleFlagAt`, which only advances when a turn COMPLETES.
   * Without this, a single long work turn (build, full test suite, long research
   * pass) spanning a delivered fire reads as beatless for the turn's whole
   * duration. Optional (omit entirely) to preserve pre-fix behavior for any
   * caller that hasn't wired the new read yet.
   */
  lastActivityBeatAt?: number | null;
}

/** The most recent of N beat timestamps, ignoring nulls/undefined; null if all absent. */
function maxBeat(...beats: Array<number | null | undefined>): number | null {
  let max: number | null = null;
  for (const b of beats) {
    if (b === null || b === undefined) continue;
    if (max === null || b > max) max = b;
  }
  return max;
}

export interface HangEvalResult {
  hung: boolean;
  reason: string;
}

export interface BootstrapHangEvalInput {
  now: number;
  /** Grace window N (ms), measured from restart rather than from a cron fire. */
  graceMs: number;
  /** When this session was last (re)started (ms), or null if unknown/never recorded. */
  restartAt: number | null;
  /** Last genuine session-authored beat (ms), or null if absent. From heartbeat.json. */
  lastSessionHeartbeat: number | null;
  /** Same dual-source fix as HangEvalInput — see its doc comment. */
  lastIdleFlagAt?: number | null;
  /** Same class-3 fix as HangEvalInput — see its doc comment. */
  lastActivityBeatAt?: number | null;
}

/** Parse an ISO timestamp to epoch ms; null on absent/invalid (fail-safe). */
function toMs(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  return Number.isFinite(t) ? t : null;
}

/**
 * Most-recent delivered fire across the agent's crons (batching-aware: after a
 * catch-up burst we require one session beat after the MOST-RECENT fire, not one per
 * fire). Returns null when no cron has a parseable last_fire_attempted_at.
 */
export function mostRecentDeliveredFireMs(crons: Cronish[]): number | null {
  let max: number | null = null;
  for (const c of crons) {
    const t = toMs(c.last_fire_attempted_at);
    if (t !== null && (max === null || t > max)) max = t;
  }
  return max;
}

/**
 * The trigger condition. HUNG iff (positive assertion on every input):
 *   1. a delivered fire T is recorded, AND
 *   2. now - T > grace N, AND
 *   3. a session heartbeat S is recorded AND S < T (no session beat since the fire).
 * Any missing/ambiguous input returns hung:false (fail-safe toward not-restarting).
 *
 * Note the idle-exit case is handled BY CONSTRUCTION: an idle-exited session that
 * resumes on its next fire writes a Part-A session beat (S >= T), so it never trips —
 * we key on delivered-fire-without-beat, not on last-seen age.
 */
export function evaluateHang(input: HangEvalInput): HangEvalResult {
  const { now, graceMs, deliveredFireAt: T, lastSessionHeartbeat, lastIdleFlagAt, lastActivityBeatAt } = input;
  const S = maxBeat(lastSessionHeartbeat, lastIdleFlagAt, lastActivityBeatAt);

  if (T === null) return { hung: false, reason: 'no delivered fire recorded — fail-safe' };
  if (now - T <= graceMs) {
    return { hung: false, reason: `within grace (${Math.round((now - T) / 60_000)}m <= ${Math.round(graceMs / 60_000)}m)` };
  }
  if (S === null) {
    // Deploy-transition / never-beat-yet: no session-heartbeat baseline. Part-A fills it
    // within one cron interval; fail-safe through that window rather than mass-restart.
    return { hung: false, reason: 'no session heartbeat recorded yet (deploy-transition/fresh) — fail-safe' };
  }
  if (S >= T) {
    return { hung: false, reason: 'session beat landed at/after the delivered fire — healthy' };
  }
  return {
    hung: true,
    reason: `delivered fire ${new Date(T).toISOString()} + ${Math.round((now - T) / 60_000)}m elapsed with no session beat since (last session beat ${new Date(S).toISOString()})`,
  };
}

/**
 * #19b — a RESTART is an expected-beat anchor too, not just a delivered cron fire.
 *
 * evaluateHang's fire-anchored sensor has a blind spot: a session that hangs
 * immediately after a `--continue` restart and never establishes a
 * last_session_heartbeat baseline reads as S === null forever, which evaluateHang
 * fail-safes to "deploy-transition, not hung" — indefinitely. That blind spot is
 * exactly the 2026-07-13 fleet-freeze class (bootstrap-hang right after restart).
 *
 * evaluateBootstrapHang closes it with a second, independent anchor: restart-time.
 * HUNG iff (positive assertion on every input):
 *   1. a restart-time R is recorded, AND
 *   2. now - R > grace N, AND
 *   3. no session beat landed AT OR AFTER R (either no beat ever, or the only beat
 *      on record predates this restart — a stale carry-over from the prior session).
 * Any missing/ambiguous input returns hung:false (same fail-safe-toward-not-restarting
 * governing principle as evaluateHang).
 */
export function evaluateBootstrapHang(input: BootstrapHangEvalInput): HangEvalResult {
  const { now, graceMs, restartAt: R, lastSessionHeartbeat, lastIdleFlagAt, lastActivityBeatAt } = input;
  const S = maxBeat(lastSessionHeartbeat, lastIdleFlagAt, lastActivityBeatAt);

  if (R === null) return { hung: false, reason: 'no restart-time recorded — fail-safe' };
  if (now - R <= graceMs) {
    return { hung: false, reason: `within grace-of-restart (${Math.round((now - R) / 60_000)}m <= ${Math.round(graceMs / 60_000)}m)` };
  }
  if (S !== null && S >= R) {
    return { hung: false, reason: 'bootstrap session beat landed at/after restart — healthy' };
  }
  const beatNote = S === null
    ? 'no session beat since restart'
    : `last session beat ${new Date(S).toISOString()} predates this restart`;
  return {
    hung: true,
    reason: `restarted ${new Date(R).toISOString()} + ${Math.round((now - R) / 60_000)}m elapsed, ${beatNote}`,
  };
}

/**
 * Whether a genuine session beat has landed at/after a given restart — the specific
 * "healthy bootstrap" condition, distinct from evaluateBootstrapHang's other
 * hung:false outcomes (unknown restart-time, still within grace) which say nothing
 * about whether a beat has actually occurred yet. Used to reset a restart-loop
 * counter only on CONFIRMED recovery, never on a merely-inconclusive poll — an
 * unconditional reset on every hung:false tick would let the counter clear itself
 * during the post-restart grace window before any beat could plausibly have landed,
 * defeating the halt-after-N breaker it backs.
 */
export function hasBeatSinceRestart(
  restartAt: number | null,
  lastSessionHeartbeat: number | null,
  lastIdleFlagAt?: number | null,
  lastActivityBeatAt?: number | null,
): boolean {
  if (restartAt === null) return false;
  const s = maxBeat(lastSessionHeartbeat, lastIdleFlagAt, lastActivityBeatAt);
  return s !== null && s >= restartAt;
}
