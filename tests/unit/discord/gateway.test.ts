/**
 * Discord gateway inbound tests, driven by the mock gateway client.
 *
 * Mirrors the role of tests/playwright/mock-telegram-server.ts: exercise the
 * full inbound path — gateway channel filter -> handler -> bus inbox — without
 * a real Discord token or network. The mock client implements the narrow
 * GatewayClientLike surface and lets the test simulate a user posting in a
 * channel.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { DiscordGateway, createGatewayFromEnv } from '../../../src/discord/gateway';
import { deliverInbound, type DiscordInboundMessage } from '../../../src/discord/inbound';
import { MockDiscordGateway } from '../../playwright/mock-discord-gateway';
import { makePaths } from './helpers';

const ORCH_CHANNEL = 'ORCH123';

describe('DiscordGateway (mock-driven inbound)', () => {
  let mock: MockDiscordGateway;
  let gw: DiscordGateway;

  beforeEach(() => {
    mock = new MockDiscordGateway();
    gw = new DiscordGateway(
      { botToken: 't', orchChannelId: ORCH_CHANNEL },
      mock.factory,
    );
  });

  it('logs in with the configured token on start', async () => {
    const gwWithToken = new DiscordGateway(
      { botToken: 'secret-tok', orchChannelId: ORCH_CHANNEL },
      mock.factory,
    );
    await gwWithToken.start();
    expect(mock.client.loggedInToken).toBe('secret-tok');
    expect(mock.client.loginCount).toBe(1);
  });

  it('forwards messages in the configured channel to handlers', async () => {
    const received: DiscordInboundMessage[] = [];
    gw.onMessage((m) => received.push(m));
    await gw.start();

    mock.client.emitMessage({ channelId: ORCH_CHANNEL, content: 'hello orchestrator' });

    expect(received).toHaveLength(1);
    expect(received[0].content).toBe('hello orchestrator');
    expect(received[0].channelId).toBe(ORCH_CHANNEL);
  });

  it('drops messages from other channels (orchestrator-only scope)', async () => {
    const received: DiscordInboundMessage[] = [];
    gw.onMessage((m) => received.push(m));
    await gw.start();

    mock.client.emitMessage({ channelId: 'SOME_OTHER_CHANNEL', content: 'noise' });

    expect(received).toHaveLength(0);
  });

  it('a handler throw does not kill the gateway', async () => {
    const seen: string[] = [];
    gw.onMessage(() => {
      throw new Error('boom');
    });
    gw.onMessage((m) => seen.push(m.content));
    await gw.start();

    mock.client.emitMessage({ channelId: ORCH_CHANNEL, content: 'survives' });
    expect(seen).toEqual(['survives']);
  });

  it('destroys the client on stop (supervisor teardown)', async () => {
    await gw.start();
    await gw.stop();
    expect(mock.client.destroyed).toBe(true);
    expect(mock.client.destroyCount).toBe(1);
  });

  it('refuses a double start', async () => {
    await gw.start();
    await expect(gw.start()).rejects.toThrow(/already started/);
  });
});

describe('createGatewayFromEnv', () => {
  it('returns null when Discord is not configured', () => {
    expect(createGatewayFromEnv({})).toBeNull();
  });

  it('builds a gateway when token + channel are present', () => {
    const gw = createGatewayFromEnv(
      { DISCORD_BOT_TOKEN: 't', DISCORD_ORCH_CHANNEL_ID: ORCH_CHANNEL },
      new MockDiscordGateway().factory,
    );
    expect(gw).toBeInstanceOf(DiscordGateway);
  });
});

describe('end-to-end: gateway message lands in the orchestrator bus inbox', () => {
  let ctxRoot: string;
  let mock: MockDiscordGateway;
  let gw: DiscordGateway;

  beforeEach(async () => {
    ctxRoot = mkdtempSync(join(tmpdir(), 'discord-gw-e2e-'));
    const paths = makePaths(ctxRoot, 'orchestrator', 'home');
    mock = new MockDiscordGateway();
    gw = new DiscordGateway(
      { botToken: 't', orchChannelId: ORCH_CHANNEL },
      mock.factory,
    );
    // Wire the gateway to the inbound delivery path exactly as the daemon would.
    gw.onMessage((msg) => {
      deliverInbound({
        paths,
        ctxRoot,
        orchestrator: 'orchestrator',
        org: 'home',
        message: msg,
      });
    });
    await gw.start();
  });

  afterEach(() => {
    rmSync(ctxRoot, { recursive: true, force: true });
  });

  it('routes an inbound channel message into inbox/orchestrator/', () => {
    mock.client.emitMessage({
      channelId: ORCH_CHANNEL,
      authorName: 'Aaron',
      content: 'status report please',
    });

    const inboxDir = join(ctxRoot, 'inbox', 'orchestrator');
    expect(existsSync(inboxDir)).toBe(true);
    const files = readdirSync(inboxDir).filter((f) => f.endsWith('.json'));
    expect(files).toHaveLength(1);
  });

  it('does not route a bot-authored message into the inbox', () => {
    mock.client.emitMessage({
      channelId: ORCH_CHANNEL,
      authorIsBot: true,
      content: 'echo from our own bot',
    });

    expect(existsSync(join(ctxRoot, 'inbox', 'orchestrator'))).toBe(false);
  });
});
