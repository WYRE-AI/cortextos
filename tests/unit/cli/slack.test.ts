import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { runTestSend, slackCommand } from '../../../src/cli/slack';

describe('runTestSend', () => {
  let root: string;
  let api: { postMessage: ReturnType<typeof vi.fn> };
  const originalCtxAgentName = process.env.CTX_AGENT_NAME;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'sp3a-cli-'));
    api = { postMessage: vi.fn().mockResolvedValue({ ok: true, channel: 'C1', ts: '1' }) };
    delete process.env.CTX_AGENT_NAME;
  });

  afterEach(() => {
    if (originalCtxAgentName === undefined) delete process.env.CTX_AGENT_NAME;
    else process.env.CTX_AGENT_NAME = originalCtxAgentName;
  });

  it('posts a test message for a Slack-enabled agent, with no identity fields (api.ts derives username itself)', async () => {
    const agentDir = join(root, 'orgs', 'wyre', 'agents', 'boss');
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(
      join(agentDir, 'slack.json'),
      JSON.stringify({ channels: {}, allowed_channels: [], allowed_users: [] }),
    );
    await runTestSend(
      { frameworkRoot: root, org: 'wyre', agent: 'boss', channel: 'C1', text: 'hi' },
      api as never,
    );
    expect(api.postMessage).toHaveBeenCalledWith({ channel: 'C1', text: 'hi' });
  });

  it('posts without identity when --as is omitted', async () => {
    await runTestSend(
      { frameworkRoot: root, org: 'wyre', channel: 'C1', text: 'plain' },
      api as never,
    );
    expect(api.postMessage).toHaveBeenCalledWith({ channel: 'C1', text: 'plain' });
  });

  it('throws when --as names an agent with no slack.json (not Slack-enabled)', async () => {
    await expect(
      runTestSend({ frameworkRoot: root, org: 'wyre', agent: 'ghost', channel: 'C1', text: 'hi' }, api as never),
    ).rejects.toThrow(/not Slack-enabled/);
  });

  it('identity gate: refuses when --as names a DIFFERENT agent than the running process (the spoofing case)', async () => {
    const agentDir = join(root, 'orgs', 'wyre', 'agents', 'boss');
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(
      join(agentDir, 'slack.json'),
      JSON.stringify({ channels: {}, allowed_channels: [], allowed_users: [] }),
    );
    process.env.CTX_AGENT_NAME = 'dev'; // this process IS dev, trying to post --as boss
    await expect(
      runTestSend({ frameworkRoot: root, org: 'wyre', agent: 'boss', channel: 'C1', text: 'hi' }, api as never),
    ).rejects.toThrow(/refusing to send/);
    expect(api.postMessage).not.toHaveBeenCalled();
  });

  it('identity gate: allows --as when it matches the running process\'s own CTX_AGENT_NAME', async () => {
    const agentDir = join(root, 'orgs', 'wyre', 'agents', 'boss');
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(
      join(agentDir, 'slack.json'),
      JSON.stringify({ channels: {}, allowed_channels: [], allowed_users: [] }),
    );
    process.env.CTX_AGENT_NAME = 'boss';
    await runTestSend(
      { frameworkRoot: root, org: 'wyre', agent: 'boss', channel: 'C1', text: 'hi' },
      api as never,
    );
    expect(api.postMessage).toHaveBeenCalledWith({ channel: 'C1', text: 'hi' });
  });

  it('identity gate: a human operator with no CTX_AGENT_NAME set may still use --as (nothing to spoof)', async () => {
    const agentDir = join(root, 'orgs', 'wyre', 'agents', 'boss');
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(
      join(agentDir, 'slack.json'),
      JSON.stringify({ channels: {}, allowed_channels: [], allowed_users: [] }),
    );
    // CTX_AGENT_NAME deliberately unset by beforeEach — simulates a human
    // running the CLI directly, outside any agent's process context.
    await runTestSend(
      { frameworkRoot: root, org: 'wyre', agent: 'boss', channel: 'C1', text: 'hi' },
      api as never,
    );
    expect(api.postMessage).toHaveBeenCalledWith({ channel: 'C1', text: 'hi' });
  });
});

describe('slack send subcommand (SP3b reply path)', () => {
  it('registers a stable "send" subcommand alongside test-send', () => {
    const names = slackCommand.commands.map((c) => c.name());
    expect(names).toContain('send');
    expect(names).toContain('test-send'); // unchanged — send is additive, not a replacement
  });
});
