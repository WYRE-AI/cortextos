// tests/unit/rotation-manager.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { RotationManager, isLimitBlocked, loadRotationState } from '../../src/daemon/rotation-manager.js';
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

  describe('preflight-infra vs genuine-exhaustion alerting (PR #54 review, F2)', () => {
    it('every candidate erroring (never limiting) fires a distinct, recurring infra alert alongside the one-time exhaustion halt', async () => {
      preflight.mockResolvedValue('error');
      await rm.onLimitEvent('boss', EV); // attempt 1: consecutiveInfraTicks 0->1 (below threshold=2)
      expect(sendAlert).toHaveBeenCalledTimes(1);
      expect(sendAlert.mock.calls[0][0]).toContain('ALL OAuth accounts exhausted');

      await rm.onLimitEvent('dev', EV); // attempt 2: consecutiveInfraTicks 1->2 (meets threshold)
      expect(sendAlert).toHaveBeenCalledTimes(2); // halt alert suppressed (already alerted); infra alert is new
      expect(sendAlert.mock.calls[1][0]).toMatch(/preflight is returning ERROR/i);
      expect(sendAlert.mock.calls[1][0]).not.toContain('ALL OAuth accounts exhausted');

      const state = JSON.parse(readFileSync(join(ctxRoot, 'state/oauth/rotation-state.json'), 'utf-8'));
      expect(state.consecutiveInfraTicks).toBe(2);
      // A mere 'error' must never be mistaken for genuine exhaustion.
      expect(state.exhausted.b).toBeUndefined();
      expect(state.exhausted.c).toBeUndefined();
    });

    it('a confirmed "limit" result never counts as an infra error, even mixed with errors elsewhere', async () => {
      preflight.mockImplementation(async (tok: string) => (tok === 'tok-b' ? 'limit' : 'error'));
      await rm.onLimitEvent('boss', EV);
      const state = JSON.parse(readFileSync(join(ctxRoot, 'state/oauth/rotation-state.json'), 'utf-8'));
      expect(state.consecutiveInfraTicks).toBe(0); // one real 'limit' this invocation clears the streak
    });

    it('tick()\'s proactive path: 2 consecutive errors trigger the infra alert; a subsequent ok clears the streak', async () => {
      preflight.mockResolvedValue('error');
      t += 30 * 60_000 + 1;
      await rm.tick(); // tick 1: consecutiveInfraTicks -> 1
      expect(sendAlert).not.toHaveBeenCalled();

      t += 30 * 60_000 + 1;
      await rm.tick(); // tick 2: consecutiveInfraTicks -> 2, threshold met
      expect(sendAlert).toHaveBeenCalledTimes(1);
      expect(sendAlert.mock.calls[0][0]).toMatch(/preflight is returning ERROR/i);

      preflight.mockResolvedValue('ok');
      t += 30 * 60_000 + 1;
      await rm.tick(); // tick 3: a real 'ok' clears the streak
      const state = JSON.parse(readFileSync(join(ctxRoot, 'state/oauth/rotation-state.json'), 'utf-8'));
      expect(state.consecutiveInfraTicks).toBe(0);
    });

    it('infra alert respects its own cooldown — does not re-fire on every subsequent all-error attempt', async () => {
      preflight.mockResolvedValue('error');
      await rm.onLimitEvent('boss', EV);           // tick->1
      await rm.onLimitEvent('dev', EV);            // tick->2, fires (sendAlert count 2: halt + infra)
      expect(sendAlert).toHaveBeenCalledTimes(2);
      await rm.onLimitEvent('boss', EV);           // tick->3, still all-error, but within 30min infra cooldown
      expect(sendAlert).toHaveBeenCalledTimes(2);  // no third alert yet
    });
  });
});

describe('disabled accounts on the daemon rotation path (#93 warden finding)', () => {
  let ctxRoot: string, frameworkRoot: string;
  let t: number;
  let preflight: ReturnType<typeof vi.fn>;
  let restartAgent: ReturnType<typeof vi.fn>;
  let sendAlert: ReturnType<typeof vi.fn>;
  let rm: RotationManager;

  const accountsPath = () => join(ctxRoot, 'state', 'oauth', 'accounts.json');
  const seedWithDisabled = (disabledNames: string[]) => {
    const store = JSON.parse(readFileSync(accountsPath(), 'utf-8'));
    for (const n of disabledNames) store.accounts[n].disabled = true;
    writeFileSync(accountsPath(), JSON.stringify(store));
  };

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

  it('a disabled candidate is never preflighted — rotation lands on the enabled one', async () => {
    // b iterates FIRST (insertion order); disabling it must skip straight to c.
    seedWithDisabled(['b']);
    await rm.onLimitEvent('boss', EV);
    expect(preflight).not.toHaveBeenCalledWith('tok-b');
    expect(preflight).toHaveBeenCalledWith('tok-c');
    const store = JSON.parse(readFileSync(accountsPath(), 'utf-8'));
    expect(store.active).toBe('c');
  });

  it('all alternatives disabled: no preflight at all, active unchanged', async () => {
    seedWithDisabled(['b', 'c']);
    await rm.onLimitEvent('boss', EV);
    expect(preflight).not.toHaveBeenCalled();
    const store = JSON.parse(readFileSync(accountsPath(), 'utf-8'));
    expect(store.active).toBe('a');
  });

  it('mid-rotation disable race: setActiveAccount rejection skips gracefully to the next candidate', async () => {
    // b passes preflight, but an operator disables it between the store load
    // and setActiveAccount's own re-read — the throw must not crash the
    // rotation; it must fall through to c.
    preflight.mockImplementation(async (tok: string) => {
      if (tok === 'tok-b') seedWithDisabled(['b']);
      return 'ok';
    });
    await rm.onLimitEvent('boss', EV);
    const store = JSON.parse(readFileSync(accountsPath(), 'utf-8'));
    expect(store.active).toBe('c');
    expect(preflight).toHaveBeenCalledWith('tok-b');
    expect(preflight).toHaveBeenCalledWith('tok-c');
  });
});

describe('exhaustion observations (2026-08-20 fix)', () => {
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

  it('an orphaned exhaustion mark (account removed from accounts.json) never poisons the derived retryAt', async () => {
    // Reproduces the live 2026-08-20 bug exactly: a retired/removed account's
    // mark is never cleared by the normal path (that only fires on rotating
    // INTO the account), so an ancient timestamp sits in `exhausted` forever
    // and Math.min() picks it every time — retryAt gets stuck in the past,
    // permanently, regardless of what the REAL candidates' resets are.
    mkdirSync(join(ctxRoot, 'state', 'oauth'), { recursive: true });
    writeFileSync(join(ctxRoot, 'state', 'oauth', 'rotation-state.json'), JSON.stringify({
      limitBlocked: {}, exhausted: { ghost: 12345 }, // bare-number legacy shape; 'ghost' is not in accounts.json
      lastRotationAt: 0, retryAt: null, lastPreflightAt: 0, alertedHalt: false,
      consecutiveInfraTicks: 0, lastInfraAlertAt: 0,
    }));

    preflight.mockResolvedValue('limit'); // every real candidate dry -> halt path
    await rm.onLimitEvent('boss', EV);
    const state = JSON.parse(readFileSync(join(ctxRoot, 'state/oauth/rotation-state.json'), 'utf-8'));
    // Same value the existing "falls back to synthetic-expiry" test asserts —
    // proves the ghost's ancient 12345 was excluded, not just "some future time".
    expect(state.retryAt).toBe(t + 35 * 60_000);
    expect(state.exhausted.ghost).toBeUndefined(); // pruned, not just ignored
  });

  it('records observedAt and source alongside resetAt, not a bare derived number', async () => {
    preflight.mockResolvedValue('limit');
    await rm.onLimitEvent('boss', EV);
    const state = JSON.parse(readFileSync(join(ctxRoot, 'state/oauth/rotation-state.json'), 'utf-8'));
    expect(state.exhausted.b).toEqual({ observedAt: t, resetAt: t + 30 * 60_000, source: 'candidate-preflight' });
  });

  it('re-observing an already-exhausted account updates observedAt but preserves its existing resetAt', async () => {
    // The observation ("we saw this at T") must stay fresh even when the
    // derived resetAt guess doesn't change — otherwise "account X exhausted"
    // goes stale exactly like a bare verdict would. Uses the all-dry/halt
    // path deliberately: the success path reloads state from disk mid-call
    // (see its own "Reload: preflights are slow" comment) and would discard
    // this same call's in-memory update before ever saving it, which would
    // make this assertion pass for the wrong reason.
    mkdirSync(join(ctxRoot, 'state', 'oauth'), { recursive: true });
    // Must be <= t (already "expired") or the candidates filter (rec.resetAt >
    // t) skips b as not-yet-eligible and it never gets re-tried at all —
    // distinctive just means "not equal to any value this run would compute".
    const distinctiveResetAt = t - 12_345_678;
    writeFileSync(join(ctxRoot, 'state', 'oauth', 'rotation-state.json'), JSON.stringify({
      limitBlocked: {},
      exhausted: { b: { observedAt: t - 60_000, resetAt: distinctiveResetAt, source: 'limit-banner' } },
      lastRotationAt: 0, retryAt: null, lastPreflightAt: 0, alertedHalt: false,
      consecutiveInfraTicks: 0, lastInfraAlertAt: 0,
    }));
    preflight.mockResolvedValue('limit'); // b re-confirmed dry, c dry too -> halt, no reload
    await rm.onLimitEvent('boss', EV);
    const state = JSON.parse(readFileSync(join(ctxRoot, 'state/oauth/rotation-state.json'), 'utf-8'));
    expect(state.exhausted.b.resetAt).toBe(distinctiveResetAt); // preserved, not overwritten by a fresh fallback
    expect(state.exhausted.b.observedAt).toBe(t); // but freshly re-confirmed
    expect(state.exhausted.b.source).toBe('limit-banner'); // source of the ORIGINAL observation kept too
  });

  it('migrates a legacy bare-number exhausted entry to the observation shape on load', () => {
    mkdirSync(join(ctxRoot, 'state', 'oauth'), { recursive: true });
    writeFileSync(join(ctxRoot, 'state', 'oauth', 'rotation-state.json'), JSON.stringify({
      limitBlocked: {}, exhausted: { b: 1784718000000 },
      lastRotationAt: 0, retryAt: null, lastPreflightAt: 0, alertedHalt: false,
      consecutiveInfraTicks: 0, lastInfraAlertAt: 0,
    }));
    const state = loadRotationState(ctxRoot);
    expect(state.exhausted.b).toEqual({ observedAt: 0, resetAt: 1784718000000, source: 'legacy-migrated' });
  });
});
