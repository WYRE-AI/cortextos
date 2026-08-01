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

describe('scanForLimit — golden sample, live-captured 2026-08-01 (PR #54 review, F4)', () => {
  // Pulled directly from murph's own fleet filesystem
  // (~/.cortextos/wyre-gateway/logs/boss/stdout.log) — a REAL banner that
  // fired in boss's actual running session, not a hand-typed guess at
  // current wording. Confirms the regexes above (captured 07-14/07-15,
  // 2.5 weeks earlier) still match the live TUI as of today: same
  // "You've hit your ... limit · resets ..." phrase, same "What do you want
  // to do?" dialog marker, same "/rate-limit-options" echo. No wording
  // drift found. Includes the surrounding statusline noise (model/cwd/cost)
  // untouched, exactly as captured, to prove the scanner tolerates real
  // session chrome around the banner, not just a hand-trimmed excerpt.
  const LIVE_2026_08_01 = `ion\x07\x1b[?25l\x1b[2D\x1b[5B\x0d\x1b[9A\x1b[38;5;246m  ⎿  \x1b[38;5;211mYou've hit your session limit · resets 4am (America/New_York)\x0d\x1b[1B\x1b[39m\x1b[K\x0d\x1b[1B\x1b[38;5;246m✻\x1b[3GCooked for 0s\x0d\x1b[1B\x1b[39m\x1b[K\x0d\x1b[1B\x1b[38;5;244m` + '─'.repeat(200) +
    `\x0d\x1b[1B\x1b[39m❯ \x1b[K\x0d\x1b[1B\x1b[38;5;244m` + '─'.repeat(200) +
    `\x0d\x1b[3C\x1b[1B\x1b[48;5;73m\x1b[38;5;16mMo\x1b[7Gel: Opu\x1b[15G 4.8 \x1b[48;5;239m\x1b[38;5;73m\x1b[38;5;254m Ctx: 211.2k \x1b[48;5;25m\x1b[38;5;239m\x1b[38;5;231m ⎇ main \x1b[48;5;96m\x1b[38;5;25m\x1b[38;5;231m (+0,-0) \x1b[49m\x1b[38;5;96m\x1b[39m\x1b[K\x0d\x1b[2C\x1b[1B\x1b[48;5;73m\x1b[38;5;16m cwd: /Users/asachs/cortextos/orgs/wyre-gateway/agents/boss \x1b[48;5;239m\x1b[38;5;73m\x1b[38;5;254m Cost: $9.74 \x1b[49m\x1b[38;5;239m\x1b[39m\x0d\x0d\x0a\x1b[3G\x1b[38;5;211m⏵⏵\x1b[6Gbypass\x1b[13Gpermissions\x1b[25Gon\x1b[38;5;246m (shift+tab\x1b[39Gto\x1b[42Gcycle)\x1b[49G·\x1b[51G←\x1b[53Gfor\x1b[57Gagents\x1b[39m\x0d\x0d\x0a\x1b[2C\x1b[5A\x1b[?25h\x1b[?25l\x1b[2D\x1b[5B\x0d\x1b[6A\x1b[48;5;237m\x1b[38;5;239m❯ \x1b[38;5;231m/rate-limit-options\x1b[39m` + ' '.repeat(180) +
    `\x0d\x1b[1B\x1b[49m\x1b[K\x0d\x1b[1B\x1b[38;5;153m` + '─'.repeat(200) +
    `\x0d\x1b[2C\x1b[1B\x1b[1mWhat do you want to do?\x1b[22m\x1b[39m\x1b[K\x0d\x1b[2C\x1b[1B\x1b[K\x0d\x1b[2C\x1b[1B\x1b[38;5;153m❯\x1b[39m \x1b[38;5;246m1. \x1b[38;5;153mStop and wait for limit to reset\x1b[39m\x1b[K\x0d\x0d\x0a\x1b[5G\x1b[38;5;246m2.\x1b[8G\x1b[39mAdd\x1b[12Gfunds\x1b[18Gto\x1b[21Gcontinue\x1b[30Gwith\x1b[35Gusage\x1b[41Gcredits\x0d\x0d`;

  it('detects the live-captured banner, dialog marker intact, no wording drift from the 07-14/07-15 samples above', () => {
    const ev = scanForLimit(stripAnsi(LIVE_2026_08_01), NOW);
    expect(ev).not.toBeNull();
    expect(ev!.kind).toBe('session');
    expect(ev!.matchedText.replace(/\s+/g, '').toLowerCase()).toBe("you'vehityoursessionlimit");
    // Non-UTC (America/New_York) — correctly unparsed, same as the existing
    // non-UTC test above; this is a real instance of that same shape.
    expect(ev!.resetAt).toBeNull();
  });

  it('LimitScanner fires exactly once on the live-captured banner, same as the synthetic fixtures', () => {
    const s = new LimitScanner(() => NOW);
    expect(s.push(LIVE_2026_08_01)).not.toBeNull();
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
