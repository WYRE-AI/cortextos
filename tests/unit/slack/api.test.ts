import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { SlackAPI as SlackAPIType } from '../../../src/slack/api';

// RUNTIME_AGENT_NAME (src/slack/api.ts) is captured ONCE at module load —
// that immutability is the whole point of the identity-gate hardening (a
// later env mutation must not be able to re-trigger the capture). Testing
// both branches therefore requires a FRESH module instance per test, with
// CTX_AGENT_NAME set before that fresh import — vi.resetModules() + a
// dynamic import, not the usual static top-of-file import. (A static
// import would also silently inherit whatever CTX_AGENT_NAME happens to be
// set in the shell actually running the test suite, which is a real risk
// here: every cortextOS agent's own session has CTX_AGENT_NAME set.)
async function freshSlackAPI(agentName: string | undefined, token = 'xoxb-abc'): Promise<SlackAPIType> {
  if (agentName === undefined) delete process.env.CTX_AGENT_NAME;
  else process.env.CTX_AGENT_NAME = agentName;
  vi.resetModules();
  const { SlackAPI } = await import('../../../src/slack/api');
  return new SlackAPI(token);
}

describe('SlackAPI', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  const originalCtxAgentName = process.env.CTX_AGENT_NAME;

  beforeEach(() => {
    fetchMock = vi.fn();
    global.fetch = fetchMock as any;
  });

  afterEach(() => {
    if (originalCtxAgentName === undefined) delete process.env.CTX_AGENT_NAME;
    else process.env.CTX_AGENT_NAME = originalCtxAgentName;
    vi.resetModules();
  });

  describe('postMessage', () => {
    it('POSTs to chat.postMessage with the bot token and json body, username from RUNTIME_AGENT_NAME', async () => {
      fetchMock.mockResolvedValue({
        ok: true,
        json: async () => ({ ok: true, channel: 'C1', ts: '1.0' }),
      });
      const api = await freshSlackAPI('boss');
      const res = await api.postMessage({ channel: 'C1', text: 'hello' });
      expect(res).toEqual({ ok: true, channel: 'C1', ts: '1.0' });
      expect(fetchMock).toHaveBeenCalledWith(
        'https://slack.com/api/chat.postMessage',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            Authorization: 'Bearer xoxb-abc',
            'Content-Type': 'application/json; charset=utf-8',
          }),
          body: JSON.stringify({ channel: 'C1', text: 'hello', username: 'boss' }),
        }),
      );
    });

    it('omits username entirely when CTX_AGENT_NAME is unset (no caller-suppliable fallback)', async () => {
      fetchMock.mockResolvedValue({ ok: true, json: async () => ({ ok: true, channel: 'C1', ts: '1' }) });
      const api = await freshSlackAPI(undefined);
      await api.postMessage({ channel: 'C1', text: 'hello' });
      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body).toEqual({ channel: 'C1', text: 'hello' });
      expect(body.username).toBeUndefined();
    });

    it('throws on Slack API error (ok=false)', async () => {
      fetchMock.mockResolvedValue({
        ok: true,
        json: async () => ({ ok: false, error: 'channel_not_found' }),
      });
      const api = await freshSlackAPI('boss');
      await expect(api.postMessage({ channel: 'C1', text: 'x' })).rejects.toThrow(
        /channel_not_found/,
      );
    });

    it('identity-gate regression guard: a caller-supplied username/icon_emoji on the request object has no effect', async () => {
      fetchMock.mockResolvedValue({ ok: true, json: async () => ({ ok: true, channel: 'C1', ts: '1' }) });
      const api = await freshSlackAPI('dev'); // this process IS dev
      // PostMessageRequest's type no longer HAS a username/icon_emoji field —
      // the `as any` here simulates a caller trying to force one anyway
      // (e.g. through a loosely-typed call site), which is exactly the
      // shape the identity gate exists to close.
      await api.postMessage({ channel: 'C1', text: 'hi', username: 'boss', icon_emoji: ':robot_face:' } as any);
      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.username).toBe('dev'); // RUNTIME_AGENT_NAME wins, not the spoofed value
      expect(body.icon_emoji).toBeUndefined(); // icons are suppressed entirely, not passed through
    });
  });

  describe('listChannels', () => {
    it('paginates with next_cursor until empty', async () => {
      fetchMock
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            ok: true,
            channels: [{ id: 'C1', name: 'general' }],
            response_metadata: { next_cursor: 'CURSOR' },
          }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            ok: true,
            channels: [{ id: 'C2', name: 'random' }],
            response_metadata: { next_cursor: '' },
          }),
        });
      const api = await freshSlackAPI('boss');
      const channels = await api.listChannels();
      expect(channels.map((c) => c.id)).toEqual(['C1', 'C2']);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
  });
});
