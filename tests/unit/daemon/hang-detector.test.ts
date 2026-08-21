import { describe, it, expect } from 'vitest';
import { evaluateHang, evaluateBootstrapHang, mostRecentAttemptedFireMs, mostRecentAnswerableFireMs, hasBeatSinceRestart } from '../../../src/daemon/hang-detector.js';

const MIN = 60_000;
const GRACE = 15 * MIN;
const NOW = 1_800_000_000_000; // fixed epoch ms (Date.now unavailable/irrelevant in pure tests)
const iso = (ms: number) => new Date(ms).toISOString();

describe('hang-detector — evaluateHang (fail-safe by construction)', () => {
  it('FIRES on a real hang: delivered fire past grace with no session beat since', () => {
    const T = NOW - 20 * MIN; // fire delivered 20min ago (> 15min grace)
    const S = T - 5 * MIN;    // last session beat was BEFORE the fire
    const r = evaluateHang({ now: NOW, graceMs: GRACE, deliveredFireAt: T, lastSessionHeartbeat: S });
    expect(r.hung).toBe(true);
  });

  it('does NOT fire within the grace window (fire delivered <N ago)', () => {
    const T = NOW - 5 * MIN; // only 5min ago
    const S = T - 5 * MIN;
    expect(evaluateHang({ now: NOW, graceMs: GRACE, deliveredFireAt: T, lastSessionHeartbeat: S }).hung).toBe(false);
  });

  it('does NOT fire when a session beat landed at/after the fire (healthy / idle-exit-resume)', () => {
    const T = NOW - 20 * MIN;
    const S = T + 2 * MIN; // Part-A beat ~2min after the fire
    expect(evaluateHang({ now: NOW, graceMs: GRACE, deliveredFireAt: T, lastSessionHeartbeat: S }).hung).toBe(false);
  });

  it('does NOT fire when last_session_heartbeat is ABSENT (deploy-transition / never beat)', () => {
    const T = NOW - 60 * MIN; // long past grace...
    const r = evaluateHang({ now: NOW, graceMs: GRACE, deliveredFireAt: T, lastSessionHeartbeat: null });
    expect(r.hung).toBe(false); // ...but no session baseline yet -> fail-safe
    expect(r.reason).toMatch(/deploy-transition|fail-safe/);
  });

  it('does NOT fire when there is no delivered fire recorded (absent fire)', () => {
    const S = NOW - 60 * MIN;
    expect(evaluateHang({ now: NOW, graceMs: GRACE, deliveredFireAt: null, lastSessionHeartbeat: S }).hung).toBe(false);
  });

  it('boundary: exactly at grace does NOT fire (strict > N)', () => {
    const T = NOW - GRACE; // now - T == grace, not > grace
    const S = T - MIN;
    expect(evaluateHang({ now: NOW, graceMs: GRACE, deliveredFireAt: T, lastSessionHeartbeat: S }).hung).toBe(false);
  });

  it('boundary: session beat exactly at fire time (S == T) is healthy', () => {
    const T = NOW - 20 * MIN;
    expect(evaluateHang({ now: NOW, graceMs: GRACE, deliveredFireAt: T, lastSessionHeartbeat: T }).hung).toBe(false);
  });
});

describe('hang-detector — evaluateHang dual-source liveness (last_idle.flag as a second beat source)', () => {
  it('does NOT false-positive: stale session-heartbeat but a FRESH idle-flag (real activity) since the fire', () => {
    // Reproduces the 2026-07-13 15:02 false-positive: agent processed a non-heartbeat
    // cron (e.g. check-approvals) for 15+min with no update-heartbeat call (only the
    // heartbeat cron's prompt instructs that), but the Stop hook proves real turns ran.
    const T = NOW - 20 * MIN; // fire delivered 20min ago
    const S = T - 30 * MIN;   // last SESSION heartbeat is stale, predates the fire
    const idle = T + 5 * MIN; // but last_idle.flag (Stop hook) landed AFTER the fire
    const r = evaluateHang({ now: NOW, graceMs: GRACE, deliveredFireAt: T, lastSessionHeartbeat: S, lastIdleFlagAt: idle });
    expect(r.hung).toBe(false);
  });

  it('still FIRES on a real hang when NEITHER session-heartbeat NOR idle-flag advanced since the fire', () => {
    const T = NOW - 20 * MIN;
    const S = T - 5 * MIN;
    const idle = T - 2 * MIN; // idle-flag also predates the fire — no activity proof at all
    const r = evaluateHang({ now: NOW, graceMs: GRACE, deliveredFireAt: T, lastSessionHeartbeat: S, lastIdleFlagAt: idle });
    expect(r.hung).toBe(true);
  });

  it('fail-safe unchanged: no session-heartbeat AND no idle-flag at all (no baseline yet — deploy-transition) does NOT fire', () => {
    const T = NOW - 20 * MIN;
    const r = evaluateHang({ now: NOW, graceMs: GRACE, deliveredFireAt: T, lastSessionHeartbeat: null, lastIdleFlagAt: null });
    expect(r.hung).toBe(false);
    expect(r.reason).toMatch(/deploy-transition|fail-safe/);
  });

  it('omitting lastIdleFlagAt entirely (undefined) behaves like the pre-fix single-source check', () => {
    const T = NOW - 20 * MIN;
    const S = T - 5 * MIN;
    expect(evaluateHang({ now: NOW, graceMs: GRACE, deliveredFireAt: T, lastSessionHeartbeat: S }).hung).toBe(true);
  });

  it('does NOT fire when idle-flag is present but session-heartbeat is null (idle-flag alone establishes the baseline)', () => {
    const T = NOW - 20 * MIN;
    const idle = T + 3 * MIN;
    const r = evaluateHang({ now: NOW, graceMs: GRACE, deliveredFireAt: T, lastSessionHeartbeat: null, lastIdleFlagAt: idle });
    expect(r.hung).toBe(false);
  });
});

describe('hang-detector — evaluateHang triple-source liveness (last_activity.flag as a third, mid-turn beat source)', () => {
  it('does NOT false-positive: a long single turn spanning the fire, with only a mid-turn activity-beat as proof', () => {
    // The class-3 scenario: neither session-heartbeat nor idle-flag (Stop hook,
    // turn-completion-only) has advanced because the turn hasn't finished yet —
    // but a PreToolUse activity-beat landed mid-turn, after the fire.
    const T = NOW - 20 * MIN;   // fire delivered 20min ago
    const S = T - 30 * MIN;     // session-heartbeat stale, predates the fire
    const idle = T - 10 * MIN;  // idle-flag ALSO predates the fire — turn still running
    const activity = T + 5 * MIN; // but a tool call landed after the fire, mid-turn
    const r = evaluateHang({ now: NOW, graceMs: GRACE, deliveredFireAt: T, lastSessionHeartbeat: S, lastIdleFlagAt: idle, lastActivityBeatAt: activity });
    expect(r.hung).toBe(false);
  });

  it('still FIRES on a real hang when NONE of the three sources advanced since the fire', () => {
    const T = NOW - 20 * MIN;
    const S = T - 5 * MIN;
    const idle = T - 2 * MIN;
    const activity = T - 1 * MIN;
    const r = evaluateHang({ now: NOW, graceMs: GRACE, deliveredFireAt: T, lastSessionHeartbeat: S, lastIdleFlagAt: idle, lastActivityBeatAt: activity });
    expect(r.hung).toBe(true);
  });

  it('fail-safe unchanged: all three sources absent (no baseline yet — deploy-transition) does NOT fire', () => {
    const T = NOW - 20 * MIN;
    const r = evaluateHang({ now: NOW, graceMs: GRACE, deliveredFireAt: T, lastSessionHeartbeat: null, lastIdleFlagAt: null, lastActivityBeatAt: null });
    expect(r.hung).toBe(false);
    expect(r.reason).toMatch(/deploy-transition|fail-safe/);
  });

  it('omitting lastActivityBeatAt entirely behaves like the pre-class-3-fix dual-source check', () => {
    const T = NOW - 20 * MIN;
    const S = T - 30 * MIN;
    const idle = T - 10 * MIN;
    const r = evaluateHang({ now: NOW, graceMs: GRACE, deliveredFireAt: T, lastSessionHeartbeat: S, lastIdleFlagAt: idle });
    expect(r.hung).toBe(true);
  });

  it('does NOT fire when activity-beat alone establishes the baseline (both other sources null)', () => {
    const T = NOW - 20 * MIN;
    const activity = T + 3 * MIN;
    const r = evaluateHang({ now: NOW, graceMs: GRACE, deliveredFireAt: T, lastSessionHeartbeat: null, lastIdleFlagAt: null, lastActivityBeatAt: activity });
    expect(r.hung).toBe(false);
  });

  it('boundary: activity-beat exactly at fire time (S == T) is healthy', () => {
    const T = NOW - 20 * MIN;
    const r = evaluateHang({ now: NOW, graceMs: GRACE, deliveredFireAt: T, lastSessionHeartbeat: null, lastIdleFlagAt: null, lastActivityBeatAt: T });
    expect(r.hung).toBe(false);
  });
});

describe('hang-detector — evaluateBootstrapHang (#19b: restart is an expected-beat anchor too)', () => {
  it('FIRES on a bootstrap hang: restart past grace, no session beat ever', () => {
    const R = NOW - 20 * MIN; // restarted 20min ago (> 15min grace)
    const r = evaluateBootstrapHang({ now: NOW, graceMs: GRACE, restartAt: R, lastSessionHeartbeat: null });
    expect(r.hung).toBe(true);
  });

  it('FIRES when the only session beat on record predates the restart (stale carry-over)', () => {
    const R = NOW - 20 * MIN;
    const S = R - 5 * MIN; // beat from the PREVIOUS session, before this restart
    expect(evaluateBootstrapHang({ now: NOW, graceMs: GRACE, restartAt: R, lastSessionHeartbeat: S }).hung).toBe(true);
  });

  it('does NOT fire within the grace-of-restart window', () => {
    const R = NOW - 5 * MIN; // only 5min since restart
    expect(evaluateBootstrapHang({ now: NOW, graceMs: GRACE, restartAt: R, lastSessionHeartbeat: null }).hung).toBe(false);
  });

  it('does NOT fire once a session beat lands at/after the restart (healthy bootstrap)', () => {
    const R = NOW - 20 * MIN;
    const S = R + 2 * MIN; // bootstrap beat landed shortly after restart
    expect(evaluateBootstrapHang({ now: NOW, graceMs: GRACE, restartAt: R, lastSessionHeartbeat: S }).hung).toBe(false);
  });

  it('does NOT fire when restart-time is absent (fail-safe: unknown anchor, e.g. deploy-transition before this field existed)', () => {
    const r = evaluateBootstrapHang({ now: NOW, graceMs: GRACE, restartAt: null, lastSessionHeartbeat: null });
    expect(r.hung).toBe(false);
    expect(r.reason).toMatch(/fail-safe|no restart/);
  });

  it('boundary: exactly at grace does NOT fire (strict > N)', () => {
    const R = NOW - GRACE;
    expect(evaluateBootstrapHang({ now: NOW, graceMs: GRACE, restartAt: R, lastSessionHeartbeat: null }).hung).toBe(false);
  });

  it('boundary: session beat exactly at restart time (S == R) is healthy', () => {
    const R = NOW - 20 * MIN;
    expect(evaluateBootstrapHang({ now: NOW, graceMs: GRACE, restartAt: R, lastSessionHeartbeat: R }).hung).toBe(false);
  });

  it('dual-source parallel treatment: does NOT fire when idle-flag (Stop-hook) landed after restart, even with no session-heartbeat ever', () => {
    // A bootstrap session that reached Stop-hook completion is provably NOT hung,
    // even if it never called update-heartbeat (same fix as evaluateHang, applied
    // to the restart-anchored sensor for consistency).
    const R = NOW - 20 * MIN;
    const idle = R + 4 * MIN; // Stop hook fired after the restart
    const r = evaluateBootstrapHang({ now: NOW, graceMs: GRACE, restartAt: R, lastSessionHeartbeat: null, lastIdleFlagAt: idle });
    expect(r.hung).toBe(false);
  });

  it('dual-source: still FIRES when idle-flag also predates the restart (genuine bootstrap hang, never completed a turn)', () => {
    const R = NOW - 20 * MIN;
    const idle = R - 30 * MIN; // stale idle-flag from a PRIOR session, before this restart
    const r = evaluateBootstrapHang({ now: NOW, graceMs: GRACE, restartAt: R, lastSessionHeartbeat: null, lastIdleFlagAt: idle });
    expect(r.hung).toBe(true);
  });

  it('triple-source (class-3): does NOT fire when only a mid-turn activity-beat landed after the restart (long first turn, no Stop hook yet)', () => {
    const R = NOW - 20 * MIN;
    const activity = R + 4 * MIN; // a tool call fired mid-turn, after the restart
    const r = evaluateBootstrapHang({ now: NOW, graceMs: GRACE, restartAt: R, lastSessionHeartbeat: null, lastIdleFlagAt: null, lastActivityBeatAt: activity });
    expect(r.hung).toBe(false);
  });

  it('triple-source: still FIRES when all three sources predate the restart (genuine bootstrap hang)', () => {
    const R = NOW - 20 * MIN;
    const idle = R - 30 * MIN;
    const activity = R - 25 * MIN;
    const r = evaluateBootstrapHang({ now: NOW, graceMs: GRACE, restartAt: R, lastSessionHeartbeat: null, lastIdleFlagAt: idle, lastActivityBeatAt: activity });
    expect(r.hung).toBe(true);
  });
});

describe('hang-detector — mostRecentAttemptedFireMs (batching-aware)', () => {
  it('picks the MOST-RECENT fire across crons (batching: one beat after the latest fire)', () => {
    const crons = [
      { last_fire_attempted_at: iso(NOW - 40 * MIN) },
      { last_fire_attempted_at: iso(NOW - 10 * MIN) }, // most recent
      { last_fire_attempted_at: iso(NOW - 25 * MIN) },
    ];
    expect(mostRecentAttemptedFireMs(crons)).toBe(NOW - 10 * MIN);
  });

  it('returns null when no cron has a parseable last_fire_attempted_at', () => {
    expect(mostRecentAttemptedFireMs([{ last_fire_attempted_at: null }, {}, { last_fire_attempted_at: 'not-a-date' }])).toBeNull();
  });

  it('ignores unparseable timestamps but keeps valid ones', () => {
    const crons = [{ last_fire_attempted_at: 'garbage' }, { last_fire_attempted_at: iso(NOW - 12 * MIN) }];
    expect(mostRecentAttemptedFireMs(crons)).toBe(NOW - 12 * MIN);
  });

  it('feeds the sensor end-to-end: latest fire past grace + stale session beat = HUNG', () => {
    const crons = [{ last_fire_attempted_at: iso(NOW - 30 * MIN) }, { last_fire_attempted_at: iso(NOW - 18 * MIN) }];
    const T = mostRecentAttemptedFireMs(crons)!;
    const S = NOW - 40 * MIN; // last session beat older than the latest fire
    expect(evaluateHang({ now: NOW, graceMs: GRACE, deliveredFireAt: T, lastSessionHeartbeat: S }).hung).toBe(true);
  });
});

describe('hang-detector — hasBeatSinceRestart (restart-loop-counter reset signal)', () => {
  it('TRUE: a session heartbeat landed at/after the restart', () => {
    const R = NOW - 20 * MIN;
    const S = R + 2 * MIN;
    expect(hasBeatSinceRestart(R, S, null)).toBe(true);
  });

  it('TRUE: only last_idle.flag (no session-heartbeat) landed at/after the restart', () => {
    const R = NOW - 20 * MIN;
    expect(hasBeatSinceRestart(R, null, R + MIN)).toBe(true);
  });

  it('boundary: beat exactly AT restart time counts (S == R)', () => {
    const R = NOW - 20 * MIN;
    expect(hasBeatSinceRestart(R, R, null)).toBe(true);
  });

  it('FALSE: the only beat on record PREDATES the restart (stale carry-over)', () => {
    const R = NOW - 20 * MIN;
    const S = R - 5 * MIN;
    expect(hasBeatSinceRestart(R, S, null)).toBe(false);
  });

  it('FALSE: no beat of either kind recorded at all', () => {
    const R = NOW - 20 * MIN;
    expect(hasBeatSinceRestart(R, null, null)).toBe(false);
  });

  it('FALSE: restart-time itself is unknown (fail-safe — never claims recovery on an unknown anchor)', () => {
    expect(hasBeatSinceRestart(null, NOW, NOW)).toBe(false);
  });

  it('TRUE: only last_activity.flag (no session-heartbeat, no idle-flag) landed at/after the restart', () => {
    const R = NOW - 20 * MIN;
    expect(hasBeatSinceRestart(R, null, null, R + MIN)).toBe(true);
  });

  it('FALSE: all three beats predate the restart', () => {
    const R = NOW - 20 * MIN;
    expect(hasBeatSinceRestart(R, R - 5 * MIN, R - 3 * MIN, R - MIN)).toBe(false);
  });
});

describe('hang-detector — a frequent cron must not blind the sensor (self-refreshing anchor)', () => {
  const CRON_INTERVAL = 15 * MIN; // maintainer's trigger-scan — the tightest in the fleet

  /**
   * Fires ATTEMPTED every CRON_INTERVAL since `onset`, up to `now`.
   *
   * This is the whole defect in one helper: last_fire_attempted_at records the
   * ATTEMPT, so it keeps advancing whether or not the agent is alive to consume
   * it. A wedged agent's newest fire is therefore always fresh.
   */
  const firesSince = (onset: number, now: number) => {
    const out: Array<{ last_fire_attempted_at: string }> = [];
    for (let t = onset; t <= now; t += CRON_INTERVAL) out.push({ last_fire_attempted_at: iso(t) });
    return out;
  };

  // Deliberately NOT asserted as "never flags". That shape passes on the broken
  // code and fails on a correct fix, so it would lock the defect in. Bounded
  // detection latency from onset is the property that actually matters.
  const BOUND = CRON_INTERVAL + GRACE + 1 * MIN; // one interval to advance past onset, one grace to ripen

  it('REGRESSION: a wedged agent on a 15m cron IS flagged within a bounded time of onset', () => {
    const onset = NOW - BOUND;
    const crons = firesSince(onset, NOW);
    const S = onset; // last real beat: the moment it wedged

    const T = mostRecentAnswerableFireMs(crons, NOW, GRACE);
    expect(T).not.toBeNull();
    const r = evaluateHang({ now: NOW, graceMs: GRACE, deliveredFireAt: T, lastSessionHeartbeat: S });
    expect(r.hung).toBe(true);
  });

  it('the OLD anchor cannot flag it at any elapsed time — the defect, pinned', () => {
    // Same wedged agent, 11 hours in — the real 2026-08-15 duration.
    const onset = NOW - 11 * 60 * MIN;
    const crons = firesSince(onset, NOW);
    const S = onset;

    const stale = mostRecentAttemptedFireMs(crons)!; // newest ATTEMPT — always fresh
    expect(NOW - stale).toBeLessThanOrEqual(GRACE);  // hence permanently "within grace"
    expect(evaluateHang({ now: NOW, graceMs: GRACE, deliveredFireAt: stale, lastSessionHeartbeat: S }).hung).toBe(false);

    // The corrected anchor flags the same agent from the same inputs.
    const fixed = mostRecentAnswerableFireMs(crons, NOW, GRACE);
    expect(evaluateHang({ now: NOW, graceMs: GRACE, deliveredFireAt: fixed, lastSessionHeartbeat: S }).hung).toBe(true);
  });

  it('CONTROL: a HEALTHY agent on the same 15m cron is not flagged', () => {
    const onset = NOW - 11 * 60 * MIN;
    const crons = firesSince(onset, NOW);
    const S = NOW - 2 * MIN; // beating normally

    const T = mostRecentAnswerableFireMs(crons, NOW, GRACE);
    expect(evaluateHang({ now: NOW, graceMs: GRACE, deliveredFireAt: T, lastSessionHeartbeat: S }).hung).toBe(false);
  });

  it('CONTROL: an infrequent (4h) cron behaves exactly as before — no fleet-wide change', () => {
    const T4 = NOW - 20 * MIN; // a 4h cron that fired 20min ago
    const crons = [{ last_fire_attempted_at: iso(T4) }];
    expect(mostRecentAnswerableFireMs(crons, NOW, GRACE)).toBe(T4);
    expect(mostRecentAttemptedFireMs(crons)).toBe(T4); // identical to the old anchor
  });

  it('no fire is old enough yet — returns null, and null is fail-safe', () => {
    const crons = [{ last_fire_attempted_at: iso(NOW - 3 * MIN) }];
    expect(mostRecentAnswerableFireMs(crons, NOW, GRACE)).toBeNull();
    expect(evaluateHang({
      now: NOW, graceMs: GRACE,
      deliveredFireAt: mostRecentAnswerableFireMs(crons, NOW, GRACE),
      lastSessionHeartbeat: NOW - 60 * MIN,
    }).hung).toBe(false);
  });

  it('a fresh activity flag still suppresses the verdict — maxBeat is UNCHANGED here', () => {
    // Documents the boundary of this fix, so nobody reads it as closing the
    // 2026-08-15 credit-exhaustion outage. There the agent completed a turn
    // every cycle, the Stop hook wrote last_idle.flag unconditionally, and S
    // stayed fresh. A corrected anchor reaches the S >= T comparison and still
    // returns healthy — correctly, because that agent was NOT wedged.
    const onset = NOW - 11 * 60 * MIN;
    const crons = firesSince(onset, NOW);
    const T = mostRecentAnswerableFireMs(crons, NOW, GRACE);
    const r = evaluateHang({
      now: NOW, graceMs: GRACE, deliveredFireAt: T,
      lastSessionHeartbeat: onset,   // 11h stale
      lastIdleFlagAt: NOW - 1 * MIN, // but turns ARE completing
    });
    expect(r.hung).toBe(false);
  });
});
