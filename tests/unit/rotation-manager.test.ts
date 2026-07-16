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
