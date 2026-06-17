/**
 * Discord inbound routing unit tests.
 *
 * Verifies that an inbound gateway message is normalized, archived to the
 * orchestrator's JSONL inbound log, and delivered to the orchestrator's bus
 * inbox via the SAME shared `sendMessage` primitive the rest of the bus uses
 * (src/bus/message.ts -> inbox/{to}/*.json). No token, no network, no
 * discord.js — the inbound module deliberately consumes a narrow plain-object
 * message shape.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type { BusPaths } from '../../../src/types/index';
import {
  deliverInbound,
  normalizeInbound,
  type DiscordInboundMessage,
} from '../../../src/discord/inbound';
import { makePaths } from './helpers';

let ctxRoot: string;
let paths: BusPaths;

function baseMessage(overrides: Partial<DiscordInboundMessage> = {}): DiscordInboundMessage {
  return {
    id: '1001',
    channelId: 'ORCH123',
    authorId: '42',
    authorName: 'Aaron',
    authorIsBot: false,
    content: 'deploy the home cadre',
    ...overrides,
  };
}

beforeEach(() => {
  ctxRoot = mkdtempSync(join(tmpdir(), 'discord-inbound-'));
  paths = makePaths(ctxRoot, 'orchestrator', 'home');
});

afterEach(() => {
  rmSync(ctxRoot, { recursive: true, force: true });
});

describe('normalizeInbound', () => {
  it('strips control chars from author name and content', () => {
    const norm = normalizeInbound(
      baseMessage({ authorName: 'Aa\x07ron', content: 'hi\x00there' }),
    );
    expect(norm.fromName).toBe('Aaron');
    expect(norm.text).toBe('hithere');
    expect(norm.channelId).toBe('ORCH123');
    expect(norm.messageId).toBe('1001');
  });
});

describe('deliverInbound', () => {
  it('writes the message to the orchestrator bus inbox', () => {
    const result = deliverInbound({
      paths,
      ctxRoot,
      orchestrator: 'orchestrator',
      org: 'home',
      message: baseMessage(),
    });

    expect(result.delivered).toBe(true);

    // The bus primitive writes inbox/{to}/*.json under ctxRoot.
    const inboxDir = join(ctxRoot, 'inbox', 'orchestrator');
    expect(existsSync(inboxDir)).toBe(true);
    const files = readdirSync(inboxDir).filter((f) => f.endsWith('.json'));
    expect(files).toHaveLength(1);

    const payload = JSON.parse(readFileSync(join(inboxDir, files[0]), 'utf-8'));
    expect(payload.to).toBe('orchestrator');
    expect(payload.from).toBe('discord');
    expect(payload.text).toContain('deploy the home cadre');
    expect(payload.text).toContain('[discord from Aaron]');
  });

  it('archives the inbound message to the JSONL inbound log', () => {
    deliverInbound({
      paths,
      ctxRoot,
      orchestrator: 'orchestrator',
      org: 'home',
      message: baseMessage(),
    });

    const logPath = join(ctxRoot, 'logs', 'orchestrator', 'inbound-messages.jsonl');
    expect(existsSync(logPath)).toBe(true);
    const line = JSON.parse(readFileSync(logPath, 'utf-8').trim());
    expect(line.source).toBe('discord');
    expect(line.channel_id).toBe('ORCH123');
    expect(line.text).toBe('deploy the home cadre');
  });

  it('emits a message/discord_received bus event', () => {
    deliverInbound({
      paths,
      ctxRoot,
      orchestrator: 'orchestrator',
      org: 'home',
      message: baseMessage(),
    });

    // logEvent writes to the org analytics events log; assert it recorded the
    // discord_received event somewhere under the org analytics dir.
    const analyticsDir = join(ctxRoot, 'orgs', 'home', 'analytics');
    let found = false;
    const walk = (dir: string) => {
      if (!existsSync(dir)) return;
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (readFileSync(full, 'utf-8').includes('discord_received')) found = true;
      }
    };
    walk(analyticsDir);
    expect(found).toBe(true);
  });

  it('ignores bot-authored messages (no inbox write)', () => {
    const result = deliverInbound({
      paths,
      ctxRoot,
      orchestrator: 'orchestrator',
      org: 'home',
      message: baseMessage({ authorIsBot: true }),
    });
    expect(result).toEqual({ delivered: false, reason: 'bot_author' });
    expect(existsSync(join(ctxRoot, 'inbox', 'orchestrator'))).toBe(false);
  });

  it('ignores empty-content messages', () => {
    const result = deliverInbound({
      paths,
      ctxRoot,
      orchestrator: 'orchestrator',
      org: 'home',
      message: baseMessage({ content: '   ' }),
    });
    // whitespace-only becomes empty after stripControlChars/trim semantics
    expect(result.delivered).toBe(false);
  });
});
