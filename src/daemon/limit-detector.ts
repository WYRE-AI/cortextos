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

const LIMIT_RE = /You'vehityour(weekly|session|usage)?limit/gi;
const DIALOG_RE = /Whatdoyouwanttodo\?|\/rate-limit-options/i;
// Markers only the rate-limit dialog renders. "What do you want to do?" alone is
// generic, so it cannot complete a banner that has already left the window.
const RATE_LIMIT_DIALOG_RE = /\/rate-limit-options|Stopandwaitforlimittoreset/i;
const MONTHS = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];
// "resetsJul20at6am(UTC)" | "resets3am(UTC)" | "resets3:30pm(UTC)" — normalized (no spaces)
const RESET_DATE_RE = /resets([A-Za-z]{3})(\d{1,2})at(\d{1,2})(?::(\d{2}))?([ap])m\(UTC\)/i;
const RESET_TIME_RE = /resets(?:at)?(\d{1,2})(?::(\d{2}))?([ap])m\(UTC\)/i;

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

// Uses the LAST banner in the window, with the reset hint that follows it, so a
// newer banner is never reported with an older banner's kind/resetAt.
function detectLimitPhrase(normalized: string, now: number): LimitEvent | null {
  const matches = [...normalized.matchAll(LIMIT_RE)];
  const limit = matches[matches.length - 1];
  if (!limit) return null;
  const kind = (limit[1]?.toLowerCase() ?? 'unknown') as LimitEvent['kind'];
  return {
    kind,
    resetAt: parseResetHint(normalized.slice(limit.index), now),
    matchedText: limit[0],
  };
}

export function scanForLimit(window: string, now: number): LimitEvent | null {
  const normalized = window.replace(/\s+/g, '');
  const match = detectLimitPhrase(normalized, now);
  if (!match || !DIALOG_RE.test(normalized)) return null;
  return match;
}

// How long to keep waiting for the dialog marker after the limit phrase is
// seen, once it has scrolled out of the WINDOW_BYTES rolling window. Bounds
// the fix below: long enough to span realistic PTY redraw/buffering gaps,
// short enough that an unrelated later "What do you want to do?" can't fire
// a stale event off an old banner.
const ARM_TTL_MS = 2 * 60_000;

/**
 * Per-agent stateful wrapper: rolling window over stripped PTY chunks with
 * re-fire suppression (the TUI re-renders the same banner constantly).
 *
 * The limit banner and the dialog marker can arrive in separate push() calls
 * with enough intervening PTY redraw noise between them that the rolling
 * window evicts the banner text before the dialog marker is ever seen
 * alongside it in the same window — `scanForLimit` alone would silently miss
 * that case. Once the limit phrase is seen, remember it ("armed") outside
 * the window so a later window can still complete the match on a
 * rate-limit-specific dialog marker alone, bounded by ARM_TTL_MS.
 */
export class LimitScanner {
  private window = '';
  private suppressedUntil = 0;
  private armed: (LimitEvent & { armedAt: number }) | null = null;
  // Total normalized length of everything pushed so far. The normalized window
  // is always a suffix of the normalized stream, so this gives each banner match
  // a stable stream offset for telling a fresh banner from one already seen.
  private streamLen = 0;
  private lastBannerEnd = -1;
  constructor(private readonly now: () => number = () => Date.now()) {}

  push(chunk: string): LimitEvent | null {
    const stripped = stripAnsi(chunk);
    this.window = (this.window + stripped).slice(-WINDOW_BYTES);
    this.streamLen += stripped.replace(/\s+/g, '').length;
    const t = this.now();
    if (t < this.suppressedUntil) return null;

    if (this.armed && t - this.armed.armedAt > ARM_TTL_MS) {
      this.armed = null; // dialog never came within a plausible render gap
    }

    const normalized = this.window.replace(/\s+/g, '');
    const inWindow = detectLimitPhrase(normalized, t);
    if (inWindow) {
      // A banner ending past the last one seen is a new occurrence (including a
      // re-render of the same limit) and renews the arm; a banner still sitting
      // in the window from an earlier push does not.
      const bannerEnd = this.streamLen - normalized.length +
        normalized.lastIndexOf(inWindow.matchedText) + inWindow.matchedText.length;
      const isNewBanner = bannerEnd > this.lastBannerEnd;
      this.lastBannerEnd = Math.max(this.lastBannerEnd, bannerEnd);
      if (isNewBanner || !this.armed ||
        inWindow.kind !== this.armed.kind ||
        inWindow.resetAt !== this.armed.resetAt) {
        this.armed = { ...inWindow, armedAt: t };
      }
    }
    if (!this.armed) return null;

    // Banner still in the window: same co-occurrence rule as scanForLimit.
    // Banner evicted: only a rate-limit-specific dialog marker completes the
    // match, so a quoted limit phrase followed later by an unrelated
    // "What do you want to do?" cannot trigger a rotation.
    const dialogRe = inWindow ? DIALOG_RE : RATE_LIMIT_DIALOG_RE;
    if (dialogRe.test(normalized)) {
      const { armedAt, ...ev } = this.armed;
      this.armed = null;
      this.suppressedUntil = t + REFIRE_SUPPRESS_MS;
      this.window = '';
      return ev;
    }
    return null;
  }
}
