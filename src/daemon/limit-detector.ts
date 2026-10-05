// src/daemon/limit-detector.ts
// Pure rate-limit banner detection for Claude Code PTY streams.
//
// The stream interleaves cursor-positioning CSI sequences BETWEEN words, so
// stripped text may read "Whatdoyouwanttodo?". All matching therefore runs on a
// whitespace-REMOVED normalization of the window. An event requires BOTH the
// limit phrase and the blocking-dialog marker in the same window — an agent
// merely quoting a limit message in prose never renders the dialog.

export interface LimitEvent {
  kind: 'weekly' | 'session' | 'usage' | 'unknown';
  resetAt: number | null; // epoch ms; null when unparseable or non-UTC
  matchedText: string;
}

const WINDOW_BYTES = 4096;
const REFIRE_SUPPRESS_MS = 5 * 60_000;

// CSI (incl. private modes), OSC (BEL- or ST-terminated), and lone ESC finals.
const ANSI_RE = /\x1b\[[0-9;?]*[a-zA-Z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?|\x1b[()][A-Z0-9]|\x1b[<>=]?/g;

export function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, '');
}

const LIMIT_RE = /You'vehityour(weekly|session|usage)?limit/i;
const DIALOG_RE = /Whatdoyouwanttodo\?|\/rate-limit-options/i;
const MONTHS = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];
// "resetsJul20at6am(UTC)" | "resets3am(UTC)" | "resets3:30pm(UTC)" — normalized (no spaces)
const RESET_DATE_RE = /resets([A-Za-z]{3})(\d{1,2})at(\d{1,2})(?::(\d{2}))?([ap])m\(UTC\)/i;
const RESET_TIME_RE = /resets(?:at)?(\d{1,2})(?::(\d{2}))?([ap])m\(UTC\)/i;

// A date-only hint (month+day, no year) is meant to cover a genuine
// year-boundary rollover — e.g. matched on Dec 31 with "resets Jan 2" should
// resolve to next year, only two days out. It is NOT meant to paper over a
// STALE match: the LimitScanner's window is a rolling, only-cleared-on-fire
// buffer, so old banner text can still be sitting in it well after the date
// it named has passed. A match that's still implausibly far out even after
// the year-boundary wrap (weekly/session/usage resets are never more than a
// couple of weeks away) is far more likely stale scrollback than a real
// forward-looking hint — trust the wrap only within a generous cap, and
// otherwise fall back to "unparseable" so the caller's own safe fallback
// (RETRY_FALLBACK_MS) applies instead of a bogus ~year-long exclusion.
// Real incident: wyre-max20 observed 2026-09-20T02:16:33Z parsed a leftover
// "resets Sep 14 at 3am (UTC)" match (its own genuine boundary six days
// earlier) into resetAt=2027-09-14T03:00:00Z, silently excluding the
// account from rotation for the better part of a year.
const MAX_HINT_HORIZON_MS = 21 * 24 * 3600_000; // 21 days

function toHour24(h: number, meridiem: string): number {
  const base = h % 12;
  return meridiem.toLowerCase() === 'p' ? base + 12 : base;
}

export function parseResetHint(normalized: string, now: number): number | null {
  const d = RESET_DATE_RE.exec(normalized);
  if (d) {
    const month = MONTHS.indexOf(d[1].toLowerCase());
    if (month === -1) return null;
    const hour = toHour24(parseInt(d[3], 10), d[5]);
    const min = d[4] ? parseInt(d[4], 10) : 0;
    const year = new Date(now).getUTCFullYear();
    let at = Date.UTC(year, month, parseInt(d[2], 10), hour, min);
    if (at < now) at = Date.UTC(year + 1, month, parseInt(d[2], 10), hour, min);
    if (at - now > MAX_HINT_HORIZON_MS) return null;
    return at;
  }
  const t = RESET_TIME_RE.exec(normalized);
  if (t) {
    const hour = toHour24(parseInt(t[1], 10), t[3]);
    const min = t[2] ? parseInt(t[2], 10) : 0;
    const nd = new Date(now);
    let at = Date.UTC(nd.getUTCFullYear(), nd.getUTCMonth(), nd.getUTCDate(), hour, min);
    if (at <= now) at += 24 * 3600_000;
    return at;
  }
  return null;
}

export function scanForLimit(window: string, now: number): LimitEvent | null {
  const normalized = window.replace(/\s+/g, '');
  const limit = LIMIT_RE.exec(normalized);
  if (!limit || !DIALOG_RE.test(normalized)) return null;
  const kind = (limit[1]?.toLowerCase() ?? 'unknown') as LimitEvent['kind'];
  return {
    kind,
    resetAt: parseResetHint(normalized, now),
    matchedText: limit[0],
  };
}

/**
 * Per-agent stateful wrapper: rolling window over stripped PTY chunks with
 * re-fire suppression (the TUI re-renders the same banner constantly).
 */
export class LimitScanner {
  private window = '';
  private suppressedUntil = 0;
  constructor(private readonly now: () => number = () => Date.now()) {}

  push(chunk: string): LimitEvent | null {
    this.window = (this.window + stripAnsi(chunk)).slice(-WINDOW_BYTES);
    const t = this.now();
    if (t < this.suppressedUntil) return null;
    const ev = scanForLimit(this.window, t);
    if (ev) {
      this.suppressedUntil = t + REFIRE_SUPPRESS_MS;
      this.window = '';
    }
    return ev;
  }
}
