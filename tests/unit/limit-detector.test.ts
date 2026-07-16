// tests/unit/limit-detector.test.ts
import { describe, it, expect } from 'vitest';
import { stripAnsi, scanForLimit, LimitScanner } from '../../src/daemon/limit-detector.js';

// Real sequences captured from the 2026-07-14/15 incidents. Cursor-positioning
// escapes sit BETWEEN words — after stripping, words may join with no space.
const WEEKLY_RAW = `\x1b[38;5;246m  ⎿  \x1b[38;5;211mYou've hit your weekly limit · resets Jul 20 at 6am (UTC)\x1b[1B\x1b[39m` +
  `\x1b[48;5;237m\x1b[38;5;239m❯ \x1b[38;5;231m/rate-limit-options\x1b[39m` +
  `\x1b[3G\x1b[1mWhat\x1b[9Gdo\x1b[12Gyou\x1b[16Gwant\x1b[21Gto\x1b[24Gdo?\x1b[22m`;
const SESSION_RAW = `⎿  You've hit your session limit · resets 3am (UTC)Brewed for 0sWhat do you want to do? 1`;

// 2026-07-16T00:00:00Z
const NOW = Date.UTC(2026, 6, 16);

describe('stripAnsi', () => {
  it('removes CSI and OSC sequences', () => {
    expect(stripAnsi('\x1b[38;5;211mhi\x1b[39m \x1b]0;title\x07there')).toBe('hi there');
  });
});

describe('scanForLimit', () => {
  it('detects weekly limit with dialog marker split by cursor escapes', () => {
    const ev = scanForLimit(stripAnsi(WEEKLY_RAW), NOW);
    expect(ev).not.toBeNull();
    expect(ev!.kind).toBe('weekly');
    // resets Jul 20 at 6am (UTC) → 2026-07-20T06:00:00Z
    expect(ev!.resetAt).toBe(Date.UTC(2026, 6, 20, 6));
  });

  it('detects session limit with time-only reset resolving to next future occurrence', () => {
    const ev = scanForLimit(stripAnsi(SESSION_RAW), NOW);
    expect(ev).not.toBeNull();
    expect(ev!.kind).toBe('session');
    // "3am (UTC)" after 2026-07-16T00:00Z → 2026-07-16T03:00Z
    expect(ev!.resetAt).toBe(Date.UTC(2026, 6, 16, 3));
  });

  it('rolls a time-only reset to tomorrow when already past', () => {
    const at4am = Date.UTC(2026, 6, 16, 4);
    const ev = scanForLimit(stripAnsi(SESSION_RAW), at4am);
    expect(ev!.resetAt).toBe(Date.UTC(2026, 6, 17, 3));
  });

  it('returns null for limit phrase WITHOUT the dialog marker (agent quoting text)', () => {
    const quoted = `boss said "You've hit your weekly limit · resets Jul 20 at 6am (UTC)" in the incident report`;
    expect(scanForLimit(quoted, NOW)).toBeNull();
  });

  it('returns null for dialog marker without the limit phrase', () => {
    expect(scanForLimit('What do you want to do? 1. Stop', NOW)).toBeNull();
  });

  it('returns null resetAt for non-UTC timezones', () => {
    const et = `You've hit your weekly limit · resets Jul 20 at 2am (America/New_York) What do you want to do?`;
    const ev = scanForLimit(et, NOW);
    expect(ev).not.toBeNull();
    expect(ev!.resetAt).toBeNull();
  });
});

describe('LimitScanner', () => {
  it('fires once, then suppresses re-fires for 5 minutes', () => {
    let t = NOW;
    const s = new LimitScanner(() => t);
    expect(s.push(SESSION_RAW)).not.toBeNull();
    expect(s.push(SESSION_RAW)).toBeNull();          // TUI re-render, suppressed
    t = NOW + 5 * 60_000 + 1;
    expect(s.push(SESSION_RAW)).not.toBeNull();      // suppression expired
  });

  it('keeps only the last 4KB of window', () => {
    const s = new LimitScanner(() => NOW);
    s.push('x'.repeat(5000));
    expect(s.push(SESSION_RAW)).not.toBeNull();      // banner still detectable after big flush
  });
});
