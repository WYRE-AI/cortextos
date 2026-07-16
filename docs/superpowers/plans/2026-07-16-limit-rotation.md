# Limit Detection + OAuth Auto-Rotation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The daemon detects rate-limit-blocked Claude sessions in the PTY stream, suppresses hang-restarts for them, auto-rotates the fleet to a healthy OAuth account, and restarts only the blocked agents.

**Architecture:** A pure detector (`limit-detector.ts`) scans a per-agent rolling window of ANSI-stripped PTY output. Events feed a single `RotationManager` (dependency-injected: clock, preflight, restart, alert) that owns `state/oauth/rotation-state.json`, rotates via helpers in `bus/oauth.ts`, and runs a 60s tick for halted-retry + 30-min proactive preflight. `FastChecker` consults a file-read helper to suppress hang-restarts for limit-blocked agents.

**Tech Stack:** TypeScript (ESM, `.js` import suffixes), Node 20, vitest, tsup. No new dependencies.

## Global Constraints

- Import paths use `.js` suffixes (ESM build via tsup), e.g. `from './limit-detector.js'`.
- Injected `now: number` (epoch ms) everywhere time matters — follow `hang-detector.ts`'s pattern. No bare `Date.now()` inside pure logic.
- Atomic state writes via `atomicWriteSync` from `../utils/atomic.js`, chmod 0o600 (pattern: `bus/oauth.ts` `saveAccounts`).
- Detector matching is whitespace-insensitive: PTY cursor-positioning escapes sit between words, so stripped text can read `Whatdoyouwanttodo?`. Normalize by removing ALL whitespace before matching.
- Constants: `ROTATION_COOLDOWN_MS = 10*60_000`, `PREFLIGHT_INTERVAL_MS = 30*60_000`, `RETRY_FALLBACK_MS = 30*60_000`, `REFIRE_SUPPRESS_MS = 5*60_000`, `WINDOW_BYTES = 4096`.
- Only parse `(UTC)` reset hints; any other timezone → `resetAt: null` (fallback retry covers it).
- Run tests with `npx vitest run <file>`.

---

### Task 1: Limit detector (pure) + LimitScanner

**Files:**
- Create: `src/daemon/limit-detector.ts`
- Test: `tests/unit/limit-detector.test.ts`

**Interfaces:**
- Produces: `stripAnsi(s: string): string`; `scanForLimit(window: string, now: number): LimitEvent | null` with `LimitEvent = { kind: 'weekly'|'session'|'usage'|'unknown'; resetAt: number|null; matchedText: string }`; `class LimitScanner { constructor(now?: () => number); push(chunk: string): LimitEvent | null }` (rolling 4 KB window + 5-min re-fire suppression).
- Consumes: nothing.

- [ ] **Step 1: Write the failing tests**

```typescript
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/unit/limit-detector.test.ts`
Expected: FAIL — cannot resolve `src/daemon/limit-detector.js`.

- [ ] **Step 3: Implement**

```typescript
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/unit/limit-detector.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
git add src/daemon/limit-detector.ts tests/unit/limit-detector.test.ts
git commit -m "feat(daemon): pure rate-limit banner detector for PTY streams"
```

---

### Task 2: oauth.ts helpers — `setActiveAccount` + export `writeTokenToAgents`

**Files:**
- Modify: `src/bus/oauth.ts` (add export near `rotateOAuth`; change `function writeTokenToAgents` to `export function writeTokenToAgents`)
- Test: `tests/unit/oauth-set-active.test.ts`

**Interfaces:**
- Produces: `setActiveAccount(ctxRoot: string, name: string, logEntry: { reason: string; from: string }): void` — flips `active`, prepends a `RotationLogEntry` (timestamp from `new Date().toISOString()`, utilization fields copied from the outgoing account), saves atomically. Throws if `name` missing. Also: `writeTokenToAgents(frameworkRoot, org, token, targetAgent?)` becomes importable.
- Consumes: existing `loadAccounts`, private `saveAccounts`, `ROTATION_LOG_MAX` in the same module.

- [ ] **Step 1: Write the failing test**

```typescript
// tests/unit/oauth-set-active.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { setActiveAccount, loadAccounts } from '../../src/bus/oauth.js';

function seed(ctxRoot: string) {
  mkdirSync(join(ctxRoot, 'state', 'oauth'), { recursive: true });
  writeFileSync(join(ctxRoot, 'state', 'oauth', 'accounts.json'), JSON.stringify({
    active: 'a',
    accounts: {
      a: { label: 'A', access_token: 'tok-a', refresh_token: '', expires_at: 9e15, last_refreshed: '', five_hour_utilization: 0.9, seven_day_utilization: 0.1 },
      b: { label: 'B', access_token: 'tok-b', refresh_token: '', expires_at: 9e15, last_refreshed: '', five_hour_utilization: 0, seven_day_utilization: 0 },
    },
    rotation_log: [],
  }));
}

describe('setActiveAccount', () => {
  let ctxRoot: string;
  beforeEach(() => { ctxRoot = mkdtempSync(join(tmpdir(), 'ctx-')); seed(ctxRoot); });

  it('flips active and prepends a rotation log entry', () => {
    setActiveAccount(ctxRoot, 'b', { reason: 'limit hit', from: 'a' });
    const store = loadAccounts(ctxRoot)!;
    expect(store.active).toBe('b');
    expect(store.rotation_log[0]).toMatchObject({ from: 'a', to: 'b', reason: 'limit hit', five_hour_util: 0.9 });
  });

  it('throws for an unknown account', () => {
    expect(() => setActiveAccount(ctxRoot, 'nope', { reason: 'x', from: 'a' })).toThrow(/not found/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/oauth-set-active.test.ts`
Expected: FAIL — `setActiveAccount` is not exported.

- [ ] **Step 3: Implement** (append near the bottom of `src/bus/oauth.ts`; also change `function writeTokenToAgents(` to `export function writeTokenToAgents(`)

```typescript
/**
 * Flip the active account and record the rotation, WITHOUT any preflight.
 * Used by the daemon's rotation manager, whose preflight is an inference ping
 * (the usage API rejects setup-tokens — no user:profile scope).
 */
export function setActiveAccount(
  ctxRoot: string,
  name: string,
  logEntry: { reason: string; from: string },
): void {
  const store = loadAccounts(ctxRoot);
  if (!store) throw new Error('No accounts.json found');
  if (!store.accounts[name]) throw new Error(`Account "${name}" not found in accounts.json`);
  const from = store.accounts[logEntry.from];
  store.active = name;
  store.rotation_log = [{
    timestamp: new Date().toISOString(),
    from: logEntry.from,
    to: name,
    reason: logEntry.reason,
    five_hour_util: from?.five_hour_utilization ?? 0,
    seven_day_util: from?.seven_day_utilization ?? 0,
  }, ...store.rotation_log].slice(0, ROTATION_LOG_MAX);
  saveAccounts(ctxRoot, store);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/oauth-set-active.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/bus/oauth.ts tests/unit/oauth-set-active.test.ts
git commit -m "feat(oauth): setActiveAccount helper + export writeTokenToAgents for daemon rotation"
```

---

### Task 3: RotationManager core

**Files:**
- Create: `src/daemon/rotation-manager.ts`
- Test: `tests/unit/rotation-manager.test.ts`

**Interfaces:**
- Consumes: `LimitEvent` from `./limit-detector.js`; `loadAccounts`, `setActiveAccount`, `writeTokenToAgents` from `../bus/oauth.js`.
- Produces:
  - `type PreflightResult = 'ok' | 'limit' | 'error'`
  - `interface RotationDeps { ctxRoot: string; frameworkRoot: string; org: string; now?: () => number; preflight: (accessToken: string) => Promise<PreflightResult>; restartAgent: (name: string) => Promise<void>; sendAlert: (text: string) => void; log: (msg: string) => void }`
  - `class RotationManager { constructor(deps: RotationDeps); onLimitEvent(agent: string, ev: LimitEvent): Promise<void>; tick(): Promise<void>; start(): void; stop(): void }`
  - `isLimitBlocked(ctxRoot: string, agent: string): boolean` (pure file read; used by FastChecker)
  - State file `state/oauth/rotation-state.json`: `{ limitBlocked: Record<string,{detectedAt:number;kind:string;resetAt:number|null}>; exhausted: Record<string, number>; lastRotationAt: number; retryAt: number|null; lastPreflightAt: number; alertedHalt: boolean }`

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/unit/rotation-manager.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { RotationManager, isLimitBlocked } from '../../src/daemon/rotation-manager.js';
import type { LimitEvent } from '../../src/daemon/limit-detector.js';

const EV: LimitEvent = { kind: 'session', resetAt: null, matchedText: "You'vehityoursessionlimit" };
const EV_WITH_RESET: LimitEvent = { ...EV, resetAt: Date.UTC(2026, 6, 16, 3) };
const T0 = Date.UTC(2026, 6, 16, 1);

function seedAccounts(ctxRoot: string) {
  mkdirSync(join(ctxRoot, 'state', 'oauth'), { recursive: true });
  writeFileSync(join(ctxRoot, 'state', 'oauth', 'accounts.json'), JSON.stringify({
    active: 'a',
    accounts: {
      a: { label: 'A', access_token: 'tok-a', refresh_token: '', expires_at: 9e15, last_refreshed: '', five_hour_utilization: 0, seven_day_utilization: 0 },
      b: { label: 'B', access_token: 'tok-b', refresh_token: '', expires_at: 9e15, last_refreshed: '', five_hour_utilization: 0, seven_day_utilization: 0 },
      c: { label: 'C', access_token: 'tok-c', refresh_token: '', expires_at: 9e15, last_refreshed: '', five_hour_utilization: 0, seven_day_utilization: 0 },
    },
    rotation_log: [],
  }));
}

function makeAgentEnvs(frameworkRoot: string, org: string, agents: string[]) {
  for (const a of agents) {
    mkdirSync(join(frameworkRoot, 'orgs', org, 'agents', a), { recursive: true });
    writeFileSync(join(frameworkRoot, 'orgs', org, 'agents', a, '.env'), 'CLAUDE_CODE_OAUTH_TOKEN=tok-a\n');
  }
}

describe('RotationManager', () => {
  let ctxRoot: string, frameworkRoot: string;
  let t: number;
  let preflight: ReturnType<typeof vi.fn>;
  let restartAgent: ReturnType<typeof vi.fn>;
  let sendAlert: ReturnType<typeof vi.fn>;
  let rm: RotationManager;

  beforeEach(() => {
    ctxRoot = mkdtempSync(join(tmpdir(), 'ctx-'));
    frameworkRoot = mkdtempSync(join(tmpdir(), 'fw-'));
    seedAccounts(ctxRoot);
    makeAgentEnvs(frameworkRoot, 'wyre', ['boss', 'dev']);
    t = T0;
    preflight = vi.fn().mockResolvedValue('ok');
    restartAgent = vi.fn().mockResolvedValue(undefined);
    sendAlert = vi.fn();
    rm = new RotationManager({
      ctxRoot, frameworkRoot, org: 'wyre', now: () => t,
      preflight, restartAgent, sendAlert, log: () => {},
    });
  });

  it('rotates to the first passing candidate and restarts only blocked agents', async () => {
    await rm.onLimitEvent('boss', EV);
    expect(preflight).toHaveBeenCalledWith('tok-b');
    const accounts = JSON.parse(readFileSync(join(ctxRoot, 'state/oauth/accounts.json'), 'utf-8'));
    expect(accounts.active).toBe('b');
    expect(restartAgent).toHaveBeenCalledTimes(1);
    expect(restartAgent).toHaveBeenCalledWith('boss');
    // token written to ALL agent .envs (existing writeTokenToAgents behavior)
    expect(readFileSync(join(frameworkRoot, 'orgs/wyre/agents/dev/.env'), 'utf-8')).toContain('tok-b');
    expect(sendAlert).toHaveBeenCalledTimes(1);
    expect(isLimitBlocked(ctxRoot, 'boss')).toBe(false); // cleared after restart
  });

  it('marks agent blocked but skips rotation during cooldown; next tick picks it up', async () => {
    await rm.onLimitEvent('boss', EV);           // rotation 1 (t = T0)
    restartAgent.mockClear(); preflight.mockClear();
    t += 60_000;                                  // 1 min later — inside 10-min cooldown
    await rm.onLimitEvent('dev', EV);
    expect(preflight).not.toHaveBeenCalled();
    expect(isLimitBlocked(ctxRoot, 'dev')).toBe(true);
    t += 10 * 60_000;                             // past cooldown
    await rm.tick();
    expect(restartAgent).toHaveBeenCalledWith('dev');
    expect(isLimitBlocked(ctxRoot, 'dev')).toBe(false);
  });

  it('skips exhausted candidates and rotates to the next one', async () => {
    preflight.mockImplementation(async (tok: string) => (tok === 'tok-b' ? 'limit' : 'ok'));
    await rm.onLimitEvent('boss', EV);
    const accounts = JSON.parse(readFileSync(join(ctxRoot, 'state/oauth/accounts.json'), 'utf-8'));
    expect(accounts.active).toBe('c');
  });

  it('halts with single alert + retryAt when every candidate fails preflight', async () => {
    preflight.mockResolvedValue('limit');
    await rm.onLimitEvent('boss', EV_WITH_RESET);
    expect(restartAgent).not.toHaveBeenCalled();
    expect(sendAlert).toHaveBeenCalledTimes(1);
    const state = JSON.parse(readFileSync(join(ctxRoot, 'state/oauth/rotation-state.json'), 'utf-8'));
    // retryAt = min known reset + 5 min. Candidates b/c carry synthetic t+30m
    // fallback expiries, earlier than the real 3am hint — min wins.
    expect(state.retryAt).toBe(t + 35 * 60_000);
    expect(isLimitBlocked(ctxRoot, 'boss')).toBe(true);
    // second event while halted: no second alert
    await rm.onLimitEvent('dev', EV);
    expect(sendAlert).toHaveBeenCalledTimes(1);
  });

  it('falls back to synthetic-expiry retryAt when no reset hint is known', async () => {
    preflight.mockResolvedValue('limit');
    await rm.onLimitEvent('boss', EV);
    const state = JSON.parse(readFileSync(join(ctxRoot, 'state/oauth/rotation-state.json'), 'utf-8'));
    expect(state.retryAt).toBe(t + 35 * 60_000); // min synthetic expiry (t+30m) + 5m
  });

  it('tick() retries rotation after retryAt and recovers', async () => {
    preflight.mockResolvedValue('limit');
    await rm.onLimitEvent('boss', EV);
    preflight.mockResolvedValue('ok');
    t += 36 * 60_000; // past retryAt (t+35m)
    await rm.tick();
    expect(restartAgent).toHaveBeenCalledWith('boss');
    expect(isLimitBlocked(ctxRoot, 'boss')).toBe(false);
  });

  it('restarts blocked agents on the ACTIVE account when it recovered and bench is dry', async () => {
    // bench (b, c) permanently dry; active (a) recovers after its window resets
    preflight.mockImplementation(async (tok: string) => (tok === 'tok-a' ? 'ok' : 'limit'));
    await rm.onLimitEvent('boss', EV);          // banner = fresh proof; active NOT re-pinged
    expect(preflight).not.toHaveBeenCalledWith('tok-a');
    expect(isLimitBlocked(ctxRoot, 'boss')).toBe(true);
    t += 36 * 60_000;                            // past retryAt AND active's synthetic expiry
    await rm.tick();
    expect(preflight).toHaveBeenCalledWith('tok-a');
    expect(restartAgent).toHaveBeenCalledWith('boss');
    expect(isLimitBlocked(ctxRoot, 'boss')).toBe(false);
    const accounts = JSON.parse(readFileSync(join(ctxRoot, 'state/oauth/accounts.json'), 'utf-8'));
    expect(accounts.active).toBe('a');           // no flip — recovered in place
  });

  it('proactive preflight rotates when the ACTIVE account hits its limit', async () => {
    preflight.mockImplementation(async (tok: string) => (tok === 'tok-a' ? 'limit' : 'ok'));
    t += 30 * 60_000 + 1;                          // preflight interval elapsed
    await rm.tick();
    const accounts = JSON.parse(readFileSync(join(ctxRoot, 'state/oauth/accounts.json'), 'utf-8'));
    expect(accounts.active).toBe('b');
    expect(restartAgent).not.toHaveBeenCalled();   // nobody blocked → empty restart set
  });

  it('proactive preflight leaves a healthy active account alone', async () => {
    t += 30 * 60_000 + 1;
    await rm.tick();
    expect(preflight).toHaveBeenCalledTimes(1);    // only the active-account ping
    const accounts = JSON.parse(readFileSync(join(ctxRoot, 'state/oauth/accounts.json'), 'utf-8'));
    expect(accounts.active).toBe('a');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/unit/rotation-manager.test.ts`
Expected: FAIL — cannot resolve `src/daemon/rotation-manager.js`.

- [ ] **Step 3: Implement**

```typescript
// src/daemon/rotation-manager.ts
// Daemon-side OAuth rotation orchestrator (spec: docs/superpowers/specs/
// 2026-07-16-limit-rotation-design.md). Reacts to LimitEvents from PTY
// scanners, proactively preflights the active account, owns
// state/oauth/rotation-state.json. Preflight is an inference ping — the usage
// API 403s on setup-tokens (no user:profile scope).

import { existsSync, readFileSync, chmodSync } from 'fs';
import { join } from 'path';
import { atomicWriteSync, ensureDir } from '../utils/atomic.js';
import { loadAccounts, setActiveAccount, writeTokenToAgents } from '../bus/oauth.js';
import type { LimitEvent } from './limit-detector.js';

export type PreflightResult = 'ok' | 'limit' | 'error';

export interface RotationDeps {
  ctxRoot: string;
  frameworkRoot: string;
  org: string;
  now?: () => number;
  preflight: (accessToken: string) => Promise<PreflightResult>;
  restartAgent: (name: string) => Promise<void>;
  sendAlert: (text: string) => void;
  log: (msg: string) => void;
}

interface RotationState {
  limitBlocked: Record<string, { detectedAt: number; kind: string; resetAt: number | null }>;
  exhausted: Record<string, number>; // account name -> known resetAt (epoch ms)
  lastRotationAt: number;
  retryAt: number | null;
  lastPreflightAt: number;
  alertedHalt: boolean;
}

const ROTATION_COOLDOWN_MS = 10 * 60_000;
const PREFLIGHT_INTERVAL_MS = 30 * 60_000;
const RETRY_FALLBACK_MS = 30 * 60_000;
const TICK_MS = 60_000;

const EMPTY_STATE: RotationState = {
  limitBlocked: {}, exhausted: {}, lastRotationAt: 0,
  retryAt: null, lastPreflightAt: 0, alertedHalt: false,
};

function statePath(ctxRoot: string): string {
  return join(ctxRoot, 'state', 'oauth', 'rotation-state.json');
}

function loadState(ctxRoot: string): RotationState {
  try {
    if (!existsSync(statePath(ctxRoot))) return { ...EMPTY_STATE, limitBlocked: {}, exhausted: {} };
    return { ...EMPTY_STATE, ...JSON.parse(readFileSync(statePath(ctxRoot), 'utf-8')) };
  } catch {
    return { ...EMPTY_STATE, limitBlocked: {}, exhausted: {} };
  }
}

/** FastChecker consult: is this agent's recovery owned by the rotation manager? */
export function isLimitBlocked(ctxRoot: string, agent: string): boolean {
  return agent in loadState(ctxRoot).limitBlocked;
}

export class RotationManager {
  private readonly now: () => number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private rotating = false;

  constructor(private readonly deps: RotationDeps) {
    this.now = deps.now ?? (() => Date.now());
  }

  private save(state: RotationState): void {
    ensureDir(join(this.deps.ctxRoot, 'state', 'oauth'));
    atomicWriteSync(statePath(this.deps.ctxRoot), JSON.stringify(state, null, 2));
    try { chmodSync(statePath(this.deps.ctxRoot), 0o600); } catch { /* ignore */ }
  }

  start(): void {
    this.timer = setInterval(() => { void this.tick(); }, TICK_MS);
    // Don't hold the process open for the rotation tick alone.
    (this.timer as { unref?: () => void }).unref?.();
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  async onLimitEvent(agent: string, ev: LimitEvent): Promise<void> {
    const t = this.now();
    const state = loadState(this.deps.ctxRoot);
    state.limitBlocked[agent] = { detectedAt: t, kind: ev.kind, resetAt: ev.resetAt };
    // The active account is exhausted by definition of the event. Always mark it
    // (fallback expiry when no hint) — the mark also tells doRotation's
    // active-recovery recheck "don't waste a ping, the banner is fresh proof".
    const active = loadAccounts(this.deps.ctxRoot)?.active;
    if (active) state.exhausted[active] = ev.resetAt ?? t + RETRY_FALLBACK_MS;
    this.save(state);
    this.deps.log(`[rotation] ${agent} limit-blocked (${ev.kind}, reset ${ev.resetAt ? new Date(ev.resetAt).toISOString() : 'unknown'})`);
    await this.attemptRotation('limit banner on ' + agent);
  }

  async tick(): Promise<void> {
    const t = this.now();
    const state = loadState(this.deps.ctxRoot);
    const blocked = Object.keys(state.limitBlocked).length > 0;

    if (blocked && (state.retryAt === null || t >= state.retryAt)) {
      await this.attemptRotation('retry for blocked agents');
      return;
    }
    if (!blocked && t - state.lastPreflightAt >= PREFLIGHT_INTERVAL_MS) {
      state.lastPreflightAt = t;
      this.save(state);
      const store = loadAccounts(this.deps.ctxRoot);
      if (!store) return;
      const result = await this.deps.preflight(store.accounts[store.active]?.access_token ?? '');
      if (result === 'limit') {
        this.deps.log(`[rotation] proactive preflight: active account "${store.active}" exhausted — rotating ahead of the fleet`);
        const s2 = loadState(this.deps.ctxRoot);
        s2.exhausted[store.active] = t + RETRY_FALLBACK_MS; // no hint from a ping; conservative
        this.save(s2);
        await this.attemptRotation('proactive preflight found active account exhausted');
      }
    }
  }

  /** Serialized: concurrent limit events from several agents fold into one rotation. */
  private async attemptRotation(reason: string): Promise<void> {
    if (this.rotating) return;
    this.rotating = true;
    try {
      await this.doRotation(reason);
    } finally {
      this.rotating = false;
    }
  }

  private async doRotation(reason: string): Promise<void> {
    const t = this.now();
    let state = loadState(this.deps.ctxRoot);
    if (t - state.lastRotationAt < ROTATION_COOLDOWN_MS) {
      this.deps.log('[rotation] within cooldown — blocked agents wait for next tick');
      return;
    }
    const store = loadAccounts(this.deps.ctxRoot);
    if (!store) { this.deps.log('[rotation] no accounts.json — cannot rotate'); return; }

    const candidates = Object.keys(store.accounts).filter(name => {
      if (name === store.active) return false;
      const resetAt = state.exhausted[name];
      return !(resetAt && resetAt > t);
    });

    for (const name of candidates) {
      const result = await this.deps.preflight(store.accounts[name].access_token);
      if (result === 'ok') {
        setActiveAccount(this.deps.ctxRoot, name, { reason, from: store.active });
        writeTokenToAgents(this.deps.frameworkRoot, this.deps.org, store.accounts[name].access_token);
        // Reload: preflights are slow (real inference); more agents may have blocked meanwhile.
        state = loadState(this.deps.ctxRoot);
        const toRestart = Object.keys(state.limitBlocked);
        for (const agent of toRestart) {
          try {
            await this.deps.restartAgent(agent);
            delete state.limitBlocked[agent];
          } catch (err) {
            this.deps.log(`[rotation] restart failed for ${agent}: ${err} — stays blocked for next tick`);
          }
        }
        state.lastRotationAt = this.now();
        state.retryAt = null;
        state.alertedHalt = false;
        delete state.exhausted[name];
        this.save(state);
        const msg = `🔄 cortextOS rotated to account "${name}" (${reason}). Restarted: ${toRestart.join(', ') || 'none'}.`;
        this.deps.log('[rotation] ' + msg);
        this.deps.sendAlert(msg);
        return;
      }
      if (result === 'limit') {
        state.exhausted[name] = state.exhausted[name] ?? t + RETRY_FALLBACK_MS;
        this.deps.log(`[rotation] candidate "${name}" exhausted`);
      } else {
        this.deps.log(`[rotation] candidate "${name}" preflight error — skipped, not marked exhausted`);
      }
    }

    // Bench dry — the ACTIVE account may itself have recovered (5h windows reset
    // on their own). Recheck it unless a still-fresh exhausted mark says otherwise;
    // on recovery, restart blocked agents onto it — no account flip needed.
    const activeExhaustedUntil = state.exhausted[store.active] ?? 0;
    if (activeExhaustedUntil <= t) {
      const activeResult = await this.deps.preflight(store.accounts[store.active].access_token);
      if (activeResult === 'ok') {
        state = loadState(this.deps.ctxRoot);
        const toRestart = Object.keys(state.limitBlocked);
        for (const agent of toRestart) {
          try {
            await this.deps.restartAgent(agent);
            delete state.limitBlocked[agent];
          } catch (err) {
            this.deps.log(`[rotation] restart failed for ${agent}: ${err} — stays blocked for next tick`);
          }
        }
        state.lastRotationAt = this.now();
        state.retryAt = null;
        state.alertedHalt = false;
        delete state.exhausted[store.active];
        this.save(state);
        const msg = `🔄 cortextOS: active account "${store.active}" recovered (${reason}). Restarted: ${toRestart.join(', ') || 'none'}.`;
        this.deps.log('[rotation] ' + msg);
        if (toRestart.length) this.deps.sendAlert(msg);
        return;
      }
      const s3 = loadState(this.deps.ctxRoot);
      s3.exhausted[store.active] = t + RETRY_FALLBACK_MS;
      state.exhausted[store.active] = s3.exhausted[store.active];
      this.save(s3);
    }

    // All dry: halt, single alert, schedule retry at earliest known reset.
    const knownResets = [
      ...Object.values(state.exhausted),
      ...Object.values(state.limitBlocked).map(b => b.resetAt).filter((x): x is number => x !== null),
    ];
    state.retryAt = knownResets.length ? Math.min(...knownResets) + 5 * 60_000 : t + RETRY_FALLBACK_MS;
    const alertNeeded = !state.alertedHalt;
    state.alertedHalt = true;
    this.save(state);
    const msg = `⛔ cortextOS: ALL OAuth accounts exhausted. Blocked: ${Object.keys(state.limitBlocked).join(', ') || 'none yet'}. Auto-retry at ${new Date(state.retryAt).toISOString()}.`;
    this.deps.log('[rotation] ' + msg);
    if (alertNeeded) this.deps.sendAlert(msg);
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/unit/rotation-manager.test.ts`
Expected: PASS (9 tests). If the cooldown test fails on `tick()` not rotating: check that `tick()`'s blocked branch runs when `retryAt === null` (a cooldown skip leaves `retryAt` null on purpose so the next tick retries).

- [ ] **Step 5: Commit**

```bash
git add src/daemon/rotation-manager.ts tests/unit/rotation-manager.test.ts
git commit -m "feat(daemon): rotation manager — reactive + proactive account rotation with halt/retry"
```

---

### Task 4: FastChecker suppression for limit-blocked agents

**Files:**
- Modify: `src/daemon/fast-checker.ts` (two verdict sites, ~line 1381 and ~1404: inside `if (fireVerdict.hung)` and before the `forceHangRestart(bootVerdict.reason)` call)
- Test: extend `tests/unit/rotation-manager.test.ts` (isLimitBlocked already covered there; this task's change is wiring, verified by build + live check in Task 7)

**Interfaces:**
- Consumes: `isLimitBlocked(ctxRoot, agent)` from `./rotation-manager.js`; FastChecker already has `this.agent.name`; ctxRoot is derivable — check the constructor for the env/paths field that holds it (`this.paths.stateDir` is `<ctxRoot>/state/<agent>`, so ctxRoot = `join(this.paths.stateDir, '..', '..')`).

- [ ] **Step 1: Add the import and a private helper** (top of `fast-checker.ts` with the other imports; helper near `forceHangRestart`)

```typescript
import { isLimitBlocked } from './rotation-manager.js';
```

```typescript
  /** Rate-limit-blocked sessions look hung (no beats) but restarting burns a
   *  fresh session into the same wall — the rotation manager owns recovery. */
  private hangSuppressedByLimit(): boolean {
    const ctxRoot = join(this.paths.stateDir, '..', '..');
    if (!isLimitBlocked(ctxRoot, this.agent.name)) return false;
    this.log(`${this.agent.name} limit-blocked — hang restart suppressed (rotation manager owns recovery)`);
    return true;
  }
```

- [ ] **Step 2: Guard both verdict sites**

```typescript
    if (fireVerdict.hung) {
      if (this.hangSuppressedByLimit()) return;
      this.log(`Hang detected for ${this.agent.name}: ${fireVerdict.reason}`);
      this.forceHangRestart(fireVerdict.reason);
      return;
    }
```

```typescript
    this.log(`Bootstrap hang detected for ${this.agent.name}: ${bootVerdict.reason}`);
    if (this.hangSuppressedByLimit()) return;
    this.forceHangRestart(bootVerdict.reason);
```

- [ ] **Step 3: Build to verify types**

Run: `npx tsup 2>&1 | tail -3`
Expected: `Build success`.

- [ ] **Step 4: Run the full unit suite**

Run: `npx vitest run tests/unit/`
Expected: PASS, no regressions.

- [ ] **Step 5: Commit**

```bash
git add src/daemon/fast-checker.ts
git commit -m "feat(daemon): suppress hang-restarts for limit-blocked agents"
```

---

### Task 5: Default preflight — Opus inference ping

**Files:**
- Create: `src/daemon/account-preflight.ts`
- Test: `tests/unit/account-preflight.test.ts` (classification only; the spawn itself is exercised in Task 7's live verify)

**Interfaces:**
- Produces: `classifyPreflightOutput(exitCode: number, output: string): PreflightResult`; `preflightAccount(accessToken: string): Promise<PreflightResult>` (the default `RotationDeps.preflight`).
- Consumes: `PreflightResult` type from `./rotation-manager.js`.

- [ ] **Step 1: Write the failing test**

```typescript
// tests/unit/account-preflight.test.ts
import { describe, it, expect } from 'vitest';
import { classifyPreflightOutput } from '../../src/daemon/account-preflight.js';

describe('classifyPreflightOutput', () => {
  it('exit 0 → ok', () => {
    expect(classifyPreflightOutput(0, 'ok')).toBe('ok');
  });
  it('limit text → limit regardless of exit code', () => {
    expect(classifyPreflightOutput(1, "You've hit your weekly limit · resets Jul 20 at 2am (America/New_York)")).toBe('limit');
  });
  it('other nonzero → error', () => {
    expect(classifyPreflightOutput(1, 'network unreachable')).toBe('error');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/account-preflight.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```typescript
// src/daemon/account-preflight.ts
// Default preflight for the rotation manager: a one-word OPUS inference ping.
// Opus because limits are model-bucketed — a haiku pass proves nothing about
// the bucket the fleet burns. The usage API is NOT an option: setup-tokens
// (sk-ant-oat01) lack the user:profile scope and 403.

import { execFile } from 'child_process';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type { PreflightResult } from './rotation-manager.js';

const PREFLIGHT_TIMEOUT_MS = 3 * 60_000;
const FLEET_MODEL = 'claude-opus-4-8';

export function classifyPreflightOutput(exitCode: number, output: string): PreflightResult {
  if (/hit your .*limit/i.test(output)) return 'limit';
  return exitCode === 0 ? 'ok' : 'error';
}

export function preflightAccount(accessToken: string): Promise<PreflightResult> {
  return new Promise((resolve) => {
    // Isolated config dir: never let the daemon's keychain login answer for the token.
    const configDir = mkdtempSync(join(tmpdir(), 'ctx-preflight-'));
    const env = { ...process.env, CLAUDE_CODE_OAUTH_TOKEN: accessToken, CLAUDE_CONFIG_DIR: configDir };
    execFile('claude', ['-p', 'reply with exactly: ok', '--model', FLEET_MODEL],
      { env, timeout: PREFLIGHT_TIMEOUT_MS },
      (err, stdout, stderr) => {
        try { rmSync(configDir, { recursive: true, force: true }); } catch { /* ignore */ }
        const code = err ? ((err as { code?: number }).code ?? 1) : 0;
        resolve(classifyPreflightOutput(typeof code === 'number' ? code : 1, `${stdout}\n${stderr}`));
      });
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/account-preflight.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/daemon/account-preflight.ts tests/unit/account-preflight.test.ts
git commit -m "feat(daemon): opus inference-ping preflight for account rotation"
```

---

### Task 6: Wiring — PTY scan hook, AgentProcess pass-through, AgentManager instantiation

**Files:**
- Modify: `src/pty/agent-pty.ts` (onData handler, ~line 157)
- Modify: `src/daemon/agent-process.ts` (PTY creation site, ~line 140-144)
- Modify: `src/daemon/agent-manager.ts` (agent registration block ~line 443-450; manager constructor/shutdown for the singleton)

**Interfaces:**
- Consumes: `LimitScanner` (Task 1), `RotationManager` (Task 3), `preflightAccount` (Task 5), existing `restartAgent(name)` on AgentManager, existing per-agent `telegramApi`/`chatId`.
- Produces: `AgentPTY.onOutputChunk: ((data: string) => void) | null` public field; `AgentProcess.setOutputChunkHandler(cb: (data: string) => void): void`.

- [ ] **Step 1: AgentPTY — add the field and invoke it in onData**

```typescript
  /** Optional secondary consumer of raw PTY output (limit-banner scanning). */
  onOutputChunk: ((data: string) => void) | null = null;
```

```typescript
    this.pty.onData((data: string) => {
      this.outputBuffer.push(data);
      try { this.onOutputChunk?.(data); } catch { /* scanner must never kill the PTY */ }
    });
```

- [ ] **Step 2: AgentProcess — store a handler, re-apply on every PTY creation**

Add a private field + setter near `telegramApi` (~line 66):

```typescript
  private outputChunkHandler: ((data: string) => void) | null = null;

  /** Secondary PTY output consumer (survives session refresh re-spawns). */
  setOutputChunkHandler(cb: (data: string) => void): void {
    this.outputChunkHandler = cb;
    if (this.pty instanceof AgentPTY) this.pty.onOutputChunk = cb;
  }
```

At the PTY creation site (after the `this.pty = ...` ternary, ~line 144):

```typescript
    if (this.pty instanceof AgentPTY && this.outputChunkHandler) {
      this.pty.onOutputChunk = this.outputChunkHandler;
    }
```

- [ ] **Step 3: AgentManager — one RotationManager, one scanner per agent**

Constructor/field (near other manager singletons):

```typescript
import { RotationManager } from './rotation-manager.js';
import { LimitScanner } from './limit-detector.js';
import { preflightAccount } from './account-preflight.js';
```

```typescript
  private rotationManager: RotationManager | null = null;
  /** First registered agent's Telegram handle — fleet-level rotation alerts. */
  private alertHandle: { api: TelegramAPI; chatId: string } | null = null;

  private ensureRotationManager(env: CtxEnv): RotationManager {
    if (!this.rotationManager) {
      this.rotationManager = new RotationManager({
        ctxRoot: env.ctxRoot,
        frameworkRoot: this.frameworkRoot,
        org: env.org,
        preflight: preflightAccount,
        restartAgent: (name) => this.restartAgent(name),
        sendAlert: (text) => { this.alertHandle?.api.sendMessage(this.alertHandle.chatId, text).catch(() => {}); },
        log: (msg) => this.log(msg),
      });
      this.rotationManager.start();
    }
    return this.rotationManager;
  }
```

In the agent registration block (after `agentProcess.setTelegramHandle(...)`, ~line 450):

```typescript
    if (telegramApi && chatId && !this.alertHandle) this.alertHandle = { api: telegramApi, chatId };
    const rotation = this.ensureRotationManager(env);
    const scanner = new LimitScanner();
    agentProcess.setOutputChunkHandler((data) => {
      const ev = scanner.push(data);
      if (ev) void rotation.onLimitEvent(name, ev);
    });
```

In the manager's shutdown path (find the method that stops checkers/agents):

```typescript
    this.rotationManager?.stop();
```

Note for the implementer: `env`, `name`, `telegramApi`, `chatId`, and `agentProcess` are all in scope in that block (see lines 384–450). If `this.log` doesn't exist on AgentManager, use the module's existing daemon-log function — match whatever `restartAgent` uses.

- [ ] **Step 4: Build + full test suite**

Run: `npx tsup 2>&1 | tail -3 && npx vitest run tests/unit/`
Expected: Build success; all unit tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/pty/agent-pty.ts src/daemon/agent-process.ts src/daemon/agent-manager.ts
git commit -m "feat(daemon): wire limit scanners per agent into rotation manager"
```

---

### Task 7: Deploy + live verify

**Files:** none new (ops task).

- [ ] **Step 1: Deploy the daemon**

```bash
npx tsup && pm2 restart cortextos-daemon && sleep 5 && pm2 list | grep cortextos-daemon
```
Expected: daemon online, uptime seconds.

- [ ] **Step 2: Live verify — point ONE agent at the exhausted account**

The aaronmsachs-max20 token is weekly-limited until Jul 20 — a real limit wall. Temporarily swap warden's token (lowest-traffic agent):

```bash
python3 - <<'EOF'
import json, re, os
s = json.load(open(os.path.expanduser('~/.cortextos/default/state/oauth/accounts.json')))
tok = s['accounts']['aaronmsachs-max20']['access_token']
p = os.path.expanduser('~/cortextos/orgs/wyre/agents/warden/.env')
c = re.sub(r'^CLAUDE_CODE_OAUTH_TOKEN=.*$', f'CLAUDE_CODE_OAUTH_TOKEN={tok}', open(p).read(), flags=re.M)
open(p, 'w').write(c)
EOF
node dist/cli.js restart warden
```

- [ ] **Step 3: Watch the chain fire** (up to ~20 min: warden boots → bootstrap prompt → limit banner → detection → rotation)

```bash
grep -aE "\[rotation\]|limit-blocked" ~/.pm2/logs/cortextos-daemon-out.log | tail -20
cat ~/.cortextos/default/state/oauth/rotation-state.json
```
Expected sequence: `warden limit-blocked (weekly, …)` → either a rotation (if active account differs) restarting warden with the fleet token, or suppressed hang-restarts + retryAt if within cooldown. Warden's `.env` ends up back on the active account's token (writeTokenToAgents overwrites the manual swap) — self-healing includes the verify itself.

- [ ] **Step 4: Confirm warden recovered**

```bash
export LC_ALL=C; tail -c 1200 ~/.cortextos/default/logs/warden/stdout.log | perl -pe 's/\e\[[0-9;?]*[a-zA-Z]//g' | tr -cd '[:print:]' | tail -c 200
```
Expected: normal session output, no limit dialog.

- [ ] **Step 5: Commit changelog + journal, merge**

```bash
# CHANGELOG.md: add under [Unreleased] → Added:
#   - Daemon-side rate-limit detection and automatic OAuth account rotation:
#     limit-blocked agents are no longer hang-restart-looped; the daemon rotates
#     to a healthy account, restarts only blocked agents, halts with a single
#     Telegram alert when all accounts are exhausted, and retries at reset time.
git add CHANGELOG.md CLAUDE.md
git commit -m "docs: changelog + journal for limit rotation"
git checkout main && git merge --no-ff feat/limit-rotation -m "feat(daemon): rate-limit detection + OAuth auto-rotation (#spec 2026-07-16)"
```
