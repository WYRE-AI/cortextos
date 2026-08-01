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
