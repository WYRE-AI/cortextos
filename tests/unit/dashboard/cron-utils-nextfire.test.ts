/**
 * Pins the dashboard's cron-expression evaluator to the DAEMON's semantics.
 *
 * `dashboard/src/lib/cron-utils.ts` is a deliberate duplicate of daemon logic —
 * the dashboard is a separate Next.js app that cannot import daemon-side
 * modules — and its header says "any changes to the core parsing logic should
 * be reflected here as well". PR #21 (1e24108d) moved cron-expression
 * evaluation off ambient local time to the cron's `timezone` (default UTC) in
 * the daemon, and that change was never reflected on the dashboard side. Two
 * inline copies (crons/route.ts and health/route.ts) kept matching fields with
 * local getters, so the daemon fired "0 9 * * *" at 09:00 UTC while the
 * dashboard displayed 09:00 LOCAL — a 4-5h lie in the UI on the EDT fleet host
 * — and `cron.timezone` was ignored outright.
 *
 * This file lives in the ROOT test tree, not `dashboard/src/lib/__tests__`,
 * precisely because it imports BOTH implementations to compare them. Root tests
 * importing dashboard modules is the established direction (see
 * tests/integration/phase4-performance.test.ts); the reverse drags root `src/`
 * into the dashboard's TypeScript program, which targets a lower ES level and
 * fails to compile unrelated root files.
 *
 * Every expectation is an absolute UTC instant, so these hold on any host
 * timezone — the fragility that let the original bug hide.
 */

import { describe, it, expect } from 'vitest';
import { nextFireFromCronExpr } from '../../../dashboard/src/lib/cron-utils';
import { nextFireFromCron } from '../../../src/daemon/cron-scheduler';

const AT = (iso: string) => Date.parse(iso);

describe('dashboard nextFireFromCronExpr — matches the daemon', () => {
  it('evaluates in UTC by default, NOT the host local timezone', () => {
    // The regression itself: on an EDT host the old code returned 13:00Z here.
    expect(nextFireFromCronExpr('0 9 * * *', AT('2026-07-13T00:00:00.000Z')))
      .toBe(AT('2026-07-13T09:00:00.000Z'));
  });

  it('honors an explicit IANA timezone (0 3 * * * America/New_York → 07:00Z in EDT)', () => {
    expect(nextFireFromCronExpr('0 3 * * *', AT('2026-07-15T00:00:00.000Z'), 'America/New_York'))
      .toBe(AT('2026-07-15T07:00:00.000Z'));
  });

  it('returns NaN for a calendar-impossible dom+month instead of scanning a year', () => {
    const t0 = performance.now();
    expect(nextFireFromCronExpr('0 0 31 2 *', AT('2026-07-13T08:00:00.000Z'))).toBeNaN();
    expect(performance.now() - t0).toBeLessThan(120);
  });

  it('fails safe (NaN) on an invalid IANA timezone rather than throwing', () => {
    expect(nextFireFromCronExpr('0 9 * * *', AT('2026-07-13T00:00:00.000Z'), 'Not/AZone')).toBeNaN();
  });

  it('agrees with the daemon implementation across every cron field', () => {
    const cases: Array<{ from: string; expr: string; tz?: string }> = [
      { from: '2026-07-13T08:00:00.000Z', expr: '*/15 * * * *' },
      { from: '2026-07-13T08:00:00.000Z', expr: '0 9 * * 1-5' },
      { from: '2026-12-31T23:59:00.000Z', expr: '30 6 1 * *' },
      { from: '2026-03-08T06:30:00.000Z', expr: '0 2 * * *' },
      { from: '2027-01-29T00:00:00.000Z', expr: '0 0 31 1,2 *' },
      { from: '2028-02-27T00:00:00.000Z', expr: '0 0 29 2 *' },
      { from: '2026-07-13T00:00:00.000Z', expr: '0 3 * * *', tz: 'America/New_York' },
      { from: '2026-01-10T00:00:00.000Z', expr: '0 3 * * *', tz: 'America/New_York' }, // EST, not EDT
      { from: '2026-07-13T00:00:00.000Z', expr: '0 9 * * 1', tz: 'Asia/Tokyo' },
    ];
    for (const { from, expr, tz } of cases) {
      const fromMs = AT(from);
      expect(
        nextFireFromCronExpr(expr, fromMs, tz),
        `${expr} @ ${from}${tz ? ` [${tz}]` : ''}`,
      ).toBe(nextFireFromCron(expr, fromMs, tz));
    }
  });
});
