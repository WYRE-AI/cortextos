/**
 * tests/unit/cli/bus-set-oauth-account.test.ts
 *
 * Tests the `bus set-oauth-account <name>` subcommand.
 *
 * Unlike `rotate-oauth` — which walks candidates and takes the first one that
 * passes preflight — this command goes exactly where the operator points it.
 * That is the whole reason it exists: when an account is known-dead (cancelled
 * subscription, revoked token) the operator has already chosen the replacement,
 * and the setup-token preflight is a one-word inference ping that passes even
 * on accounts with no usable capacity.
 *
 * Strategy mirrors bus-crons.test.ts: CTX_ROOT / CTX_FRAMEWORK_ROOT / CTX_ORG
 * point at per-test tempdirs, process.exit is mocked to throw, and console is
 * spied on. The tests exercise the full CLI-to-disk path:
 *   parseAsync → action → setActiveAccount + writeTokenToAgents → files on disk
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { busCommand } from '../../../src/cli/bus';

let ctxRoot: string;
let frameworkRoot: string;

const originalCtxRoot = process.env.CTX_ROOT;
const originalFrameworkRoot = process.env.CTX_FRAMEWORK_ROOT;
const originalOrg = process.env.CTX_ORG;
const originalInstanceId = process.env.CTX_INSTANCE_ID;

const ORG = 'wyre';
const AGENTS = ['boss', 'scribe'];

function accountsPath(): string {
  return join(ctxRoot, 'state', 'oauth', 'accounts.json');
}

function readAccounts(): any {
  return JSON.parse(readFileSync(accountsPath(), 'utf-8'));
}

function agentEnvPath(agent: string): string {
  return join(frameworkRoot, 'orgs', ORG, 'agents', agent, '.env');
}

function readEnv(agent: string): string {
  return readFileSync(agentEnvPath(agent), 'utf-8');
}

function mockExit(): ReturnType<typeof vi.spyOn> {
  return vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new Error(`__PROCESS_EXIT_${code}__`);
  }) as never);
}

/** Seed two accounts, active = dead-acct, plus agent .env files with surrounding keys. */
function seed(): void {
  mkdirSync(join(ctxRoot, 'state', 'oauth'), { recursive: true });
  writeFileSync(accountsPath(), JSON.stringify({
    active: 'dead-acct',
    accounts: {
      'dead-acct': {
        label: 'Cancelled', access_token: 'tok-dead', refresh_token: '',
        expires_at: 9e15, last_refreshed: '',
        five_hour_utilization: 0.42, seven_day_utilization: 0.11,
      },
      'live-acct': {
        label: 'Live', access_token: 'tok-live', refresh_token: '',
        expires_at: 9e15, last_refreshed: '',
        five_hour_utilization: 0, seven_day_utilization: 0,
      },
    },
    rotation_log: [],
  }, null, 2));

  for (const a of AGENTS) {
    mkdirSync(join(frameworkRoot, 'orgs', ORG, 'agents', a), { recursive: true });
    writeFileSync(agentEnvPath(a), [
      'BOT_TOKEN=keep-me',
      'CLAUDE_CODE_OAUTH_TOKEN=tok-dead',
      `CLAUDE_CONFIG_DIR=/tmp/${a}/claude-config`,
      '',
    ].join('\n'));
  }
}

beforeEach(() => {
  ctxRoot = mkdtempSync(join(tmpdir(), 'set-oauth-ctx-'));
  frameworkRoot = mkdtempSync(join(tmpdir(), 'set-oauth-fw-'));
  process.env.CTX_ROOT = ctxRoot;
  process.env.CTX_FRAMEWORK_ROOT = frameworkRoot;
  process.env.CTX_ORG = ORG;
  process.env.CTX_INSTANCE_ID = 'default';
  seed();
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const [k, v] of [
    ['CTX_ROOT', originalCtxRoot],
    ['CTX_FRAMEWORK_ROOT', originalFrameworkRoot],
    ['CTX_ORG', originalOrg],
    ['CTX_INSTANCE_ID', originalInstanceId],
  ] as const) {
    if (v !== undefined) process.env[k] = v;
    else delete process.env[k];
  }
  rmSync(ctxRoot, { recursive: true, force: true });
  rmSync(frameworkRoot, { recursive: true, force: true });
});

describe('bus set-oauth-account', () => {
  it('switches to the named account even when it is not the first candidate', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await busCommand.parseAsync(['node', 'bus', 'set-oauth-account', 'live-acct']);

    expect(errSpy).not.toHaveBeenCalled();
    expect(readAccounts().active).toBe('live-acct');
    expect(logSpy).toHaveBeenCalledWith('Active OAuth account: dead-acct → live-acct');
  });

  it('propagates the new token to every agent .env, preserving other keys', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});

    await busCommand.parseAsync(['node', 'bus', 'set-oauth-account', 'live-acct']);

    for (const a of AGENTS) {
      const env = readEnv(a);
      expect(env).toContain('CLAUDE_CODE_OAUTH_TOKEN=tok-live');
      expect(env).not.toContain('tok-dead');
      // Surrounding keys must survive the surgical line replace.
      expect(env).toContain('BOT_TOKEN=keep-me');
      expect(env).toContain(`CLAUDE_CONFIG_DIR=/tmp/${a}/claude-config`);
    }
  });

  it('records a rotation_log entry carrying the OUTGOING account utilization', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});

    await busCommand.parseAsync([
      'node', 'bus', 'set-oauth-account', 'live-acct', '--reason', 'subscription cancelled',
    ]);

    const entry = readAccounts().rotation_log[0];
    expect(entry).toMatchObject({
      from: 'dead-acct',
      to: 'live-acct',
      reason: 'subscription cancelled',
      five_hour_util: 0.42,
      seven_day_util: 0.11,
    });
  });

  it('--agent scopes the .env write to a single agent', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});

    await busCommand.parseAsync([
      'node', 'bus', 'set-oauth-account', 'live-acct', '--agent', 'boss',
    ]);

    expect(readEnv('boss')).toContain('CLAUDE_CODE_OAUTH_TOKEN=tok-live');
    // scribe is left on the old token — active still flips, only the write is scoped
    expect(readEnv('scribe')).toContain('CLAUDE_CODE_OAUTH_TOKEN=tok-dead');
    expect(readAccounts().active).toBe('live-acct');
  });

  it('rejects an unknown account without touching accounts.json or any .env', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    mockExit();

    await expect(
      busCommand.parseAsync(['node', 'bus', 'set-oauth-account', 'no-such-acct']),
    ).rejects.toThrow('__PROCESS_EXIT_1__');

    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('not found'));
    expect(readAccounts().active).toBe('dead-acct');
    expect(readEnv('boss')).toContain('CLAUDE_CODE_OAUTH_TOKEN=tok-dead');
  });

  it('--json reports the from/to transition', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await busCommand.parseAsync([
      'node', 'bus', 'set-oauth-account', 'live-acct', '--json',
    ]);

    const payload = JSON.parse(logSpy.mock.calls[0][0] as string);
    expect(payload).toMatchObject({ switched: true, from: 'dead-acct', to: 'live-acct', agent: 'all' });
  });
});
