// tests/unit/limit-detector.test.ts
import { describe, it, expect } from 'vitest';
import {
  stripAnsi,
  stripAnsiTrackingCursor,
  scanForLimit,
  parseResetHint,
  LimitScanner,
} from '../../src/daemon/limit-detector.js';

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
    `\x0d\x1b[3C\x1b[1B\x1b[48;5;73m\x1b[38;5;16mMo\x1b[7Gel: Opu\x1b[15G 4.8 \x1b[48;5;239m\x1b[38;5;73m\x1b[38;5;254m Ctx: 211.2k \x1b[48;5;25m\x1b[38;5;239m\x1b[38;5;231m ⎇ main \x1b[48;5;96m\x1b[38;5;25m\x1b[38;5;231m (+0,-0) \x1b[49m\x1b[38;5;96m\x1b[39m\x1b[K\x0d\x1b[2C\x1b[1B\x1b[48;5;73m\x1b[38;5;16m cwd: /home/operator/cortextos/orgs/example/agents/example \x1b[48;5;239m\x1b[38;5;73m\x1b[38;5;254m Cost: $9.74 \x1b[49m\x1b[38;5;239m\x1b[39m\x0d\x0d\x0a\x1b[3G\x1b[38;5;211m⏵⏵\x1b[6Gbypass\x1b[13Gpermissions\x1b[25Gon\x1b[38;5;246m (shift+tab\x1b[39Gto\x1b[42Gcycle)\x1b[49G·\x1b[51G←\x1b[53Gfor\x1b[57Gagents\x1b[39m\x0d\x0d\x0a\x1b[2C\x1b[5A\x1b[?25h\x1b[?25l\x1b[2D\x1b[5B\x0d\x1b[6A\x1b[48;5;237m\x1b[38;5;239m❯ \x1b[38;5;231m/rate-limit-options\x1b[39m` + ' '.repeat(180) +
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

describe('CSI-nG character-drop (2026-10-28 outage, task_1793398908707_34091701)', () => {
  // Byte-for-byte from infra's own stdout.log during the real 47h outage —
  // not a hand-typed guess. The "/rat" ESC[8G "-limi" ESC[14G "-option"
  // ESC[22G shape is the exact cause: each CSI n G jump skips the ONE column
  // immediately before a hyphen (or the string's end) by exactly one more
  // than the text just written occupies, and the character that belonged
  // there (e, t, s) is never transmitted — not whitespace, not reordered,
  // genuinely absent. Confirmed this is the ONLY occurrence of this literal
  // shape in a 35MB/4-day capture spanning the outage; LIMIT_RE's phrase
  // ("weekly limit") never shows the same corruption anywhere in that file.
  const OUTAGE_RAW =
    `\r\x1b[1B\x1b[49m\x1b[38;5;246m  ⎿  \x1b[38;5;211mYou've hit your weekly limit · resets Nov 1 at 2am (UTC)\x1b[39m\x1b[K\r\x1b[1B\x1b[K\r\x1b[1B\x1b[38;5;246m✻\x1b[39m \x1b[38;5;246mChurned for 0s · done 10:22 PM\x1b[39m\x1b[K\r\x1b[1B\x1b[K\r\x1b[1B\x1b[48;5;237m\x1b[38;5;246m❯ \x1b[38;5;231m/rat\x1b[8G-limi\x1b[14G-option\x1b[22G\x1b[39m`;

  // 2026-10-30T22:00:00Z — within the real outage window.
  const OUTAGE_NOW = Date.UTC(2026, 9, 30, 22);

  it('documents the defect: naive stripAnsi alone reads the dialog marker as "/rat-limi-option", which never matches', () => {
    const normalized = stripAnsi(OUTAGE_RAW).replace(/\s+/g, '');
    expect(normalized).toContain('/rat-limi-option');
    expect(normalized).not.toContain('/rate-limit-options');
  });

  it('this is what silently broke rotation for ~47h: scanForLimit on the naively-stripped text returns null despite a real banner', () => {
    expect(scanForLimit(stripAnsi(OUTAGE_RAW), OUTAGE_NOW)).toBeNull();
  });

  it('stripAnsiTrackingCursor backfills exactly the dropped columns, enabling a correct match', () => {
    const cursor = { col: 1 };
    const reconstructed = stripAnsiTrackingCursor(OUTAGE_RAW, cursor);
    const ev = scanForLimit(reconstructed, OUTAGE_NOW);
    expect(ev).not.toBeNull();
    expect(ev!.kind).toBe('weekly');
  });

  it('LimitScanner (the actual live path) fires on the real captured incident bytes', () => {
    const s = new LimitScanner(() => OUTAGE_NOW);
    expect(s.push(OUTAGE_RAW)).not.toBeNull();
  });

  it('control: a forward CSI-nG skip bigger than MAX_GAP_PER_JUMP does not let unrelated text falsely complete the dialog marker', () => {
    // A single huge jump (e.g. a genuinely different CSI use this module
    // doesn't model, such as a full-screen reposition) must not manufacture
    // enough "matches anything" filler to bridge two otherwise-unrelated
    // fragments into a false match.
    const huge = `/rat\x1b[500G-limi-option`;
    const cursor = { col: 1 };
    expect(scanForLimit(stripAnsiTrackingCursor(huge, cursor), OUTAGE_NOW)).toBeNull();
  });

  it('control: existing fixtures with no forward skip still produce zero GAP_CHARs (no behavior change for clean renders)', () => {
    const cursor = { col: 1 };
    const reconstructed = stripAnsiTrackingCursor(SESSION_RAW, cursor);
    expect(reconstructed).toBe(stripAnsi(SESSION_RAW));
  });

  it('still returns null for a prose mention of the corrupted shape — the AND-gate with LIMIT_RE still guards against false-firing', () => {
    const cursor = { col: 1 };
    const quoted = stripAnsiTrackingCursor(
      'the banner showed /rate-limit-options once the bug was fixed, said the retro doc',
      cursor
    );
    expect(scanForLimit(quoted, OUTAGE_NOW)).toBeNull();
  });

  it('carries an escape sequence split across two push() calls instead of leaking its digits as literal text', () => {
    // Confirmed live via node-pty: a real PTY can deliver an SGR code split
    // mid-sequence, e.g. "...\x1b[38;5;2" in one read and "11mHello" in the
    // next. Without carrying the dangling tail over to the next call, the
    // stray "[38;5;2" and "11m" fall through as literal printable
    // characters, each silently inflating the tracked cursor column and
    // throwing off every later CSI-n-G jump's forward/backward judgment.
    const cursor = { col: 1 };
    const part1 = stripAnsiTrackingCursor('\x1b[38;5;2', cursor);
    const part2 = stripAnsiTrackingCursor('11mHello', cursor);
    expect(part1).toBe(''); // held in cursor.pending, not leaked as text
    expect(part2).toBe('Hello');
    expect(cursor.col).toBe(6); // only "Hello" advanced the column, not the escape's digits
  });

  it('live PTY path recovers through a real split exactly like the one above, reproduced from the real outage bytes', () => {
    // The real OUTAGE_RAW banner, sliced at a fixed 37-byte boundary chosen
    // without regard for escape sequences (mirroring how node-pty actually
    // delivered it live — see tests/integration/limit-detector-live-pty.manual.test.ts),
    // which happens to split an SGR code mid-sequence right before the limit
    // phrase. If the carry-over above regressed, this is what would catch it.
    const CHUNK = 37;
    const s = new LimitScanner(() => OUTAGE_NOW);
    let ev = null;
    for (let i = 0; i < OUTAGE_RAW.length; i += CHUNK) {
      ev = s.push(OUTAGE_RAW.slice(i, i + CHUNK)) ?? ev;
    }
    expect(ev).not.toBeNull();
    expect(ev!.kind).toBe('weekly');
  });
});

describe('parseResetHint — date-only hint, stale-match guard (2026-09-21, wyre-max20 real incident)', () => {
  it('wraps a genuine near-term year-boundary hint (Dec 31 -> Jan 2, 2 days out)', () => {
    const dec31 = Date.UTC(2026, 11, 31);
    const at = parseResetHint('resetsJan2at6am(UTC)', dec31);
    expect(at).toBe(Date.UTC(2027, 0, 2, 6));
  });

  it('rejects a stale date-only match that would wrap to ~1 year out (real wyre-max20 shape)', () => {
    // "resets Sep 14 at 3am (UTC)" was wyre-max20's genuine weekly boundary
    // days earlier; matched again on 2026-09-20T02:16:33Z (6 days later,
    // leftover in the rolling window) the old code silently manufactured
    // resetAt=2027-09-14T03:00:00Z — see rotation-manager.ts's exhausted-map
    // write and its year-long candidate-pool exclusion.
    const sixDaysLater = Date.UTC(2026, 8, 20, 2, 16, 33, 430);
    const at = parseResetHint('resetsSep14at3am(UTC)', sixDaysLater);
    expect(at).toBeNull();
  });

  it('still accepts a date-only hint within the year but close enough to be plausible', () => {
    // Same-month, a few days ahead — well within any real weekly/session/usage horizon.
    const now = Date.UTC(2026, 8, 20);
    const at = parseResetHint('resetsSep27at3am(UTC)', now);
    expect(at).toBe(Date.UTC(2026, 8, 27, 3));
  });
});
