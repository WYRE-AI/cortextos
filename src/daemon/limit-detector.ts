// src/daemon/limit-detector.ts
// Pure rate-limit banner detection for Claude Code PTY streams.
//
// The stream interleaves cursor-positioning CSI sequences BETWEEN words, so
// stripped text may read "Whatdoyouwanttodo?". All matching therefore runs on a
// whitespace-REMOVED normalization of the window. An event requires BOTH the
// limit phrase and the blocking-dialog marker in the same window — an agent
// merely quoting a limit message in prose never renders the dialog.
//
// A DIFFERENT and more severe form of the same cursor-positioning behavior
// can drop actual characters, not just whitespace: real capture from the
// 2026-10-28 outage shows the TUI rendering the dialog hint as
// `/rat` ESC[8G `-limi` ESC[14G `-option` ESC[22G` — each CSI n G (Cursor
// Horizontal Absolute) jump skips exactly one column ahead of where the
// previous write ended, and the character that belonged there (e, t, s) is
// never transmitted at all, not merely moved or whitespace-padded. A naive
// strip-and-concatenate reads "/rat-limi-option", which the dialog marker
// regex can never match — this silently broke weekly-limit rotation for
// ~47h (task_1793398908707_34091701). See stripAnsiTrackingCursor below.

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

// Reserved sentinel marking a character the TUI's own cursor-positioning
// jumped over without ever transmitting (see stripAnsiTrackingCursor). U+FFF9
// INTERLINEAR ANNOTATION ANCHOR never appears in real PTY output, so its
// presence in the window unambiguously means "a column was skipped here."
const GAP_CHAR = '￹';
// Per-jump cap on how many GAP_CHAR placeholders a single forward skip may
// produce. Every confirmed real instance skips exactly one column; this
// exists only so a misread of an unrelated large cursor jump (e.g. a
// different CSI sequence this module doesn't model) can't manufacture a long
// "matches anything" run and widen the dialog-marker match beyond what the
// AND-gate's anti-false-positive design intends.
const MAX_GAP_PER_JUMP = 4;

// CSI n G — Cursor Horizontal Absolute (1-indexed column; `\x1b[G` means
// column 1). Pulled out of ANSI_RE's general CSI branch (as capture group 1)
// so it can be tracked instead of just discarded; listed first since every
// CSI-G also matches the general branch.
const CURSOR_TOKEN_RE =
  /\x1b\[(\d*)G|\x1b\[[0-9;?]*[a-zA-Z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?|\x1b[()][A-Z0-9]|\x1b[<>=]?|\r|\n|[^\x1b\r\n]+/g;

// A PTY read can split an escape sequence across two chunks — confirmed live
// via node-pty: an SGR code landed as "...\x1b[38;5;2" in one chunk and
// "11mYou've hit..." in the next. Without carrying the dangling tail over,
// the lone-ESC branch above strips just the ESC byte and the remaining
// digits ("[38;5;2", then "11m") fall through as literal printable text —
// extra characters that corrupt column tracking for everything after them.
// Matches a trailing escape opener with no terminator yet within the given
// string: a bare ESC, a CSI opener with only param bytes so far (no final
// letter), an OSC opener with no BEL/ST yet, or a charset-select opener with
// no following byte.
const INCOMPLETE_TAIL_RE = /\x1b(?:\[[0-9;?]*|\][^\x07\x1b]*|[()])?$/;
// Give up waiting and flush as literal text past this length — real escape
// sequences (even OSC window-title ones) are short; this only guards against
// a pathological stream whose terminator never arrives.
const MAX_PENDING_TAIL = 256;

/**
 * Same net effect as stripAnsi (all escape sequences removed), but tracks the
 * cursor's horizontal column across CSI n G jumps and backfills any forward
 * skip with GAP_CHAR placeholders — one per skipped column, capped at
 * MAX_GAP_PER_JUMP — instead of silently closing the gap the way naive
 * strip-and-concatenate does. `cursor` is caller-owned state so it persists
 * across chunks exactly like a real terminal's cursor does; `\r`/`\n` reset
 * it to column 1. `cursor.pending` carries a trailing incomplete escape
 * sequence over to the next call — see INCOMPLETE_TAIL_RE above.
 *
 * This cannot recover the dropped character's identity — it was never sent,
 * by construction (confirmed byte-for-byte against a real capture, see
 * limit-detector.test.ts) — only mark exactly where and how many characters
 * are missing. dialogMatches() below is the matching side: it treats
 * GAP_CHAR as "unknown character, assume it matches" at that one spot,
 * rather than loosening matching everywhere, which would risk false-firing
 * on unrelated prose the way a blanket fuzzy regex would.
 */
export function stripAnsiTrackingCursor(s: string, cursor: { col: number; pending?: string }): string {
  if (cursor.pending) {
    s = cursor.pending + s;
    cursor.pending = '';
  }
  const tail = INCOMPLETE_TAIL_RE.exec(s);
  if (tail && s.length - tail.index <= MAX_PENDING_TAIL) {
    cursor.pending = s.slice(tail.index);
    s = s.slice(0, tail.index);
  }

  let out = '';
  CURSOR_TOKEN_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = CURSOR_TOKEN_RE.exec(s)) !== null) {
    const token = m[0];
    if (m[1] !== undefined) {
      // CSI n G branch — m[1] is the digit string ('' means column 1).
      const target = m[1] === '' ? 1 : parseInt(m[1], 10);
      if (target > cursor.col) {
        out += GAP_CHAR.repeat(Math.min(target - cursor.col, MAX_GAP_PER_JUMP));
      }
      cursor.col = target;
    } else if (token === '\r' || token === '\n') {
      out += token;
      cursor.col = 1;
    } else if (token.charCodeAt(0) === 0x1b) {
      // Some other escape sequence (SGR, OSC, lone ESC final) — stripped,
      // no column effect; this module doesn't model what it does on screen.
    } else {
      out += token;
      cursor.col += token.length;
    }
  }
  return out;
}

const LIMIT_RE = /You'vehityour(weekly|session|usage)?limit/i;

// Inside a character class, only these need escaping, and only `-` is
// order-sensitive (it would otherwise start a range) — placing it first in
// the class sidesteps that without needing to escape it at all.
function escapeCharClassChar(ch: string): string {
  return ch === '\\' || ch === ']' || ch === '^' ? '\\' + ch : ch;
}

/**
 * Builds a regex matching `literal` where each character may instead be a
 * GAP_CHAR standing in for it (a skipped column dropped exactly that
 * character), with a run of zero or more EXTRA GAP_CHARs also tolerated
 * between characters (a skipped column can land on whitespace the normal
 * whitespace-strip would have removed anyway, e.g. the space in "What do" —
 * that can produce more consecutive GAP_CHARs than there are literal
 * characters to stand in for). Degrades to an exact literal match when no
 * GAP_CHAR is present, so this is a strict superset of the old plain-literal
 * DIALOG_RE — safe to use unconditionally.
 */
function gapTolerantPattern(literal: string): RegExp {
  const gapStar = `${GAP_CHAR}*`;
  const body =
    gapStar + [...literal].map((ch) => `[${escapeCharClassChar(ch)}${GAP_CHAR}]${gapStar}`).join('');
  return new RegExp(body, 'i');
}

const DIALOG_PATTERNS = [gapTolerantPattern('whatdoyouwanttodo?'), gapTolerantPattern('/rate-limit-options')];

/** Gap-tolerant replacement for the old literal DIALOG_RE — see stripAnsiTrackingCursor. */
function dialogMatches(normalized: string): boolean {
  return DIALOG_PATTERNS.some((re) => re.test(normalized));
}

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
  if (!limit || !dialogMatches(normalized)) return null;
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
  // Persists across chunks like a real terminal's cursor does — a forward
  // skip detected in one push() can be the continuation of a write that
  // started in a previous one.
  private cursor = { col: 1 };
  constructor(private readonly now: () => number = () => Date.now()) {}

  push(chunk: string): LimitEvent | null {
    this.window = (this.window + stripAnsiTrackingCursor(chunk, this.cursor)).slice(-WINDOW_BYTES);
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
