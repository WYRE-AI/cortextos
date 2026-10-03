/**
 * Slack Web API client using built-in fetch (Node.js 20+).
 * No external dependencies.
 *
 * Only the subset we need for SP3a: postMessage, update, files.upload,
 * conversations.list. SP3b adds Socket Mode; SP3c adds Block Kit + interactive
 * acks via this same client.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * RUNTIME AGENT IDENTITY — the ONLY source an outbound chat.postMessage's
 * `username` can ever come from.
 *
 * Ported concept from grandamenium/cortextos@761e949fd's RUNTIME_AGENT_NAME
 * (task_1790871245210_64848240's identity-gate half). The finding that
 * motivated this: `cortextos slack send <channel> <text> --as <agent>`
 * previously loaded `--as <agent>`'s own slack.json and posted under
 * WHATEVER display_name was in that file (identity.ts's old
 * loadSlackIdentity) — with no check that the calling process actually
 * WAS that agent. slack.json is routine org config, not a secret; any
 * process that can read another agent's directory (every agent, by
 * design) could post a message that reads as having come from a
 * different, possibly more-trusted agent.
 *
 * Captured ONCE at module load from the daemon-provisioned agent context
 * (CTX_AGENT_NAME in the environment, else the agent dir's .cortextos-env
 * file), into a module-private primitive const:
 *   - cannot be MINTED: postMessage's request type has no username field
 *     for a caller to set;
 *   - cannot be MUTATED: a const string binding, and post-load mutation of
 *     process.env or cwd cannot re-run this capture.
 * The deliberately-omitted cwd-basename fallback is omitted because it IS
 * mintable by cwd choice (same reasoning upstream documents for the same
 * omission).
 *
 * Boundary honestly stated: this fences API CALLERS in a daemon-provisioned
 * process. It does not (and cannot) stop a process that genuinely controls
 * its own CTX_AGENT_NAME at start time, or that holds the raw bot token and
 * calls the Slack API directly, bypassing this module entirely.
 */
const RUNTIME_AGENT_NAME: string | undefined = (() => {
  try {
    const fromEnv = process.env.CTX_AGENT_NAME?.trim();
    if (fromEnv) return fromEnv;
    const envPath = join(process.cwd(), '.cortextos-env');
    if (existsSync(envPath)) {
      const match = readFileSync(envPath, 'utf-8').match(/^CTX_AGENT_NAME=(.+)$/m);
      if (match?.[1]?.trim()) return match[1].trim();
    }
    return undefined;
  } catch {
    return undefined;
  }
})();

export interface PostMessageRequest {
  channel: string;
  text: string;
  thread_ts?: string;
  /** Block Kit blocks; SP3c uses these for interactive approvals. */
  blocks?: unknown[];
}

export interface PostMessageResponse {
  ok: true;
  channel: string;
  ts: string;
}

export interface Channel {
  id: string;
  name: string;
  is_channel?: boolean;
  is_private?: boolean;
  is_member?: boolean;
}

export interface SlackUserInfo {
  id: string;
  name?: string;
  real_name?: string;
}

export class SlackAPI {
  constructor(private readonly token: string) {
    if (!token) throw new Error('SlackAPI: token is required');
  }

  /** Generic Slack API call helper — handles auth, JSON, and ok=false errors. */
  private async call<T>(method: string, body: Record<string, unknown>): Promise<T> {
    const res = await fetch(`https://slack.com/api/${method}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.token}`,
        'Content-Type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify(body),
    });
    const json = (await res.json()) as { ok: boolean; error?: string } & T;
    if (!json.ok) {
      throw new Error(`slack ${method}: ${json.error ?? 'unknown error'}`);
    }
    return json;
  }

  /**
   * username is deliberately NOT a parameter — see RUNTIME_AGENT_NAME above.
   * Icon overrides are also not supported: upstream suppresses custom
   * icon_emoji/icon_url pending a brand review, and that review has not
   * happened in this fork either, so there is nothing to port yet. Omitting
   * username entirely when RUNTIME_AGENT_NAME is unavailable (e.g. a human
   * operator running the CLI outside any agent's process context) falls
   * back to the Slack app's own configured bot identity, never to a
   * caller-suppliable string.
   *
   * The body is built by EXPLICIT field whitelist, not `{ ...req }` — the
   * type system keeps a well-typed caller from passing username/icon_emoji/
   * icon_url, but TypeScript types are compile-time only, so a spread would
   * still forward those fields straight through for any caller that reaches
   * this method with a loosely-typed or `as any` request object (exactly
   * the shape the identity gate exists to close). A regression test in
   * api.test.ts locks this in.
   */
  async postMessage(req: PostMessageRequest): Promise<PostMessageResponse> {
    const body: Record<string, unknown> = { channel: req.channel, text: req.text };
    if (req.thread_ts !== undefined) body.thread_ts = req.thread_ts;
    if (req.blocks !== undefined) body.blocks = req.blocks;
    if (RUNTIME_AGENT_NAME !== undefined) body.username = RUNTIME_AGENT_NAME;
    return this.call<PostMessageResponse>('chat.postMessage', body);
  }

  /** Used by SP3b's dispatcher to resolve a display name for the injected header. */
  async getUserInfo(userId: string): Promise<SlackUserInfo> {
    const resp = await this.call<{ user: SlackUserInfo }>('users.info', { user: userId });
    return resp.user;
  }

  async listChannels(): Promise<Channel[]> {
    const out: Channel[] = [];
    let cursor: string | undefined = undefined;
    do {
      const body: Record<string, unknown> = { limit: 200, types: 'public_channel,private_channel' };
      if (cursor) body.cursor = cursor;
      const resp = await this.call<{
        channels: Channel[];
        response_metadata?: { next_cursor?: string };
      }>('conversations.list', body);
      out.push(...resp.channels);
      cursor = resp.response_metadata?.next_cursor || undefined;
    } while (cursor);
    return out;
  }
}
