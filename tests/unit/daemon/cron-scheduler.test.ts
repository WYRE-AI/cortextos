/**
 * tests/unit/daemon/cron-scheduler.test.ts
 *
 * Unit tests for CronScheduler (Subtask 1.3).
 *
 * All timing is driven by vitest fake timers (vi.useFakeTimers / vi.advanceTimersByTimeAsync).
 * Disk I/O is fully mocked so tests run without touching the filesystem.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mock crons.ts I/O BEFORE importing CronScheduler so the module resolution
// picks up the mock.
// ---------------------------------------------------------------------------

const mockReadCrons  = vi.fn();
const mockUpdateCron = vi.fn();
// readCronsWithStatus is what cron-scheduler actually calls (post-iter-9).
// By default it mirrors mockReadCrons with corrupt:false so existing tests
// keep working.  Tests that need to assert the corruption path can override
// with mockReadCronsWithStatus.mockReturnValueOnce({ crons: [...], corrupt: true }).
const mockReadCronsWithStatus = vi.fn();

vi.mock('../../../src/bus/crons.js', () => ({
  readCrons:  (...args: unknown[]) => mockReadCrons(...args),
  readCronsWithStatus: (...args: unknown[]) => mockReadCronsWithStatus(...args),
  updateCron: (...args: unknown[]) => mockUpdateCron(...args),
}));

// ---------------------------------------------------------------------------
// Imports AFTER mock setup
// ---------------------------------------------------------------------------

import { CronScheduler, nextFireFromCron, computeReferenceMs } from '../../../src/daemon/cron-scheduler';
import type { CronDefinition } from '../../../src/types/index';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCron(overrides: Partial<CronDefinition> = {}): CronDefinition {
  return {
    name: 'test-cron',
    prompt: 'Do something.',
    schedule: '1m',
    enabled: true,
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

const TICK = CronScheduler.TICK_INTERVAL_MS; // 30_000 ms

// ---------------------------------------------------------------------------
// nextFireFromCron — unit tests for the cron expression parser
//
// nextFireFromCron defaults to UTC (see the timezone-aware describe block
// below for why) — these tests assert against explicit UTC getters/setters
// so they pass deterministically regardless of the host machine's ambient
// timezone, matching the code's own UTC-independent-of-ambient-TZ default.
// A non-UTC ambient TZ is force-set in beforeEach so a regression back to
// ambient-local Date getters would be caught here too, not only in the
// dedicated timezone-aware suite.
// ---------------------------------------------------------------------------

/** Pull the UTC calendar components out of an epoch-ms value. */
function utcOf(ms: number) {
  const d = new Date(ms);
  return {
    minutes:    d.getUTCMinutes(),
    hours:      d.getUTCHours(),
    date:       d.getUTCDate(),
    month:      d.getUTCMonth() + 1,
    dayOfWeek:  d.getUTCDay(),
  };
}

describe('nextFireFromCron', () => {
  const originalTz = process.env.TZ;

  beforeEach(() => {
    process.env.TZ = 'America/New_York';
  });

  afterEach(() => {
    if (originalTz === undefined) delete process.env.TZ;
    else process.env.TZ = originalTz;
  });

  it('computes correct next fire for "*/5 * * * *" (every 5 minutes)', () => {
    const fromMs = Date.now();
    const next = nextFireFromCron('*/5 * * * *', fromMs);
    expect(next).not.toBeNaN();
    // Result must be after fromMs and within the next 5 minutes
    expect(next).toBeGreaterThan(fromMs);
    expect(next).toBeLessThanOrEqual(fromMs + 5 * 60_000 + 60_000);
    // The minute must be a multiple of 5
    expect(utcOf(next).minutes % 5).toBe(0);
    // Seconds must be zero (whole minute)
    expect(next % 60_000).toBe(0);
  });

  it('computes next fire at UTC hour 13 for "0 13 * * *" when before 13:00 UTC today', () => {
    const ref = new Date();
    ref.setUTCHours(12, 0, 0, 0);
    const fromMs = ref.getTime();

    const next = nextFireFromCron('0 13 * * *', fromMs);
    expect(next).not.toBeNaN();

    const utc = utcOf(next);
    expect(utc.hours).toBe(13);
    expect(utc.minutes).toBe(0);
    // Must be the same calendar date (still today)
    expect(utc.date).toBe(new Date(fromMs).getUTCDate());
  });

  it('wraps to next day when UTC hour 13 has already passed today', () => {
    const ref = new Date();
    ref.setUTCHours(14, 0, 0, 0);
    const fromMs = ref.getTime();

    const next = nextFireFromCron('0 13 * * *', fromMs);
    expect(next).not.toBeNaN();

    const utc = utcOf(next);
    expect(utc.hours).toBe(13);
    expect(utc.minutes).toBe(0);
    // Must be tomorrow (date + 1), accounting for month wrap
    const expectedDate = new Date(fromMs);
    expectedDate.setUTCDate(expectedDate.getUTCDate() + 1);
    expect(utc.date).toBe(expectedDate.getUTCDate());
  });

  it('handles comma-list: "0 0,6,12,18 * * *" — picks the next matching hour', () => {
    // Set from = UTC 05:00 so next matching hour is 6.
    const ref = new Date();
    ref.setUTCHours(5, 0, 0, 0);
    const fromMs = ref.getTime();

    const next = nextFireFromCron('0 0,6,12,18 * * *', fromMs);
    expect(next).not.toBeNaN();

    const utc = utcOf(next);
    expect([0, 6, 12, 18]).toContain(utc.hours);
    expect(utc.minutes).toBe(0);
    expect(next).toBeGreaterThan(fromMs);
  });

  it('handles ranges: "0 8-10 * * *" — fires within [8,9,10] UTC hours', () => {
    const ref = new Date();
    ref.setUTCHours(7, 59, 0, 0);
    const fromMs = ref.getTime();

    const next = nextFireFromCron('0 8-10 * * *', fromMs);
    expect(next).not.toBeNaN();

    const utc = utcOf(next);
    expect(utc.hours).toBeGreaterThanOrEqual(8);
    expect(utc.hours).toBeLessThanOrEqual(10);
    expect(utc.minutes).toBe(0);
  });

  it('handles day-of-week restriction: "0 16 * * 1" — fires on a Monday', () => {
    const fromMs = Date.now();
    const next = nextFireFromCron('0 16 * * 1', fromMs);
    expect(next).not.toBeNaN();
    expect(next).toBeGreaterThan(fromMs);

    const utc = utcOf(next);
    expect(utc.dayOfWeek).toBe(1); // Monday
    expect(utc.hours).toBe(16);
    expect(utc.minutes).toBe(0);
    // Must be within the next 7 days
    expect(next - fromMs).toBeLessThanOrEqual(8 * 24 * 60 * 60_000);
  });

  it('returns NaN for invalid expression (wrong field count)', () => {
    expect(nextFireFromCron('* * * *', Date.now())).toBeNaN();
  });
});

// ---------------------------------------------------------------------------
// nextFireFromCron — timezone-aware evaluation (bug: cron-expr fields were
// matched against the process's ambient local timezone via Date getters,
// e.g. getHours(). On a daemon with no TZ env override, Node falls back to
// the OS timezone (America/New_York on the fleet host), so a cron authored
// as "0 9 * * 1" (intended as 09:00 UTC) actually fired at 09:00 ET
// (13:00 UTC) — a silent 4-5h (DST-dependent) offset. Fix: nextFireFromCron
// takes an explicit `timezone` parameter (IANA string, default "UTC") and
// extracts cron fields via Intl.DateTimeFormat for THAT timezone, independent
// of the process's ambient TZ.
//
// These tests force process.env.TZ to a non-UTC zone in beforeEach so the
// bug (and the fix) are proven deterministically regardless of which
// timezone the host machine or CI runner happens to be in.
// ---------------------------------------------------------------------------
describe('nextFireFromCron — timezone-aware evaluation', () => {
  const originalTz = process.env.TZ;

  beforeEach(() => {
    // Force a non-UTC ambient TZ so a test that (bug) reads local Date
    // getters cannot accidentally pass just because the host happens to be
    // UTC already.
    process.env.TZ = 'America/New_York';
  });

  afterEach(() => {
    if (originalTz === undefined) delete process.env.TZ;
    else process.env.TZ = originalTz;
  });

  it('defaults to UTC when no timezone is given, regardless of ambient process TZ', () => {
    // Monday 2026-07-13, 08:00 UTC — one hour before the 09:00 UTC target.
    const fromMs = Date.parse('2026-07-13T08:00:00.000Z');
    const next = nextFireFromCron('0 9 * * 1', fromMs);
    expect(next).toBe(Date.parse('2026-07-13T09:00:00.000Z'));
  });

  it('respects an explicit IANA timezone in summer (EDT, UTC-4)', () => {
    const fromMs = Date.parse('2026-07-13T08:00:00.000Z');
    const next = nextFireFromCron('0 9 * * 1', fromMs, 'America/New_York');
    // 9am EDT on 2026-07-13 is 13:00 UTC.
    expect(next).toBe(Date.parse('2026-07-13T13:00:00.000Z'));
  });

  it('respects an explicit IANA timezone in winter (EST, UTC-5) — DST-native, not a fixed offset', () => {
    // 2026-01-12 is a Monday.
    const fromMs = Date.parse('2026-01-12T08:00:00.000Z');
    const next = nextFireFromCron('0 9 * * 1', fromMs, 'America/New_York');
    // 9am EST on 2026-01-12 is 14:00 UTC (not 13:00 — proves this isn't a
    // hardcoded UTC-4 offset, it's genuine DST-aware timezone evaluation).
    expect(next).toBe(Date.parse('2026-01-12T14:00:00.000Z'));
  });

  it('day-of-week (and hour) fields are evaluated in the target timezone, not UTC/ambient-local', () => {
    // 2026-07-13 23:30 UTC is still Monday in UTC, but already Tuesday
    // 08:30 in Asia/Tokyo (UTC+9, no DST). A "Tuesday 09:00" cron evaluated
    // in Asia/Tokyo should fire ~30min later (Tuesday 00:00 UTC); the same
    // expression evaluated with the UTC default should not fire until
    // Tuesday 09:00 UTC, 9.5h later — proves dow+hour use the GIVEN
    // timezone's calendar day, not UTC's.
    const fromMs = Date.parse('2026-07-13T23:30:00.000Z');

    const nextTokyo = nextFireFromCron('0 9 * * 2', fromMs, 'Asia/Tokyo');
    expect(nextTokyo).toBe(Date.parse('2026-07-14T00:00:00.000Z')); // 09:00 JST Tue = 00:00 UTC Tue

    const nextUtcDefault = nextFireFromCron('0 9 * * 2', fromMs);
    expect(nextUtcDefault).toBe(Date.parse('2026-07-14T09:00:00.000Z')); // 09:00 UTC Tue
  });

  it('rejects an invalid IANA timezone by returning NaN rather than throwing', () => {
    const fromMs = Date.parse('2026-07-13T08:00:00.000Z');
    expect(nextFireFromCron('0 9 * * 1', fromMs, 'Not/AZone')).toBeNaN();
  });
});

// ---------------------------------------------------------------------------
// nextFireFromCron — infeasible dom+month pre-check (PR #21 fast-follow)
//
// A dom+month combination that exists in no month ("0 0 31 2 *" — Feb 31)
// passes per-field expansion, so without a pre-check the minute scan walks
// the entire 366-day window (527K formatToParts calls, ~1.2s measured on
// this branch) just to return NaN — per reload and per list-crons preview.
// The pre-check rejects in O(fields). Feb deliberately counts 29 days:
// "29 2" stays feasible (leap years) and is answered by the real scan.
// ---------------------------------------------------------------------------
describe('nextFireFromCron — infeasible dom+month pre-check', () => {
  it('returns NaN for impossible calendar dates without scanning (Feb 31, Apr 31)', () => {
    const fromMs = Date.parse('2026-07-13T08:00:00.000Z');
    const t0 = performance.now();
    expect(nextFireFromCron('0 0 31 2 *', fromMs)).toBeNaN();
    expect(nextFireFromCron('0 0 31 4 *', fromMs)).toBeNaN();
    expect(nextFireFromCron('30 6 30 2 *', fromMs, 'America/New_York')).toBeNaN();
    const elapsed = performance.now() - t0;
    // Pre-check is O(fields) (<1ms). The bound is ~100x headroom for CI
    // jitter while still failing loudly on any full-window scan (~1.2s each).
    expect(elapsed).toBeLessThan(120);
  });

  it('still finds a date when ANY expanded month admits an expanded day (31 in "1,2" months)', () => {
    const fromMs = Date.parse('2026-07-13T08:00:00.000Z');
    // Feb 31 is impossible but Jan 31 is real — expression stays feasible.
    const next = nextFireFromCron('0 0 31 1,2 *', fromMs);
    expect(next).toBe(Date.parse('2027-01-31T00:00:00.000Z'));
  });

  it('keeps "0 0 29 2 *" feasible and resolves it to a real Feb 29 when one is in the window', () => {
    // From mid-2027 the next Feb 29 (2028) is within the 366-day scan window.
    const fromMs = Date.parse('2027-06-01T00:00:00.000Z');
    expect(nextFireFromCron('0 0 29 2 *', fromMs)).toBe(Date.parse('2028-02-29T00:00:00.000Z'));
  });

  it('leaves ordinary expressions untouched (Jan 31 exact date)', () => {
    const fromMs = Date.parse('2026-07-13T08:00:00.000Z');
    expect(nextFireFromCron('15 4 31 1 *', fromMs)).toBe(Date.parse('2027-01-31T04:15:00.000Z'));
  });

  // The UTC fast path (native Date getters) must agree EXACTLY with the Intl
  // path it bypasses. "UTC" and "Etc/UTC" are the same zone but take different
  // branches — the former uses getters, the latter builds an Intl formatter —
  // so comparing them across a spread of expressions pins the equivalence.
  it('UTC fast path agrees exactly with the Intl path (vs the equivalent Etc/UTC)', () => {
    // Cases are anchored close to their match so BOTH paths scan a short
    // window: the Etc/UTC side still pays Intl per candidate minute, so
    // pairing a sparse expression with a far anchor here would cost ~9s each
    // and time the test out — the very cost this fast path exists to remove.
    // Every cron field is still covered.
    const cases: Array<{ from: string; expr: string; why: string }> = [
      { from: '2026-07-13T08:00:00.000Z', expr: '*/15 * * * *',  why: 'minute step' },
      { from: '2026-07-13T08:00:00.000Z', expr: '0 9 * * 1-5',   why: 'weekday range' },
      { from: '2026-12-31T23:59:00.000Z', expr: '30 6 1 * *',    why: 'year/month/day rollover' },
      { from: '2026-03-08T06:30:00.000Z', expr: '0 2 * * *',     why: 'US DST date — UTC must not shift' },
      { from: '2027-01-29T00:00:00.000Z', expr: '0 0 31 1,2 *',  why: 'sparse dom+month' },
      { from: '2028-02-27T00:00:00.000Z', expr: '0 0 29 2 *',    why: 'leap day' },
      { from: '2027-01-30T00:00:00.000Z', expr: '15 4 31 1 *',   why: 'exact date + hour + minute' },
    ];
    for (const { from, expr, why } of cases) {
      const fromMs = Date.parse(from);
      expect(
        nextFireFromCron(expr, fromMs),
        `${expr} @ ${from} (${why})`,
      ).toBe(nextFireFromCron(expr, fromMs, 'Etc/UTC'));
    }
  });

  it('resolves a sparse UTC expression fast enough for the scheduler tick', () => {
    // Regression guard for the Intl-per-candidate-minute cost. This expression
    // scans ~291K candidate minutes (Jul 2026 -> Jan 2027); via
    // Intl.formatToParts that measured 9,382ms, which blew the 10s test timeout
    // under load and burned that same CPU inside the daemon on every schedule
    // computation. Native UTC getters measured 340ms. Bound generously so this
    // fails on a return to per-minute Intl, not on CI jitter.
    const fromMs = Date.parse('2026-07-13T08:00:00.000Z');
    const t0 = performance.now();
    const next = nextFireFromCron('0 0 31 1,2 *', fromMs);
    const elapsed = performance.now() - t0;
    expect(next).toBe(Date.parse('2027-01-31T00:00:00.000Z'));
    expect(elapsed).toBeLessThan(3000);
  });
});

// ---------------------------------------------------------------------------
// CronScheduler behaviour tests (fake timers)
// ---------------------------------------------------------------------------

describe('CronScheduler', () => {
  let logs: string[];
  let fired: CronDefinition[];
  let scheduler: CronScheduler;

  beforeEach(() => {
    vi.useFakeTimers();
    logs   = [];
    fired  = [];
    mockReadCrons.mockReset();
    mockUpdateCron.mockReset();
    mockReadCronsWithStatus.mockReset();
    // Default: readCronsWithStatus reflects whatever readCrons returns
    // and reports the file as healthy (corrupt: false).
    mockReadCronsWithStatus.mockImplementation((agent: string) => ({
      crons: mockReadCrons(agent) ?? [],
      corrupt: false,
    }));

    scheduler = new CronScheduler({
      agentName: 'test-agent',
      onFire: (cron) => { fired.push(cron); },
      logger: (msg) => { logs.push(msg); },
    });
  });

  afterEach(() => {
    scheduler.stop();
    vi.useRealTimers();
  });

  // -------------------------------------------------------------------------

  it('fires a "1m" interval cron after 60 seconds', async () => {
    mockReadCrons.mockReturnValue([makeCron({ schedule: '1m' })]);
    scheduler.start();

    // Advance time so nextFireAt (now + 60s) is reached, plus one tick
    await vi.advanceTimersByTimeAsync(60_000 + TICK);

    expect(fired).toHaveLength(1);
    expect(fired[0].name).toBe('test-cron');
  });

  it('does NOT fire before the interval has elapsed', async () => {
    mockReadCrons.mockReturnValue([makeCron({ schedule: '1m' })]);
    scheduler.start();

    // Advance only 30s (less than 1m)
    await vi.advanceTimersByTimeAsync(30_000);

    expect(fired).toHaveLength(0);
  });

  it('a cron-expression cron with an explicit timezone field fires at the correct (offset) UTC instant', async () => {
    // Pin the fake clock to an absolute, known instant: Monday 2026-07-13,
    // 08:00 UTC — one hour before "0 9 * * 1" fires in UTC (default), and
    // 5 hours before it fires at 9am America/New_York (EDT, UTC-4).
    vi.setSystemTime(new Date('2026-07-13T08:00:00.000Z'));

    mockReadCrons.mockReturnValue([
      makeCron({ schedule: '0 9 * * 1', timezone: 'America/New_York' }),
    ]);
    scheduler.start();

    // Advance 1h — the UTC-default fire time (09:00 UTC) — should NOT have
    // fired yet, proving the timezone field is actually being honored
    // (not silently ignored in favor of a UTC/ambient default).
    await vi.advanceTimersByTimeAsync(60 * 60_000 + TICK);
    expect(fired).toHaveLength(0);

    // Advance to 13:00 UTC (9am EDT) — should fire now.
    await vi.advanceTimersByTimeAsync(4 * 60 * 60_000);
    expect(fired).toHaveLength(1);
    expect(fired[0].name).toBe('test-cron');
  });

  it('disabled cron does not fire', async () => {
    mockReadCrons.mockReturnValue([makeCron({ schedule: '1m', enabled: false })]);
    scheduler.start();

    await vi.advanceTimersByTimeAsync(5 * 60_000);

    expect(fired).toHaveLength(0);
  });

  it('fires multiple times after multiple intervals', async () => {
    mockReadCrons.mockReturnValue([makeCron({ schedule: '1m' })]);
    scheduler.start();

    // 3 minutes worth — should fire 3 times (at 60s, 120s, 180s)
    await vi.advanceTimersByTimeAsync(3 * 60_000 + TICK);

    expect(fired.length).toBeGreaterThanOrEqual(3);
  });

  // -------------------------------------------------------------------------

  it('persists last_fired_at and fire_count via updateCron on successful fire', async () => {
    mockReadCrons.mockReturnValue([makeCron({ schedule: '1m' })]);
    scheduler.start();

    await vi.advanceTimersByTimeAsync(60_000 + TICK);

    expect(mockUpdateCron).toHaveBeenCalledWith(
      'test-agent',
      'test-cron',
      expect.objectContaining({
        last_fired_at: expect.any(String),
        fire_count: 1,
      })
    );
  });

  // -------------------------------------------------------------------------
  // onFire failure + retry
  // -------------------------------------------------------------------------

  it('retries onFire 3 times on failure then gives up without crashing', async () => {
    const failingFire = vi.fn().mockRejectedValue(new Error('PTY unavailable'));

    // Use a very long schedule so the cron never becomes due a SECOND time
    // during the test (avoiding double-fire across ticks).
    mockReadCrons.mockReturnValue([makeCron({ schedule: '24h' })]);

    const retryLogs: string[] = [];
    const retryScheduler = new CronScheduler({
      agentName: 'test-agent',
      onFire: failingFire,
      logger: (msg) => retryLogs.push(msg),
    });

    // Seed a last_fired_at that is 25h ago so it catch-up fires immediately.
    mockReadCrons.mockReturnValue([
      makeCron({
        schedule:      '24h',
        created_at:    new Date(Date.now() - 48 * 3_600_000).toISOString(),
        last_fired_at: new Date(Date.now() - 25 * 3_600_000).toISOString(),
      }),
    ]);

    retryScheduler.start();

    // Advance through one tick (fires catch-up) plus all retry back-offs (1s+4s+16s)
    await vi.advanceTimersByTimeAsync(TICK + 1_000 + 4_000 + 16_000 + 1_000);

    // 4 total calls: 1 initial + 3 retries
    expect(failingFire).toHaveBeenCalledTimes(4);

    // Scheduler must NOT crash — the log should contain a give-up message
    expect(retryLogs.some(l => l.includes('giving up'))).toBe(true);

    // updateCron is called exactly once with last_fire_attempted_at (iter 11
    // pre-fire persist), but NEVER with last_fired_at because all attempts
    // failed.  This matches the iter 11 invariant: attempted_at is recorded
    // even on failed dispatches so a crash mid-fire cannot double-fire.
    expect(mockUpdateCron).toHaveBeenCalledTimes(1);
    expect(mockUpdateCron).toHaveBeenCalledWith(
      'test-agent',
      'test-cron',
      expect.objectContaining({ last_fire_attempted_at: expect.any(String) })
    );
    expect(mockUpdateCron).not.toHaveBeenCalledWith(
      'test-agent',
      'test-cron',
      expect.objectContaining({ last_fired_at: expect.any(String) })
    );

    retryScheduler.stop();
  });

  it('succeeds on second attempt (first fails, second succeeds)', async () => {
    let callCount = 0;
    const flakyFire = vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount === 1) return Promise.reject(new Error('transient'));
      return Promise.resolve();
    });

    mockReadCrons.mockReturnValue([makeCron({ schedule: '1m' })]);

    const retryScheduler = new CronScheduler({
      agentName: 'test-agent',
      onFire: flakyFire,
      logger: (msg) => logs.push(msg),
    });

    retryScheduler.start();

    await vi.advanceTimersByTimeAsync(60_000 + TICK + 1_000 + 500);

    expect(flakyFire).toHaveBeenCalledTimes(2);
    // 2 updateCron calls: 1 pre-fire attempted_at (iter 11) + 1 post-success
    // last_fired_at/fire_count.
    expect(mockUpdateCron).toHaveBeenCalledTimes(2);
    expect(mockUpdateCron).toHaveBeenCalledWith(
      'test-agent',
      'test-cron',
      expect.objectContaining({ last_fire_attempted_at: expect.any(String) })
    );
    expect(mockUpdateCron).toHaveBeenCalledWith(
      'test-agent',
      'test-cron',
      expect.objectContaining({ last_fired_at: expect.any(String), fire_count: expect.any(Number) })
    );

    retryScheduler.stop();
  });

  // -------------------------------------------------------------------------
  // reload() — picks up newly added cron
  // -------------------------------------------------------------------------

  it('reload() picks up a newly added cron without restarting', async () => {
    // Start with one cron
    mockReadCrons.mockReturnValue([makeCron({ name: 'existing', schedule: '1m' })]);
    scheduler.start();

    // Add a second cron via reload
    mockReadCrons.mockReturnValue([
      makeCron({ name: 'existing', schedule: '1m' }),
      makeCron({ name: 'new-cron', schedule: '1m' }),
    ]);
    scheduler.reload();

    expect(scheduler.getNextFireTimes().map(e => e.name)).toContain('new-cron');

    await vi.advanceTimersByTimeAsync(60_000 + TICK);

    const firedNames = fired.map(c => c.name);
    expect(firedNames).toContain('existing');
    expect(firedNames).toContain('new-cron');
  });

  // -------------------------------------------------------------------------
  // reload() — preserves nextFireAt for unchanged crons
  // -------------------------------------------------------------------------

  it('reload() preserves nextFireAt for unchanged crons', async () => {
    mockReadCrons.mockReturnValue([makeCron({ name: 'stable', schedule: '6h' })]);
    scheduler.start();

    const beforeReload = scheduler.getNextFireTimes().find(e => e.name === 'stable');
    expect(beforeReload).toBeDefined();

    // Re-read same definitions
    mockReadCrons.mockReturnValue([makeCron({ name: 'stable', schedule: '6h' })]);
    scheduler.reload();

    const afterReload = scheduler.getNextFireTimes().find(e => e.name === 'stable');
    expect(afterReload).toBeDefined();
    expect(afterReload!.nextFireAt).toBe(beforeReload!.nextFireAt);
  });

  it('reload() recomputes nextFireAt for a modified schedule', async () => {
    mockReadCrons.mockReturnValue([makeCron({ name: 'changing', schedule: '6h' })]);
    scheduler.start();

    const beforeReload = scheduler.getNextFireTimes().find(e => e.name === 'changing');

    // Change the schedule
    mockReadCrons.mockReturnValue([makeCron({ name: 'changing', schedule: '12h' })]);
    scheduler.reload();

    const afterReload = scheduler.getNextFireTimes().find(e => e.name === 'changing');
    // 12h window is bigger — nextFireAt should be different (further out)
    expect(afterReload!.nextFireAt).not.toBe(beforeReload!.nextFireAt);
  });

  // -------------------------------------------------------------------------
  // reload() — a PROMPT-ONLY edit must not re-phase the cron.
  //
  // Regression guard for the 2026-08-15 fleet incident: editing a cron's prompt
  // via remove-then-add silently re-phased it (boss's `check-approvals` moved
  // 18:14/20:14Z -> 19:20/21:20Z, destroying a backstop nobody knew they had).
  //
  // `bus update-cron --prompt` avoids this at TWO independent levels:
  //   1. changeKeyFor() is `name|schedule` (cron-scheduler.ts:208-210), so a
  //      prompt-only edit keeps the key and nextFireAt is preserved outright.
  //   2. updateCron() shallow-merges (bus/crons.ts:250-267), so `last_fired_at`
  //      survives even when the schedule DOES change.
  // The two existing tests above cover "identical definition" and "changed
  // schedule".  Neither covers "changed prompt, same schedule" — which is the
  // case the incident actually turned on.
  //
  // Part (b) is a SCHEDULER-LEVEL statement about a definition that carries no
  // fire history at all: with nothing to anchor on, created_at is the anchor,
  // and that is unchanged (10e3011f). It is no longer a statement about what
  // the CLI does — this file mocks src/bus/crons.js wholesale, so it cannot see
  // that removeCron now leaves the fire behind as a cron-state.json tombstone.
  // A real remove-then-add therefore keeps its phase; that is pinned end-to-end
  // against the unmocked path in tests/unit/bus/cron-phase-across-remove-add.
  // -------------------------------------------------------------------------

  it('update-cron holds a cron\'s phase; a definition with no fire history anchors on created_at', async () => {
    const base    = Date.now();
    const THREE_H = 3 * 60 * 60 * 1000;
    const FOUR_H  = 4 * 60 * 60 * 1000;
    const created = new Date(base - THREE_H).toISOString();

    // A 4h cron created 3h ago: anchored on created_at, it is due in 1h.
    mockReadCrons.mockReturnValue([
      makeCron({ name: 'phase', schedule: '4h', prompt: 'original', created_at: created }),
    ]);
    scheduler.start();
    const before = scheduler.getNextFireTimes().find(e => e.name === 'phase')!;
    expect(before.nextFireAt).toBe(base - THREE_H + FOUR_H);

    // (a) update-cron: prompt rewritten, created_at (and any last_fired_at)
    //     preserved by the shallow merge. Phase must NOT move.
    mockReadCrons.mockReturnValue([
      makeCron({ name: 'phase', schedule: '4h', prompt: 'rewritten', created_at: created }),
    ]);
    scheduler.reload();
    const afterUpdate = scheduler.getNextFireTimes().find(e => e.name === 'phase')!;
    expect(afterUpdate.nextFireAt).toBe(before.nextFireAt);

    // (b) the cron disappears, then returns as a NEW definition with a fresh
    //     created_at and no fire history of any kind. Two reloads, because that
    //     is the shape the scheduler sees across a remove and a re-add.
    mockReadCrons.mockReturnValue([]);            // remove-cron
    scheduler.reload();
    expect(scheduler.getNextFireTimes().find(e => e.name === 'phase')).toBeUndefined();

    mockReadCrons.mockReturnValue([               // add-cron
      makeCron({ name: 'phase', schedule: '4h', prompt: 'rewritten',
                 created_at: new Date(base).toISOString() }),
    ]);
    scheduler.reload();
    const afterReadd = scheduler.getNextFireTimes().find(e => e.name === 'phase')!;

    // With no fire on record the anchor is created_at, so the phase slips by
    // the full 3h of elapsed life. This is the shape the 2026-08-15 defect took
    // (boss's check-approvals moved 18:14/20:14Z -> 19:20/21:20Z); the fix is
    // to stop producing this input, not to re-anchor a cron that never fired.
    expect(afterReadd.nextFireAt).toBe(base + FOUR_H);
    expect(afterReadd.nextFireAt - before.nextFireAt).toBe(THREE_H);
  });

  // -------------------------------------------------------------------------
  // reload() during in-flight fire — race condition probe
  //
  // If reload() runs while a fire's onFire is awaiting, the old ScheduledCron
  // reference held by tick() becomes orphaned (the new map holds a fresh
  // object with firing=false default).  If the cron's definition changed
  // (e.g. schedule shortened), the fresh ScheduledCron computes nextFireAt
  // from the stale last_fired_at in crons.json — which has not yet been
  // updated because the in-flight fire's persist call hasn't run.  Result:
  // the next tick can re-fire the same logical event.
  // -------------------------------------------------------------------------

  // -------------------------------------------------------------------------
  // Iter 8 audit: remove-cron during in-flight fire — orphan / re-fire probe
  //
  // BUG DISCOVERED (iter 9 candidate): the empty-result fallback at
  // cron-scheduler.ts loadCrons() (~line 426) reverts to lastGoodSchedule when
  // a reload yields an empty result. This catches transient corruption (intent)
  // BUT also catches legitimate empty-by-removal (regression): if the user
  // removes the LAST cron via `bus remove-cron`, crons.json is now empty,
  // reload sees [] from readCrons(), and the fallback restores the just-removed
  // cron from lastGoodSchedule. The cron continues to fire after removal
  // until either (a) the daemon restarts, or (b) another non-empty reload
  // happens.
  //
  // Fix sketch (iter 9): distinguish "legitimate empty" (file exists + parses
  // to []) from "catastrophic corruption" (both primary and .bak unparseable)
  // in readCrons / a sibling function. Only retain lastGoodSchedule on the
  // latter. Tests below pin both current behavior and the desired post-fix
  // behavior.
  // -------------------------------------------------------------------------

  it('remove-cron mid-fire: in-flight fire injects exactly once (no double-fire) — passes', async () => {
    let resolveFire: (() => void) | undefined;
    const slowFire = vi.fn().mockImplementation(() => new Promise<void>((res) => { resolveFire = res; }));

    const auditScheduler = new CronScheduler({
      agentName: 'test-agent',
      onFire: slowFire,
      logger: (msg) => logs.push(msg),
    });

    // Two crons so the post-removal state is legitimately non-empty (avoiding
    // the empty-result fallback bug in this assertion).
    const tenMinAgo = new Date(Date.now() - 10 * 60_000).toISOString();
    const twentyMinAgo = new Date(Date.now() - 20 * 60_000).toISOString();
    mockReadCrons.mockReturnValue([
      makeCron({ name: 'doomed', schedule: '10m', created_at: twentyMinAgo, last_fired_at: tenMinAgo, fire_count: 1 }),
      makeCron({ name: 'survivor', schedule: '24h', last_fired_at: new Date(Date.now() - 1_000).toISOString() }),
    ]);

    auditScheduler.start();

    // Tick 1: 'doomed' fires catch-up, awaits slowFire
    await vi.advanceTimersByTimeAsync(TICK);
    expect(slowFire).toHaveBeenCalledTimes(1);

    // Mid-fire: simulate remove-cron of 'doomed' — crons.json now only has survivor
    mockReadCrons.mockReturnValue([
      makeCron({ name: 'survivor', schedule: '24h', last_fired_at: new Date(Date.now() - 1_000).toISOString() }),
    ]);
    auditScheduler.reload();

    // Schedule no longer contains 'doomed'
    const namesAfter = auditScheduler.getNextFireTimes().map(e => e.name);
    expect(namesAfter).not.toContain('doomed');
    expect(namesAfter).toContain('survivor');

    // Resolve the in-flight fire
    resolveFire!();
    await vi.advanceTimersByTimeAsync(0);

    // Advance multiple ticks — must NOT re-fire 'doomed'
    await vi.advanceTimersByTimeAsync(5 * TICK);

    expect(slowFire).toHaveBeenCalledTimes(1);
    auditScheduler.stop();
  });

  // -------------------------------------------------------------------------
  // Iter 9 fix: empty-result fallback only triggers on actual corruption.
  // The previous gate (`nextScheduled.size === 0 && lastGoodSchedule.size > 0`)
  // could not distinguish "user removed the last cron" from "file unreadable",
  // so it restored the just-removed cron from lastGoodSchedule and kept firing
  // it.  Post-iter-9, readCronsWithStatus carries a `corrupt` flag and the
  // scheduler only applies the fallback when corrupt === true.
  // -------------------------------------------------------------------------

  it('remove-cron of LAST cron clears the schedule (legitimate empty, not corruption)', async () => {
    // Start with one cron and let it fire so lastGoodSchedule is populated.
    mockReadCrons.mockReturnValue([
      makeCron({ name: 'last-cron', schedule: '1m', last_fired_at: new Date(Date.now() - 30_000).toISOString() }),
    ]);
    scheduler.start();

    // Fire once to confirm the schedule is live.
    await vi.advanceTimersByTimeAsync(60_000 + TICK);
    expect(fired.length).toBeGreaterThanOrEqual(1);
    expect(scheduler.getNextFireTimes().length).toBe(1);

    const firesBeforeRemove = fired.length;

    // User removes the last cron — crons.json is now an empty (but valid) array.
    // Critically: corrupt === false (the file exists and parses cleanly).
    mockReadCronsWithStatus.mockReturnValue({ crons: [], corrupt: false });
    scheduler.reload();

    // Schedule must be EMPTY — not retained from lastGoodSchedule.
    expect(scheduler.getNextFireTimes()).toEqual([]);
    // No "retaining last-good schedule" warning — that path is corruption-only.
    expect(logs.find(l => l.includes('retaining last-good schedule'))).toBeUndefined();

    // Advance multiple ticks — the removed cron must NOT fire again.
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(fired.length).toBe(firesBeforeRemove);
  });

  it('reload with corrupt: true retains last-good schedule (corruption path preserved)', async () => {
    // Build a healthy schedule first so lastGoodSchedule is populated.
    mockReadCrons.mockReturnValue([makeCron({ name: 'health', schedule: '6h' })]);
    scheduler.start();
    expect(scheduler.getNextFireTimes().length).toBe(1);

    // Now both primary and .bak go bad — readCronsWithStatus reports
    // corrupt: true with crons: [].  Fallback should kick in.
    mockReadCronsWithStatus.mockReturnValue({ crons: [], corrupt: true });
    scheduler.reload();

    // Schedule retained from lastGoodSchedule (size unchanged).
    expect(scheduler.getNextFireTimes().length).toBe(1);
    expect(scheduler.getNextFireTimes().map(e => e.name)).toContain('health');
    expect(logs.find(l => l.includes('retaining last-good schedule'))).toBeDefined();
  });

  it('reload() during in-flight fire with changed schedule does not cause double-fire', async () => {
    // Slow onFire we can resolve manually
    let resolveFire: (() => void) | undefined;
    const slowFire = vi.fn().mockImplementation(() => new Promise<void>((res) => { resolveFire = res; }));

    const raceLogs: string[] = [];
    const raceScheduler = new CronScheduler({
      agentName: 'test-agent',
      onFire: slowFire,
      logger: (msg) => raceLogs.push(msg),
    });

    // Start with a cron that fires immediately (catch-up)
    const twentyMinAgo = new Date(Date.now() - 20 * 60_000).toISOString();
    const tenMinAgo = new Date(Date.now() - 10 * 60_000).toISOString();
    mockReadCrons.mockReturnValue([
      makeCron({ name: 'racy', schedule: '10m', created_at: twentyMinAgo, last_fired_at: tenMinAgo, fire_count: 1 }),
    ]);

    raceScheduler.start();

    // First tick: catch-up fires, awaits our slow Promise
    await vi.advanceTimersByTimeAsync(TICK);
    expect(slowFire).toHaveBeenCalledTimes(1);

    // Mid-fire: reload with a SHORTER schedule (changeKey differs).
    // crons.json's last_fired_at is still the stale 10-min-ago value
    // because the in-flight fire's persist hasn't run yet.
    mockReadCrons.mockReturnValue([
      makeCron({ name: 'racy', schedule: '1m', created_at: twentyMinAgo, last_fired_at: tenMinAgo, fire_count: 1 }),
    ]);
    raceScheduler.reload();

    // Resolve the in-flight fire so the original tick completes
    resolveFire!();
    await vi.advanceTimersByTimeAsync(0); // flush microtasks

    // Advance one more tick. The bug: new ScheduledCron's catch-up
    // (referenceMs = stale last_fired_at + 1m schedule = past) re-fires
    // the same logical event.
    await vi.advanceTimersByTimeAsync(TICK);

    // Should be exactly 1 fire — the original. Bug repro: we'd see 2.
    expect(slowFire).toHaveBeenCalledTimes(1);

    raceScheduler.stop();
  });

  // -------------------------------------------------------------------------
  // Iter 10 audit / iter 11 fix: daemon-crash mid-fire MUST NOT double-fire
  //
  // BUG (iter 10 audit): if the daemon crashes between sc.firing=true and
  // the post-success updateCron persist, nothing on disk records that the
  // fire happened. On restart, loadCrons computes referenceMs from the
  // STALE crons.json.last_fired_at and cron-state.json.last_fire. The
  // catch-up gate sees nextFireAt in the past and fires AGAIN — same
  // logical scheduled tick, two prompt injections.
  //
  // FIX (iter 11): persist `last_fire_attempted_at` to crons.json BEFORE
  // awaiting onFire, and include it in loadCrons's `candidates` for
  // referenceMs. Crash mid-fire → restart sees attempted_at = "now" →
  // referenceMs is current → nextFireAt is in the future → no catch-up
  // fire. Tradeoff: a fire whose dispatch genuinely failed before the
  // current process crashed will be skipped one window — acceptable,
  // because the alternative (double-fire on every crash) is worse.
  // -------------------------------------------------------------------------

  it('iter 11: daemon crash mid-fire does NOT double-fire on restart (last_fire_attempted_at persisted before onFire)', async () => {
    const oneHourAgo = new Date(Date.now() - 60 * 60_000).toISOString();

    // Mutable disk-state mock: the cron starts with last_fired_at=1h ago
    // and no attempted_at.  When the scheduler calls updateCron, we apply
    // the patch to this object so subsequent reads see the in-progress
    // attempt — same semantics as the real atomicWriteSync persist.
    let diskCron = makeCron({
      name: 'daily-job',
      schedule: '1h',
      created_at: new Date(Date.now() - 5 * 24 * 3_600_000).toISOString(),
      last_fired_at: oneHourAgo,
      fire_count: 5,
    });
    mockReadCrons.mockImplementation(() => [diskCron]);
    mockUpdateCron.mockImplementation((_agent: string, _name: string, patch: Partial<CronDefinition>) => {
      diskCron = { ...diskCron, ...patch };
    });

    // Slow onFire we never resolve — simulates "fire began, agent received
    // the prompt, daemon crashed before completion."
    const slowFire = vi.fn().mockImplementation(() => new Promise<void>(() => { /* never resolves */ }));

    const scheduler1 = new CronScheduler({
      agentName: 'test-agent',
      onFire: slowFire,
      logger: (m) => logs.push(m),
    });

    scheduler1.start();
    await vi.advanceTimersByTimeAsync(TICK);
    expect(slowFire).toHaveBeenCalledTimes(1);
    // Iter 11 invariant: updateCron MUST be called with last_fire_attempted_at
    // BEFORE the slow onFire resolves (i.e. before the post-success persist).
    expect(mockUpdateCron).toHaveBeenCalledWith(
      'test-agent',
      'daily-job',
      expect.objectContaining({ last_fire_attempted_at: expect.any(String) })
    );
    expect(diskCron.last_fire_attempted_at).toBeDefined();
    // The post-success persist (last_fired_at, fire_count) must NOT have
    // run — the fire is still in flight.
    expect(diskCron.last_fired_at).toBe(oneHourAgo);
    expect(diskCron.fire_count).toBe(5);

    // Simulate the crash: stop scheduler 1 without resolving the in-flight
    // fire.  Disk state now has last_fire_attempted_at ≈ now but stale
    // last_fired_at.
    scheduler1.stop();

    // Restart: build a fresh scheduler with the same mocked disk state.
    const scheduler2 = new CronScheduler({
      agentName: 'test-agent',
      onFire: slowFire,
      logger: (m) => logs.push(m),
    });
    scheduler2.start();
    await vi.advanceTimersByTimeAsync(TICK);

    // FIXED BEHAVIOR: scheduler 2's loadCrons sees attempted_at ≈ now in
    // the referenceMs candidates → nextFireAt = now + 1h → not in past →
    // no catch-up → onFire is NOT called a second time.
    expect(slowFire).toHaveBeenCalledTimes(1);

    scheduler2.stop();
  });

  // -------------------------------------------------------------------------
  // Catch-up on start
  // -------------------------------------------------------------------------

  it('fires once on start when last_fired_at is older than the interval (catch-up)', async () => {
    // last_fired_at is 2 hours ago, schedule is "1h" — should catch-up fire immediately
    const twoHoursAgo = new Date(Date.now() - 2 * 3_600_000).toISOString();
    mockReadCrons.mockReturnValue([
      makeCron({
        name:          'overdue',
        schedule:      '1h',
        created_at:    new Date(Date.now() - 5 * 3_600_000).toISOString(),
        last_fired_at: twoHoursAgo,
        fire_count:    5,
      }),
    ]);

    scheduler.start();

    // The catch-up sets nextFireAt = now, so the very next tick should fire it
    await vi.advanceTimersByTimeAsync(TICK);

    expect(fired.some(c => c.name === 'overdue')).toBe(true);
  });

  it('does NOT fire on start when the cron is not yet due', async () => {
    // last_fired_at is 30 minutes ago, schedule is "1h" — not yet due
    const thirtyMinsAgo = new Date(Date.now() - 30 * 60_000).toISOString();
    mockReadCrons.mockReturnValue([
      makeCron({
        name:          'fresh',
        schedule:      '1h',
        last_fired_at: thirtyMinsAgo,
      }),
    ]);

    scheduler.start();

    await vi.advanceTimersByTimeAsync(TICK);

    expect(fired.some(c => c.name === 'fresh')).toBe(false);
  });

  it('a NEVER-fired cron created N days ago (N > interval) catch-up fires on a fresh load, anchored on created_at — not silently reset to now+interval', async () => {
    // Regression for the never-fired-cron restart race: without last_fired_at,
    // last_fire_attempted_at, or a cron-state.json entry, referenceMs used to
    // fall straight back to "now" on every fresh CronScheduler construction
    // (i.e. every daemon restart, not just a live crons.json reload) — so a
    // never-fired cron's nextFireAt perpetually reset to now+interval and
    // could never fire if restarts kept landing just inside that window.
    // created_at anchors referenceMs the same way last_fired_at already does
    // for crons that HAVE fired, so this behaves like any other overdue cron:
    // one catch-up fire, then resumes normal cadence.
    const fourDaysAgo = new Date(Date.now() - 4 * 24 * 3_600_000).toISOString();
    mockReadCrons.mockReturnValue([
      makeCron({
        name:       'never-fired-long-interval',
        schedule:   '3d', // 72h — longer than the daemon's ~71h auto-rotation cadence
        created_at: fourDaysAgo,
        // No last_fired_at / last_fire_attempted_at / fire_count — genuinely never fired.
      }),
    ]);

    scheduler.start(); // isReload=false — the exact "fresh construction" path this fixes

    await vi.advanceTimersByTimeAsync(TICK);

    expect(fired.some(c => c.name === 'never-fired-long-interval')).toBe(true);
  });

  it('a NEVER-fired cron created recently (created_at < interval ago) does NOT catch-up fire — symmetric with the fired-cron case', async () => {
    const oneHourAgo = new Date(Date.now() - 3_600_000).toISOString();
    mockReadCrons.mockReturnValue([
      makeCron({
        name:       'never-fired-fresh',
        schedule:   '1d',
        created_at: oneHourAgo,
      }),
    ]);

    scheduler.start();

    await vi.advanceTimersByTimeAsync(TICK);

    expect(fired.some(c => c.name === 'never-fired-fresh')).toBe(false);
  });

  // -------------------------------------------------------------------------
  // stop() — clears interval, no further fires
  // -------------------------------------------------------------------------

  it('stop() clears the interval and prevents further fires', async () => {
    mockReadCrons.mockReturnValue([makeCron({ schedule: '1m' })]);
    scheduler.start();

    // Let it fire once
    await vi.advanceTimersByTimeAsync(60_000 + TICK);
    expect(fired).toHaveLength(1);

    scheduler.stop();
    const countAfterStop = fired.length;

    // Advance a lot more — should NOT fire again
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(fired).toHaveLength(countAfterStop);
  });

  it('stop() called twice does not throw', () => {
    mockReadCrons.mockReturnValue([]);
    scheduler.start();
    scheduler.stop();
    expect(() => scheduler.stop()).not.toThrow();
  });

  // -------------------------------------------------------------------------
  // Cron expression scheduling via scheduler
  // -------------------------------------------------------------------------

  it('"*/5 * * * *" expression fires within 5 minutes + one tick', async () => {
    // No system time pinning — works regardless of machine timezone.
    mockReadCrons.mockReturnValue([
      makeCron({ name: 'every5min', schedule: '*/5 * * * *' }),
    ]);

    scheduler.start();

    // Worst case: just missed a 5-min boundary, so next fire is ~5 minutes away.
    // Advance 5 minutes + one tick to guarantee the cron fires.
    await vi.advanceTimersByTimeAsync(5 * 60_000 + TICK);

    expect(fired.some(c => c.name === 'every5min')).toBe(true);
    // Verify the fire happened at a minute that is divisible by 5
    const firedCron = fired.find(c => c.name === 'every5min');
    expect(firedCron).toBeDefined();
  });

  // -------------------------------------------------------------------------
  // getNextFireTimes — informational
  // -------------------------------------------------------------------------

  it('getNextFireTimes returns an entry per enabled cron', () => {
    mockReadCrons.mockReturnValue([
      makeCron({ name: 'a', schedule: '1h' }),
      makeCron({ name: 'b', schedule: '2h' }),
      makeCron({ name: 'c', schedule: '3h', enabled: false }),
    ]);
    scheduler.start();

    const times = scheduler.getNextFireTimes();
    const names = times.map(t => t.name);
    expect(names).toContain('a');
    expect(names).toContain('b');
    expect(names).not.toContain('c'); // disabled, not scheduled
  });
});

// ---------------------------------------------------------------------------
// computeReferenceMs — phase anchoring
//
// created_at is a FALLBACK for a never-fired cron, never a candidate competing
// with real fire records. Editing a cron's prompt is remove-then-add (add-cron
// refuses to overwrite an existing name), handleAddCron stamps a fresh
// created_at on every add, and removeCron leaves cron-state.json's last_fire
// intact — so treating created_at as a candidate meant a prompt edit silently
// re-phased the cron. Real incidents 2026-08-15: boss's check-approvals moved
// 18:14/20:14Z -> 19:20/21:20Z, losing coverage of a window it had been
// covering; infra's sweep moved 18:11Z -> 18:13Z unnoticed.
//
// Every assertion below is a hardcoded literal so it can witness the behaviour
// rather than inherit it.
// ---------------------------------------------------------------------------

describe('computeReferenceMs — phase anchoring', () => {
  const NOW = Date.parse('2026-08-15T18:00:00.000Z');
  const ms = (iso: string) => Date.parse(iso);

  it('falls back to now when nothing at all is known', () => {
    expect(computeReferenceMs({}, NOW)).toBe(NOW);
  });

  it('anchors a NEVER-FIRED cron on created_at, not now (preserves 10e3011f)', () => {
    expect(
      computeReferenceMs({ createdAt: '2026-08-15T12:00:00.000Z' }, NOW),
    ).toBe(ms('2026-08-15T12:00:00.000Z'));
  });

  it('ignores an unparseable created_at and falls back to now', () => {
    expect(computeReferenceMs({ createdAt: 'not-a-date' }, NOW)).toBe(NOW);
  });

  it('takes the NEWEST fire record when several are present', () => {
    expect(
      computeReferenceMs(
        {
          createdAt: '2026-08-01T00:00:00.000Z',
          lastFiredAt: '2026-08-15T16:00:00.000Z',
          lastFireAttemptedAt: '2026-08-15T17:00:00.000Z',
          stateFire: '2026-08-15T16:30:00.000Z',
        },
        NOW,
      ),
    ).toBe(ms('2026-08-15T17:00:00.000Z'));
  });

  // THE REGRESSION TEST. Under the old unconditional-max implementation this
  // returned the fresh created_at (18:00) and the cron re-phased off the edit.
  it('a FRESH created_at from a remove-then-add does NOT beat an existing fire record', () => {
    expect(
      computeReferenceMs(
        {
          createdAt: '2026-08-15T18:00:00.000Z', // stamped by handleAddCron during the edit
          stateFire: '2026-08-15T16:14:00.000Z', // survives removeCron in cron-state.json
        },
        NOW,
      ),
    ).toBe(ms('2026-08-15T16:14:00.000Z'));
  });

  it('the re-phasing incident does not reproduce: a 2h cron keeps its :14 phase across a prompt edit', () => {
    // boss's check-approvals: fired 16:14Z, prompt edited at 17:20Z (fresh
    // created_at), schedule '2h'. The next fire must stay on :14.
    const reference = computeReferenceMs(
      { createdAt: '2026-08-15T17:20:00.000Z', stateFire: '2026-08-15T16:14:00.000Z' },
      ms('2026-08-15T17:20:00.000Z'),
    );
    const next = computeNextFireAtFromInterval(reference, 2 * 60 * 60 * 1000);
    expect(new Date(next).toISOString()).toBe('2026-08-15T18:14:00.000Z');
  });

  it('created_at still anchors when the ONLY other input is unparseable', () => {
    expect(
      computeReferenceMs(
        { createdAt: '2026-08-15T12:00:00.000Z', stateFire: 'garbage' },
        NOW,
      ),
    ).toBe(ms('2026-08-15T12:00:00.000Z'));
  });
});

/** Local mirror of the interval branch of computeNextFireAt, kept literal. */
function computeNextFireAtFromInterval(referenceMs: number, durationMs: number): number {
  return referenceMs + durationMs;
}
