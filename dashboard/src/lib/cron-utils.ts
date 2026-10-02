/**
 * cron-utils.ts — Pure cron/schedule helpers for the Next.js dashboard.
 *
 * These are intentionally duplicated from src/bus/cron-state.ts so that
 * the dashboard (a Next.js app) does not need to import daemon-side Node.js
 * modules at runtime.  Any changes to the core parsing logic should be
 * reflected here as well.
 */

/**
 * Parse an interval string like "6h", "30m", "1d", "2w" into milliseconds.
 * Returns NaN for unrecognised formats (e.g. cron expressions like "0 8 * * *").
 */
export function parseDurationMs(interval: string): number {
  const match = /^(\d+)(m|h|d|w)$/.exec(interval.trim());
  if (!match) return NaN;
  const n = parseInt(match[1], 10);
  const unit = match[2];
  const multipliers: Record<string, number> = {
    m: 60_000,
    h: 3_600_000,
    d: 86_400_000,
    w: 604_800_000,
  };
  return n * multipliers[unit];
}

/**
 * Format a duration in milliseconds as a human-readable string.
 * e.g. 3600000 => "1h", 86400000 => "1d"
 */
export function formatDuration(ms: number): string {
  if (ms >= 604_800_000 && ms % 604_800_000 === 0) return `${ms / 604_800_000}w`;
  if (ms >= 86_400_000 && ms % 86_400_000 === 0) return `${ms / 86_400_000}d`;
  if (ms >= 3_600_000 && ms % 3_600_000 === 0) return `${ms / 3_600_000}h`;
  if (ms >= 60_000 && ms % 60_000 === 0) return `${ms / 60_000}m`;
  return `${ms}ms`;
}

/**
 * Format a schedule string (interval shorthand or cron expression) as a
 * human-readable label for display in the dashboard.
 *
 * e.g. "6h"         => "every 6 hours"
 *      "30m"        => "every 30 minutes"
 *      "0 9 * * *"  => "0 9 * * *"  (returned as-is — cron exprs are opaque)
 */
export function formatSchedule(schedule: string): string {
  const ms = parseDurationMs(schedule);
  if (!isNaN(ms)) {
    const weeks   = ms / 604_800_000;
    const days    = ms / 86_400_000;
    const hours   = ms / 3_600_000;
    const minutes = ms / 60_000;

    if (ms >= 604_800_000 && ms % 604_800_000 === 0)
      return `every ${weeks} week${weeks !== 1 ? 's' : ''}`;
    if (ms >= 86_400_000 && ms % 86_400_000 === 0)
      return `every ${days} day${days !== 1 ? 's' : ''}`;
    if (ms >= 3_600_000 && ms % 3_600_000 === 0)
      return `every ${hours} hour${hours !== 1 ? 's' : ''}`;
    return `every ${minutes} minute${minutes !== 1 ? 's' : ''}`;
  }
  // Cron expression — return as-is
  return schedule;
}

// ---------------------------------------------------------------------------
// Form / mutation validation helpers — Subtask 4.2
// ---------------------------------------------------------------------------

/** Interval shorthand: digits followed by one of s/m/h/d/w */
const INTERVAL_REGEX = /^\d+(s|m|h|d|w)$/;

/** Minimal 5-field cron expression validator (same logic as ipc-server.ts) */
function isValidCronExpr(s: string): boolean {
  const parts = s.trim().split(/\s+/);
  if (parts.length !== 5) return false;
  // Validate each field against its allowed range
  const ranges: [number, number][] = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 6]];
  for (let i = 0; i < 5; i++) {
    const field = parts[i];
    const [min, max] = ranges[i];
    try {
      expandFieldClient(field, min, max);
    } catch {
      return false;
    }
  }
  return true;
}

function expandFieldClient(field: string, min: number, max: number): void {
  for (const part of field.split(',')) {
    if (part === '*') continue;
    if (part.startsWith('*/')) {
      const step = parseInt(part.slice(2), 10);
      if (isNaN(step) || step <= 0) throw new Error('bad step');
      continue;
    }
    if (part.includes('-')) {
      const [lo, hi] = part.split('-').map(s => parseInt(s, 10));
      if (isNaN(lo) || isNaN(hi) || lo > hi || lo < min || hi > max) throw new Error('bad range');
      continue;
    }
    const n = parseInt(part, 10);
    if (isNaN(n) || n < min || n > max) throw new Error('bad value');
  }
}

/**
 * Validate a schedule string (interval shorthand or 5-field cron expression).
 * Returns true if the schedule is well-formed and can be parsed by the daemon.
 *
 * @example isValidScheduleClient("6h")         // true
 * @example isValidScheduleClient("0 9 * * *")  // true
 * @example isValidScheduleClient("6 hours")    // false
 * @example isValidScheduleClient("abc")        // false
 */
export function isValidScheduleClient(schedule: string): boolean {
  if (!schedule || !schedule.trim()) return false;
  const s = schedule.trim();
  return INTERVAL_REGEX.test(s) || isValidCronExpr(s);
}

/**
 * Validate a cron name string.
 * Must be non-empty with no whitespace (letters, digits, _ and - only).
 */
export function isValidCronName(name: string): boolean {
  return /^[a-zA-Z0-9_-]+$/.test(name) && name.length > 0;
}

/**
 * Format a schedule string as an example label.
 * Used to provide inline hints in the cron form.
 */
export function scheduleExamples(): Array<{ value: string; label: string }> {
  return [
    { value: '6h',          label: 'every 6 hours' },
    { value: '24h',         label: 'every 24 hours (daily)' },
    { value: '30m',         label: 'every 30 minutes' },
    { value: '1d',          label: 'every day' },
    { value: '0 9 * * *',   label: 'daily at 09:00 UTC' },
    { value: '0 13 * * *',  label: 'daily at 13:00 UTC (09:00 ET)' },
    { value: '0 16 * * 1',  label: 'every Monday at 16:00 UTC' },
    { value: '*/15 * * * *', label: 'every 15 minutes' },
  ];
}

/**
 * Format a timestamp as a relative string ("2 hours ago", "in 5 minutes").
 * Falls back to the ISO string if the input is null/undefined/unparseable.
 */
export function formatRelative(isoTs: string | null | undefined): string {
  if (!isoTs || isoTs === 'unknown') return isoTs ?? 'never';
  const now = Date.now();
  const ts = new Date(isoTs).getTime();
  if (isNaN(ts)) return isoTs;

  const diffMs = ts - now;
  const absDiff = Math.abs(diffMs);
  const past = diffMs < 0;

  let label: string;
  if (absDiff < 60_000) {
    label = 'just now';
    return label;
  } else if (absDiff < 3_600_000) {
    const mins = Math.round(absDiff / 60_000);
    label = `${mins} min${mins !== 1 ? 's' : ''}`;
  } else if (absDiff < 86_400_000) {
    const hrs = Math.round(absDiff / 3_600_000);
    label = `${hrs} hr${hrs !== 1 ? 's' : ''}`;
  } else {
    const days = Math.round(absDiff / 86_400_000);
    label = `${days} day${days !== 1 ? 's' : ''}`;
  }

  return past ? `${label} ago` : `in ${label}`;
}

// ---------------------------------------------------------------------------
// 5-field cron expression evaluator
//
// Mirrors src/daemon/cron-scheduler.ts's nextFireFromCron. It lives here rather
// than being imported because the dashboard is a separate Next.js app that
// cannot pull in daemon-side modules — the duplication this file's header
// warns about. It previously existed as TWO inline copies (crons/route.ts and
// health/route.ts), both of which matched cron fields with LOCAL Date getters
// (getHours/getDate/getDay). PR #21 (1e24108d) fixed exactly that bug in the
// daemon — moving evaluation to the cron's `timezone`, default UTC — but only
// on the daemon side.
//
// The result was a live divergence: the daemon fired "0 9 * * *" at 09:00 UTC
// while the dashboard displayed its next fire as 09:00 LOCAL (13:00 UTC on the
// EDT fleet host), a 4-5h lie in the UI, and `cron.timezone` was ignored
// outright. Consolidated to one implementation with the daemon's semantics.
// ---------------------------------------------------------------------------

const DEFAULT_CRON_TIMEZONE = 'UTC';

const WEEKDAY_ABBR_TO_NUM: Record<string, number> = {
  Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
};

interface CronFields { minute: number; hour: number; day: number; month: number; weekday: number }

function expandCronField(field: string, min: number, max: number): number[] {
  const result = new Set<number>();
  for (const part of field.split(',')) {
    if (part === '*') {
      for (let i = min; i <= max; i++) result.add(i);
    } else if (part.startsWith('*/')) {
      const step = parseInt(part.slice(2), 10);
      if (isNaN(step) || step <= 0) throw new Error(`Invalid step: ${part}`);
      for (let i = min; i <= max; i += step) result.add(i);
    } else if (part.includes('-')) {
      const [lo, hi] = part.split('-').map(s => parseInt(s, 10));
      if (isNaN(lo) || isNaN(hi) || lo > hi) throw new Error(`Invalid range: ${part}`);
      for (let i = lo; i <= hi; i++) result.add(i);
    } else {
      const n = parseInt(part, 10);
      if (isNaN(n)) throw new Error(`Invalid value: ${part}`);
      result.add(n);
    }
  }
  return [...result].sort((a, b) => a - b);
}

/**
 * UTC fast path — native getters instead of Intl. Semantically identical (UTC
 * has no DST) but measured ~27x cheaper across the minute-by-minute scan below,
 * which is what made the dashboard's /crons endpoint the slowest route it
 * serves. UTC is the default, so this is the path nearly every cron takes.
 */
function utcCronFields(ms: number): CronFields {
  const d = new Date(ms);
  return {
    minute: d.getUTCMinutes(),
    hour: d.getUTCHours(),
    day: d.getUTCDate(),
    month: d.getUTCMonth() + 1, // getUTCMonth is 0-11; cron months are 1-12
    weekday: d.getUTCDay(),
  };
}

/**
 * Next fire time (epoch ms) for a 5-field cron expression, strictly after
 * `fromMs`, or NaN if the expression is unparseable or can never match.
 *
 * @param timezone IANA zone the expression's fields are evaluated in.
 *                 Defaults to UTC — never the ambient timezone of whatever
 *                 process renders the dashboard.
 */
export function nextFireFromCronExpr(
  expr: string,
  fromMs: number,
  timezone: string = DEFAULT_CRON_TIMEZONE,
): number {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return NaN;
  const [minuteStr, hourStr, domStr, monthStr, dowStr] = parts;

  let minutes: number[], hours: number[], doms: number[], months: number[], dows: number[];
  try {
    minutes = expandCronField(minuteStr, 0, 59);
    hours   = expandCronField(hourStr,   0, 23);
    doms    = expandCronField(domStr,    1, 31);
    months  = expandCronField(monthStr,  1, 12);
    dows    = expandCronField(dowStr,    0, 6);
  } catch {
    return NaN;
  }

  // Feasibility pre-check: a dom+month pair that exists in NO month (Feb 31)
  // parses fine but can never match, and would otherwise walk the entire
  // 1-year window just to return NaN. Feb counts as 29 — "29 2" is feasible in
  // leap years, and whether the next one is inside the window is the scan's
  // question, not this check's.
  const MAX_DOM_BY_MONTH = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (!months.some((mo) => doms.some((d) => d <= MAX_DOM_BY_MONTH[mo - 1]))) {
    return NaN;
  }

  let fieldsAt: (ms: number) => CronFields;
  if (timezone === DEFAULT_CRON_TIMEZONE) {
    fieldsAt = utcCronFields;
  } else {
    let formatter: Intl.DateTimeFormat;
    try {
      formatter = new Intl.DateTimeFormat('en-US', {
        timeZone: timezone,
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit',
        hourCycle: 'h23', weekday: 'short',
      });
    } catch {
      return NaN; // invalid IANA string fails safe, as on the daemon side
    }
    fieldsAt = (ms) => {
      const map: Record<string, string> = {};
      for (const p of formatter.formatToParts(new Date(ms))) map[p.type] = p.value;
      return {
        minute: parseInt(map.minute, 10),
        hour: parseInt(map.hour, 10),
        day: parseInt(map.day, 10),
        month: parseInt(map.month, 10),
        weekday: WEEKDAY_ABBR_TO_NUM[map.weekday],
      };
    };
  }

  let candidate = Math.floor(fromMs / 60_000) * 60_000 + 60_000;
  const MAX_MINUTES = 366 * 24 * 60;
  for (let i = 0; i < MAX_MINUTES; i++) {
    const f = fieldsAt(candidate);
    if (
      months.includes(f.month) &&
      doms.includes(f.day) &&
      dows.includes(f.weekday) &&
      hours.includes(f.hour) &&
      minutes.includes(f.minute)
    ) {
      return candidate;
    }
    candidate += 60_000;
  }
  return NaN;
}
