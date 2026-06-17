/**
 * Discord adapter unit tests — normalization + send payloads.
 *
 * Mirrors tests/unit/cli/slack.test.ts (send payload shape under an injected
 * API) and tests/unit/cli/send-telegram-normalize.test.ts (literal \n / \t
 * normalization for codex-runtime agents). Runs entirely without a real
 * Discord token or network: the REST client is replaced with a vi.fn() stub,
 * and the gateway is never touched here.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runTestSend } from '../../../src/cli/discord';
import { DiscordRestAPI } from '../../../src/discord/rest';
import {
  normalizeOutboundText,
  truncateForDiscord,
  DISCORD_MAX_MESSAGE_CHARS,
} from '../../../src/discord/normalize';
import { loadDiscordConfig } from '../../../src/discord/config';

describe('runTestSend (Discord outbound payloads)', () => {
  let api: { createMessage: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    api = {
      createMessage: vi
        .fn()
        .mockResolvedValue({ id: 'm1', channel_id: 'C1' }),
    };
  });

  it('posts to an explicit channel with normalized content', async () => {
    await runTestSend({ channel: 'C1', text: 'hi', env: {} }, api as never);
    expect(api.createMessage).toHaveBeenCalledWith({
      channel: 'C1',
      content: 'hi',
    });
  });

  it('falls back to DISCORD_ORCH_CHANNEL_ID when no channel is given', async () => {
    await runTestSend(
      { text: 'orch', env: { DISCORD_ORCH_CHANNEL_ID: 'ORCH123' } },
      api as never,
    );
    expect(api.createMessage).toHaveBeenCalledWith({
      channel: 'ORCH123',
      content: 'orch',
    });
  });

  it('attaches message_reference when --reply-to is set', async () => {
    await runTestSend(
      { channel: 'C1', text: 'reply', replyTo: 'M9', env: {} },
      api as never,
    );
    expect(api.createMessage).toHaveBeenCalledWith({
      channel: 'C1',
      content: 'reply',
      replyToMessageId: 'M9',
    });
  });

  it('throws when no channel can be resolved', async () => {
    await expect(
      runTestSend({ text: 'x', env: {} }, api as never),
    ).rejects.toThrow(/no channel/);
    expect(api.createMessage).not.toHaveBeenCalled();
  });

  it('converts codex-style literal \\n into real newlines before sending', async () => {
    await runTestSend({ channel: 'C1', text: 'hello\\n\\nworld', env: {} }, api as never);
    const content = api.createMessage.mock.calls[0][0].content as string;
    expect(content).toBe('hello\n\nworld');
    expect(content).not.toContain('\\n');
  });

  it('converts codex-style literal \\t into real tabs before sending', async () => {
    await runTestSend({ channel: 'C1', text: 'col1\\tcol2', env: {} }, api as never);
    const content = api.createMessage.mock.calls[0][0].content as string;
    expect(content).toBe('col1\tcol2');
  });

  it('leaves real newlines untouched (claude-runtime no-op)', async () => {
    await runTestSend({ channel: 'C1', text: 'line1\nline2', env: {} }, api as never);
    const content = api.createMessage.mock.calls[0][0].content as string;
    expect(content).toBe('line1\nline2');
  });

  it('preserves other escape sequences verbatim (e.g. \\r)', async () => {
    await runTestSend({ channel: 'C1', text: 'has\\rcarriage', env: {} }, api as never);
    const content = api.createMessage.mock.calls[0][0].content as string;
    expect(content).toBe('has\\rcarriage');
  });
});

describe('normalizeOutboundText', () => {
  it('handles mixed literal and real newlines in one message', () => {
    expect(normalizeOutboundText('real\nthen\\nliteral')).toBe(
      'real\nthen\nliteral',
    );
  });
});

describe('truncateForDiscord', () => {
  it('passes short messages through unchanged', () => {
    expect(truncateForDiscord('short')).toBe('short');
  });

  it('clips at the 2000-char limit with a marker', () => {
    const long = 'a'.repeat(5000);
    const out = truncateForDiscord(long);
    expect(out.length).toBe(DISCORD_MAX_MESSAGE_CHARS);
    expect(out.endsWith('...(truncated)')).toBe(true);
  });
});

describe('loadDiscordConfig', () => {
  it('returns null when token is missing', () => {
    expect(loadDiscordConfig({ DISCORD_ORCH_CHANNEL_ID: 'C1' })).toBeNull();
  });

  it('returns null when channel is missing', () => {
    expect(loadDiscordConfig({ DISCORD_BOT_TOKEN: 't' })).toBeNull();
  });

  it('returns trimmed config when both are present', () => {
    expect(
      loadDiscordConfig({
        DISCORD_BOT_TOKEN: ' tok ',
        DISCORD_ORCH_CHANNEL_ID: ' C1 ',
      }),
    ).toEqual({ botToken: 'tok', orchChannelId: 'C1' });
  });
});

describe('DiscordRestAPI payload shape', () => {
  it('builds a Bot-auth createMessage request against the mock REST base', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ id: 'm1', channel_id: 'C1' }),
    });
    const orig = globalThis.fetch;
    (globalThis as { fetch: unknown }).fetch = fetchSpy;
    try {
      const api = new DiscordRestAPI('tok', 'http://localhost:1');
      const res = await api.createMessage({ channel: 'C1', content: 'hi' });
      expect(res).toEqual({ id: 'm1', channel_id: 'C1' });
      const [url, init] = fetchSpy.mock.calls[0];
      expect(url).toBe('http://localhost:1/channels/C1/messages');
      expect((init as RequestInit).method).toBe('POST');
      expect((init as { headers: Record<string, string> }).headers.Authorization).toBe(
        'Bot tok',
      );
      expect(JSON.parse((init as { body: string }).body)).toEqual({ content: 'hi' });
    } finally {
      (globalThis as { fetch: unknown }).fetch = orig;
    }
  });

  it('includes message_reference with fail_if_not_exists:false on reply', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ id: 'm2', channel_id: 'C1' }),
    });
    const orig = globalThis.fetch;
    (globalThis as { fetch: unknown }).fetch = fetchSpy;
    try {
      const api = new DiscordRestAPI('tok', 'http://localhost:1');
      await api.createMessage({ channel: 'C1', content: 'hi', replyToMessageId: 'M9' });
      const body = JSON.parse((fetchSpy.mock.calls[0][1] as { body: string }).body);
      expect(body.message_reference).toEqual({
        message_id: 'M9',
        fail_if_not_exists: false,
      });
    } finally {
      (globalThis as { fetch: unknown }).fetch = orig;
    }
  });

  it('throws a descriptive error on a non-2xx response', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => JSON.stringify({ message: '401: Unauthorized' }),
    });
    const orig = globalThis.fetch;
    (globalThis as { fetch: unknown }).fetch = fetchSpy;
    try {
      const api = new DiscordRestAPI('bad', 'http://localhost:1');
      await expect(
        api.createMessage({ channel: 'C1', content: 'hi' }),
      ).rejects.toThrow(/401: Unauthorized/);
    } finally {
      (globalThis as { fetch: unknown }).fetch = orig;
    }
  });
});
