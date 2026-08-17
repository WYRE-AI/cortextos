import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// Mock fetch globally
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

// Mock the setup-token inference-ping spawn (child_process.execFile). The
// mock must invoke the real (error, stdout, stderr) callback convention —
// oauth.ts wraps it in its own Promise, not util.promisify, specifically so
// this stays directly testable (see execFileAsync's docblock).
const execFileMock = vi.fn();
vi.mock('child_process', () => ({
  execFile: (...args: unknown[]) => execFileMock(...args),
}));

function mockExecFileOnce(result: { status: number; stdout: string; stderr: string }) {
  execFileMock.mockImplementationOnce(
    (_file: string, _args: string[], _opts: unknown, callback: (err: Error | null, stdout: string, stderr: string) => void) => {
      if (result.status === 0) {
        callback(null, result.stdout, result.stderr);
      } else {
        const err = new Error(`Command failed with exit code ${result.status}`) as NodeJS.ErrnoException;
        callback(err, result.stdout, result.stderr);
      }
    },
  );
}

function mockExecFileEnoentOnce() {
  execFileMock.mockImplementationOnce(
    (_file: string, _args: string[], _opts: unknown, callback: (err: NodeJS.ErrnoException) => void) => {
      const err = new Error('spawn claude ENOENT') as NodeJS.ErrnoException;
      err.code = 'ENOENT';
      callback(err);
    },
  );
}

const {
  loadAccounts,
  getActiveAccount,
  checkUsageApi,
  refreshOAuthToken,
  rotateOAuth,
  setActiveAccount,
  isSetupToken,
  checkSetupTokenLiveness,
  resolveClaudeBinary,
  ALERT_5H,
  ALERT_7D,
} = await import('../../../src/bus/oauth.js');

// Use 4h expiry to stay above the 2h refresh-before-use threshold
const FOUR_HOURS_MS = 4 * 60 * 60 * 1000;

const SAMPLE_STORE = {
  active: 'primary',
  accounts: {
    primary: {
      label: 'Primary Account',
      access_token: 'tok_primary_abc',
      refresh_token: 'rtok_primary_xyz',
      expires_at: Date.now() + FOUR_HOURS_MS,
      last_refreshed: '2026-04-05T00:00:00Z',
      five_hour_utilization: 0.3,
      seven_day_utilization: 0.2,
    },
    secondary: {
      label: 'Secondary Account',
      access_token: 'tok_secondary_def',
      refresh_token: 'rtok_secondary_uvw',
      expires_at: Date.now() + FOUR_HOURS_MS,
      last_refreshed: '2026-04-05T00:00:00Z',
      five_hour_utilization: 0.1,
      seven_day_utilization: 0.05,
    },
  },
  rotation_log: [],
};

let tmpDir: string;

function writeStore(store = SAMPLE_STORE) {
  const { mkdirSync, writeFileSync } = require('fs');
  const oauthDir = join(tmpDir, 'state', 'oauth');
  mkdirSync(oauthDir, { recursive: true });
  writeFileSync(join(oauthDir, 'accounts.json'), JSON.stringify(store, null, 2));
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'cortextos-oauth-test-'));
  mockFetch.mockReset();
  execFileMock.mockReset();
});

afterEach(() => {
  try { rmSync(tmpDir, { recursive: true }); } catch { /* ignore */ }
});

describe('loadAccounts', () => {
  it('returns null when no accounts.json', () => {
    expect(loadAccounts(tmpDir)).toBeNull();
  });

  it('loads valid accounts.json', () => {
    writeStore();
    const store = loadAccounts(tmpDir);
    expect(store?.active).toBe('primary');
    expect(store?.accounts.primary.access_token).toBe('tok_primary_abc');
  });
});

describe('getActiveAccount', () => {
  it('returns null when no store', () => {
    expect(getActiveAccount(tmpDir)).toBeNull();
  });

  it('returns active account', () => {
    writeStore();
    const result = getActiveAccount(tmpDir);
    expect(result?.name).toBe('primary');
    expect(result?.account.access_token).toBe('tok_primary_abc');
  });
});

describe('checkUsageApi', () => {
  it('fetches and caches usage data', async () => {
    writeStore();
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ five_hour_utilization: 0.42, seven_day_utilization: 0.18 }),
    });

    const result = await checkUsageApi(tmpDir);
    expect(result.five_hour_utilization).toBe(0.42);
    expect(result.seven_day_utilization).toBe(0.18);
    expect(result.cached).toBe(false);
    expect(mockFetch).toHaveBeenCalledOnce();
  });

  it('normalizes 0-100 values to 0.0-1.0', async () => {
    writeStore();
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ five_hour_utilization: 42, seven_day_utilization: 18 }),
    });

    const result = await checkUsageApi(tmpDir, { force: true });
    expect(result.five_hour_utilization).toBeCloseTo(0.42);
    expect(result.seven_day_utilization).toBeCloseTo(0.18);
  });

  it('returns cached result within TTL', async () => {
    writeStore();
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ five_hour_utilization: 0.5, seven_day_utilization: 0.3 }),
    });

    await checkUsageApi(tmpDir); // prime cache
    const cached = await checkUsageApi(tmpDir); // should hit cache
    expect(cached.cached).toBe(true);
    expect(mockFetch).toHaveBeenCalledOnce(); // only one real fetch
  });

  it('bypasses cache with --force', async () => {
    writeStore();
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ five_hour_utilization: 0.5, seven_day_utilization: 0.3 }),
    });

    await checkUsageApi(tmpDir);
    const fresh = await checkUsageApi(tmpDir, { force: true });
    expect(fresh.cached).toBe(false);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('throws on non-ok API response', async () => {
    writeStore();
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 401,
      text: async () => 'Unauthorized',
    });

    await expect(checkUsageApi(tmpDir, { force: true })).rejects.toThrow('401');
  });

  it('uses Bearer token from active account', async () => {
    writeStore();
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ five_hour_utilization: 0.1, seven_day_utilization: 0.05 }),
    });

    await checkUsageApi(tmpDir, { force: true });
    const call = mockFetch.mock.calls[0];
    expect(call[1].headers.Authorization).toBe('Bearer tok_primary_abc');
    expect(call[1].headers['anthropic-beta']).toBe('oauth-2025-04-20');
  });
});

describe('isSetupToken', () => {
  it('true for sk-ant-oat01- prefixed tokens', () => {
    expect(isSetupToken('sk-ant-oat01-abc123')).toBe(true);
  });

  it('false for tokens without the prefix (real OAuth-grant tokens)', () => {
    expect(isSetupToken('tok_primary_abc')).toBe(false);
    expect(isSetupToken('sk-ant-api03-something')).toBe(false);
  });
});

describe('checkSetupTokenLiveness', () => {
  const SETUP_TOKEN_STORE = {
    active: 'primary',
    accounts: {
      primary: { ...SAMPLE_STORE.accounts.primary, access_token: 'sk-ant-oat01-primary' },
      secondary: { ...SAMPLE_STORE.accounts.secondary, access_token: 'sk-ant-oat01-secondary' },
    },
    rotation_log: [],
  };

  it('alive:true on a successful inference ping (exit 0, non-empty stdout)', async () => {
    writeStore(SETUP_TOKEN_STORE);
    mockExecFileOnce({ status: 0, stdout: 'ok', stderr: '' });

    const result = await checkSetupTokenLiveness(tmpDir, 'secondary');
    expect(result.alive).toBe(true);
    expect(result.account).toBe('secondary');
    expect(result.cached).toBe(false);
  });

  it('alive:false on a failed ping (non-zero exit)', async () => {
    writeStore(SETUP_TOKEN_STORE);
    mockExecFileOnce({ status: 1, stdout: '', stderr: 'auth error' });

    const result = await checkSetupTokenLiveness(tmpDir, 'secondary');
    expect(result.alive).toBe(false);
  });

  it('alive:false on empty stdout even with exit 0', async () => {
    writeStore(SETUP_TOKEN_STORE);
    mockExecFileOnce({ status: 0, stdout: '', stderr: '' });

    const result = await checkSetupTokenLiveness(tmpDir, 'secondary');
    expect(result.alive).toBe(false);
  });

  it('alive:false on a spawn failure (ENOENT — binary not found), not a thrown exception', async () => {
    writeStore(SETUP_TOKEN_STORE);
    mockExecFileEnoentOnce();

    // Regression test for the bug this fix addresses: a PATH/spawn failure
    // must fail closed into alive:false (matching a genuinely dead account),
    // not throw and crash the caller — but see the resolveClaudeBinary tests
    // below for why ENOENT should now be rare in the first place.
    const result = await checkSetupTokenLiveness(tmpDir, 'secondary');
    expect(result.alive).toBe(false);
  });

  it('passes the candidate token via env, not argv (never a CLI-visible secret)', async () => {
    writeStore(SETUP_TOKEN_STORE);
    mockExecFileOnce({ status: 0, stdout: 'ok', stderr: '' });

    await checkSetupTokenLiveness(tmpDir, 'secondary');
    const [cmd, args, opts] = execFileMock.mock.calls[0];
    expect(typeof cmd).toBe('string');
    expect((args as string[]).join(' ')).not.toContain('sk-ant-oat01-secondary');
    expect((opts as { env: Record<string, string> }).env.CLAUDE_CODE_OAUTH_TOKEN).toBe('sk-ant-oat01-secondary');
  });

  it('caches the result within TTL — does not re-spawn', async () => {
    writeStore(SETUP_TOKEN_STORE);
    mockExecFileOnce({ status: 0, stdout: 'ok', stderr: '' });

    await checkSetupTokenLiveness(tmpDir, 'secondary');
    const second = await checkSetupTokenLiveness(tmpDir, 'secondary');

    expect(second.cached).toBe(true);
    expect(second.alive).toBe(true);
    expect(execFileMock).toHaveBeenCalledOnce();
  });

  it('force bypasses the cache and re-spawns', async () => {
    writeStore(SETUP_TOKEN_STORE);
    mockExecFileOnce({ status: 0, stdout: 'ok', stderr: '' });
    mockExecFileOnce({ status: 0, stdout: 'ok', stderr: '' });

    await checkSetupTokenLiveness(tmpDir, 'secondary');
    await checkSetupTokenLiveness(tmpDir, 'secondary', { force: true });

    expect(execFileMock).toHaveBeenCalledTimes(2);
  });

  it('never calls fetch — setup-token path does not touch the usage API', async () => {
    writeStore(SETUP_TOKEN_STORE);
    mockExecFileOnce({ status: 0, stdout: 'ok', stderr: '' });

    await checkSetupTokenLiveness(tmpDir, 'secondary');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('does not block the event loop — a timer fires while the ping is in flight', async () => {
    // Regression test for the blocking-daemon bug: spawnSync would stall the
    // entire single-process daemon for the ping's duration. execFile must
    // let other event-loop work (Telegram polling, other agents' beats)
    // proceed while it's in flight. Prove it by racing a setTimeout(0)
    // against the still-unresolved ping.
    writeStore(SETUP_TOKEN_STORE);
    let resolveCallback!: (err: Error | null, stdout: string, stderr: string) => void;
    execFileMock.mockImplementationOnce((_file, _args, _opts, callback) => {
      resolveCallback = callback as typeof resolveCallback;
      // deliberately does not call back synchronously
    });

    let timerFired = false;
    const timerPromise = new Promise<void>((resolve) => {
      setTimeout(() => { timerFired = true; resolve(); }, 0);
    });

    const livenessPromise = checkSetupTokenLiveness(tmpDir, 'secondary');

    await timerPromise;
    expect(timerFired).toBe(true); // the timer ran WHILE the ping was still pending

    resolveCallback(null, 'ok', '');
    const result = await livenessPromise;
    expect(result.alive).toBe(true);
  });
});

describe('resolveClaudeBinary', () => {
  it('returns a non-empty string (either a resolved absolute path or the bare fallback)', () => {
    // Environment-dependent (depends on what's actually installed on the
    // machine running the test), so assert the contract rather than a
    // specific path: always returns something spawnable, cached across calls.
    const first = resolveClaudeBinary();
    const second = resolveClaudeBinary();
    expect(typeof first).toBe('string');
    expect(first.length).toBeGreaterThan(0);
    expect(second).toBe(first); // cached — same value every call
  });
});

describe('refreshOAuthToken', () => {
  it('throws when no accounts.json', async () => {
    await expect(refreshOAuthToken(tmpDir)).rejects.toThrow('No accounts.json');
  });

  it('refreshes active account and writes atomically', async () => {
    writeStore();
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        access_token: 'new_access_tok',
        refresh_token: 'new_refresh_tok',
        expires_in: 3600,
      }),
    });

    const result = await refreshOAuthToken(tmpDir);
    expect(result.account).toBe('primary');
    expect(result.expires_at).toBeGreaterThan(Date.now());

    // Verify accounts.json was rewritten with new tokens
    const store = loadAccounts(tmpDir)!;
    expect(store.accounts.primary.access_token).toBe('new_access_tok');
    expect(store.accounts.primary.refresh_token).toBe('new_refresh_tok');
  });

  it('refreshes named account', async () => {
    writeStore();
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        access_token: 'sec_new_tok',
        refresh_token: 'sec_new_rtok',
        expires_in: 3600,
      }),
    });

    await refreshOAuthToken(tmpDir, 'secondary');
    const store = loadAccounts(tmpDir)!;
    expect(store.accounts.secondary.access_token).toBe('sec_new_tok');
    // Primary should be unchanged
    expect(store.accounts.primary.access_token).toBe('tok_primary_abc');
  });

  it('throws on failed refresh', async () => {
    writeStore();
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 400,
      text: async () => 'invalid_grant',
    });

    await expect(refreshOAuthToken(tmpDir)).rejects.toThrow('400');
  });
});

describe('rotateOAuth', () => {
  const frameworkRoot = '/tmp/fw';

  it('does not rotate when utilization is low', async () => {
    writeStore(); // primary at 30%/20% — below thresholds
    const result = await rotateOAuth(tmpDir, frameworkRoot, 'acme');
    expect(result.rotated).toBe(false);
    expect(result.reason).toContain('within limits');
  });

  it('rotates when 5h utilization exceeds threshold', async () => {
    const highUtilStore = {
      ...SAMPLE_STORE,
      accounts: {
        ...SAMPLE_STORE.accounts,
        primary: { ...SAMPLE_STORE.accounts.primary, five_hour_utilization: 0.90 },
      },
    };
    writeStore(highUtilStore);

    // Preflight fetch for secondary
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ five_hour_utilization: 0.1, seven_day_utilization: 0.05 }),
    });

    const result = await rotateOAuth(tmpDir, frameworkRoot, 'acme');
    expect(result.rotated).toBe(true);
    expect(result.from).toBe('primary');
    expect(result.to).toBe('secondary');

    // accounts.json should show secondary as active
    const store = loadAccounts(tmpDir)!;
    expect(store.active).toBe('secondary');
    expect(store.rotation_log).toHaveLength(1);
    expect(store.rotation_log[0].from).toBe('primary');
  });

  it('does not rotate when preflight fails', async () => {
    const highUtilStore = {
      ...SAMPLE_STORE,
      accounts: {
        ...SAMPLE_STORE.accounts,
        primary: { ...SAMPLE_STORE.accounts.primary, five_hour_utilization: 0.90 },
      },
    };
    writeStore(highUtilStore);

    // Preflight fails
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 401,
      text: async () => 'Unauthorized',
    });

    const result = await rotateOAuth(tmpDir, frameworkRoot, 'acme');
    expect(result.rotated).toBe(false);
    expect(result.reason).toContain('Preflight failed');

    // accounts.json active should be unchanged
    const store = loadAccounts(tmpDir)!;
    expect(store.active).toBe('primary');
  });

  it('force-rotates regardless of utilization', async () => {
    writeStore(); // low utilization

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ five_hour_utilization: 0.1, seven_day_utilization: 0.05 }),
    });

    const result = await rotateOAuth(tmpDir, frameworkRoot, 'acme', { force: true });
    expect(result.rotated).toBe(true);
  });

  it('returns error when no alternate accounts', async () => {
    const singleAccountStore = {
      active: 'primary',
      accounts: { primary: SAMPLE_STORE.accounts.primary },
      rotation_log: [],
    };
    writeStore(singleAccountStore);
    const store = loadAccounts(tmpDir)!;
    store.accounts.primary.five_hour_utilization = 0.90;
    const { mkdirSync, writeFileSync } = require('fs');
    const oauthDir = join(tmpDir, 'state', 'oauth');
    mkdirSync(oauthDir, { recursive: true });
    writeFileSync(join(oauthDir, 'accounts.json'), JSON.stringify(store, null, 2));

    const result = await rotateOAuth(tmpDir, frameworkRoot, 'acme', { force: true });
    expect(result.rotated).toBe(false);
    expect(result.reason).toContain('No alternate accounts');
  });

  describe('candidate iteration (multiple alternates, not just candidates[0])', () => {
    const THREE_ACCOUNT_STORE = {
      active: 'primary',
      accounts: {
        primary: { ...SAMPLE_STORE.accounts.primary, five_hour_utilization: 0.90 },
        altA: { ...SAMPLE_STORE.accounts.secondary, label: 'Alt A', access_token: 'tok_altA', five_hour_utilization: 0.05 },
        altB: { ...SAMPLE_STORE.accounts.secondary, label: 'Alt B', access_token: 'tok_altB', five_hour_utilization: 0.20 },
      },
      rotation_log: [],
    };

    it('candidates[0] (lowest utilization) passing preflight yields the same shape as the single-candidate case — no regression', async () => {
      writeStore(THREE_ACCOUNT_STORE);

      // altA sorts first (lowest util) and its preflight succeeds immediately.
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ five_hour_utilization: 0.05, seven_day_utilization: 0.02 }),
      });

      const result = await rotateOAuth(tmpDir, frameworkRoot, 'acme');

      expect(result.rotated).toBe(true);
      expect(result.from).toBe('primary');
      expect(result.to).toBe('altA');
      expect(mockFetch).toHaveBeenCalledOnce(); // only the winning candidate was probed

      const store = loadAccounts(tmpDir)!;
      expect(store.active).toBe('altA');
      expect(store.rotation_log).toHaveLength(1);
      expect(store.rotation_log[0].to).toBe('altA');
    });

    it('falls through to the second candidate when the first (lowest-utilization) one fails preflight', async () => {
      writeStore(THREE_ACCOUNT_STORE);

      // altA sorts first but its preflight fails (e.g. revoked/broken token).
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 401,
        text: async () => 'Unauthorized',
      });
      // altB sorts second and its preflight succeeds.
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ five_hour_utilization: 0.20, seven_day_utilization: 0.1 }),
      });

      const result = await rotateOAuth(tmpDir, frameworkRoot, 'acme');

      expect(result.rotated).toBe(true);
      expect(result.to).toBe('altB');
      expect(mockFetch).toHaveBeenCalledTimes(2); // tried altA, then altB

      const store = loadAccounts(tmpDir)!;
      expect(store.active).toBe('altB');
    });
  });

  describe('setup-token candidate (the 403-on-checkUsageApi case this branch fixes)', () => {
    const setupTokenStore = {
      ...SAMPLE_STORE,
      accounts: {
        primary: { ...SAMPLE_STORE.accounts.primary, five_hour_utilization: 0.90 },
        secondary: { ...SAMPLE_STORE.accounts.secondary, access_token: 'sk-ant-oat01-secondary' },
      },
    };

    it('rotates via inference ping, WITHOUT ever calling checkUsageApi/fetch for the candidate', async () => {
      writeStore(setupTokenStore);
      mockExecFileOnce({ status: 0, stdout: 'ok', stderr: '' });

      const result = await rotateOAuth(tmpDir, frameworkRoot, 'acme');

      expect(result.rotated).toBe(true);
      expect(result.to).toBe('secondary');
      // The real usage API would have 403'd on this token — proving we never
      // called it is the actual regression test for the bug this fixes.
      expect(mockFetch).not.toHaveBeenCalled();
      expect(execFileMock).toHaveBeenCalledOnce();

      const store = loadAccounts(tmpDir)!;
      expect(store.active).toBe('secondary');
    });

    it('does not rotate when the inference ping fails (candidate genuinely dead)', async () => {
      writeStore(setupTokenStore);
      mockExecFileOnce({ status: 1, stdout: '', stderr: 'invalid_grant' });

      const result = await rotateOAuth(tmpDir, frameworkRoot, 'acme');

      expect(result.rotated).toBe(false);
      expect(result.reason).toContain('Preflight failed');
      const store = loadAccounts(tmpDir)!;
      expect(store.active).toBe('primary'); // unchanged
    });

    it('preserves existing (stale) utilization fields rather than fabricating a number', async () => {
      writeStore(setupTokenStore);
      mockExecFileOnce({ status: 0, stdout: 'ok', stderr: '' });

      await rotateOAuth(tmpDir, frameworkRoot, 'acme');

      const store = loadAccounts(tmpDir)!;
      // secondary's utilization in setupTokenStore was 0.1/0.05 (from SAMPLE_STORE) —
      // must be UNCHANGED, not overwritten with a value the ping can't actually measure.
      expect(store.accounts.secondary.five_hour_utilization).toBe(0.1);
      expect(store.accounts.secondary.seven_day_utilization).toBe(0.05);
    });
  });
});

describe('resolveClaudeBinary — PM2-like stripped-PATH environment', () => {
  // Proves the actual failure mode analyst flagged: PM2 (and other process
  // managers/launchd/systemd) often start a daemon with PATH assembled
  // BEFORE the user's shell rc files run (nvm, homebrew shellenv, etc.), so
  // `claude` can be missing from PATH even though it resolves fine
  // interactively. A bare PATH-dependent spawn would ENOENT under that
  // condition; resolveClaudeBinary must not, because it locates the binary
  // via existsSync on absolute candidate paths — a check that never
  // consults process.env.PATH at all.
  //
  // vi.resetModules() forces a completely fresh module instance (empty
  // cachedClaudeBinary) so this exercises real first-resolution behavior
  // under the stripped env, not a value left over from an earlier test's
  // full-PATH call.
  it('still resolves an absolute path when PATH is stripped to a PM2-launchd-style minimal set', async () => {
    const originalPath = process.env.PATH;
    try {
      process.env.PATH = '/usr/bin:/bin'; // no /opt/homebrew/bin, no npm global bin, nothing shell-rc-sourced
      vi.resetModules();
      const fresh = await import('../../../src/bus/oauth.js');
      const resolved = fresh.resolveClaudeBinary();

      // If none of CLAUDE_BINARY_CANDIDATES exist on the machine running
      // this test, resolveClaudeBinary legitimately falls back to the bare
      // 'claude' string — that's a real environment gap, not a test
      // failure. Skip the assertion in that case rather than false-fail.
      const { existsSync } = await import('fs');
      const anyCandidateExists =
        existsSync('/opt/homebrew/bin/claude') || existsSync('/usr/local/bin/claude');
      if (anyCandidateExists) {
        expect(resolved).not.toBe('claude'); // resolved to an absolute path, not the PATH-dependent fallback
        expect(resolved.startsWith('/')).toBe(true);
      }
    } finally {
      process.env.PATH = originalPath;
      vi.resetModules();
    }
  });
});

describe('alert thresholds', () => {
  it('ALERT_5H is 0.80', () => {
    expect(ALERT_5H).toBe(0.80);
  });
  it('ALERT_7D is 0.70', () => {
    expect(ALERT_7D).toBe(0.70);
  });
});

describe('disabled account flag — retired seats are never selected', () => {
  const frameworkRoot = '/tmp/fw';

  it('a disabled account is never selected even when it is the only alternative — and never reaches preflight', async () => {
    const store = {
      ...SAMPLE_STORE,
      accounts: {
        primary: { ...SAMPLE_STORE.accounts.primary, five_hour_utilization: 0.90 },
        secondary: { ...SAMPLE_STORE.accounts.secondary, disabled: true },
      },
    };
    writeStore(store);

    const result = await rotateOAuth(tmpDir, frameworkRoot, 'acme');

    expect(result.rotated).toBe(false);
    expect(result.reason).toContain('No alternate accounts available');
    // The disabled account must be filtered BEFORE preflight — a cancelled
    // seat passes the liveness ping, so reaching preflight at all is the bug.
    expect(mockFetch).not.toHaveBeenCalled();
    expect(loadAccounts(tmpDir)!.active).toBe('primary');
  });

  it('a disabled account with the LOWEST utilization is skipped in favor of an enabled one', async () => {
    const store = {
      ...SAMPLE_STORE,
      accounts: {
        primary: { ...SAMPLE_STORE.accounts.primary, five_hour_utilization: 0.90 },
        // Would sort FIRST (0.0 utilization) if the filter did not exclude it.
        dead: { ...SAMPLE_STORE.accounts.secondary, label: 'Cancelled Seat', disabled: true, five_hour_utilization: 0.0, seven_day_utilization: 0.0 },
        tertiary: { ...SAMPLE_STORE.accounts.secondary, label: 'Healthy Alt', five_hour_utilization: 0.2 },
      },
    };
    writeStore(store);
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ five_hour_utilization: 0.2, seven_day_utilization: 0.05 }),
    });

    const result = await rotateOAuth(tmpDir, frameworkRoot, 'acme');

    expect(result.rotated).toBe(true);
    expect(result.to).toBe('tertiary');
    expect(loadAccounts(tmpDir)!.active).toBe('tertiary');
  });

  it('setActiveAccount refuses to activate a disabled account', () => {
    const store = {
      ...SAMPLE_STORE,
      accounts: {
        primary: SAMPLE_STORE.accounts.primary,
        secondary: { ...SAMPLE_STORE.accounts.secondary, disabled: true },
      },
    };
    writeStore(store);

    expect(() =>
      setActiveAccount(tmpDir, 'secondary', { reason: 'operator switch', from: 'primary' }),
    ).toThrow(/disabled/);
    expect(loadAccounts(tmpDir)!.active).toBe('primary');
  });
});
