/**
 * SP3b bus dispatcher — routes one inbound Slack message to every agent
 * whose slack.json says it should receive it, exactly mirroring how
 * fast-checker.ts injects Telegram messages into an agent's PTY (see
 * queueTelegramMessage / formatTelegramTextMessage).
 *
 * Two independent gates, both required (fail-closed — see identity.ts's
 * isSlackUserAllowed docblock for why channel membership alone isn't
 * enough):
 *   1. channel gate — event.channel is in the agent's slack.json
 *      allowed_channels.
 *   2. user gate — event.user is in the agent's slack.json allowed_users.
 *
 * Channels are N:1 (many agents can watch the same channel, unlike
 * Telegram's inherent 1:1 bot-per-chat), so this delivers to EVERY matching
 * agent, not just the first.
 *
 * A third, independent step applies regardless of the gates above: the
 * message text is run through `redactInboundText` (SSN + structural
 * credential-shape redaction, ported from grandamenium/cortextos@d647b862d)
 * before it is ever formatted or queued, so a sensitive value in an allowed
 * inbound message never reaches an agent's PTY or persisted stdout.log in
 * the clear.
 */
import { FastChecker } from '../daemon/fast-checker.js';
import { loadSlackConfig, isSlackUserAllowed } from './identity.js';
import { redactInboundText } from './slack-redact.js';
import type { SlackSocketMessageEvent } from './socket-mode.js';

export interface DispatchTarget {
  name: string;
  checker: FastChecker;
}

/** Resolves a Slack user id to a display name for the injected header. Cacheable — see resolveUserName. */
export type UserNameResolver = (userId: string) => Promise<string>;

export interface DispatchResult {
  delivered: string[]; // agent names the message was queued to
  skippedNoChannelMatch: boolean; // no agent has this channel in allowed_channels
  skippedUserNotAllowed: string[]; // agent names that matched on channel but rejected on user
}

/**
 * Route one normalized Slack event to every agent configured for it.
 *
 * `frameworkRoot`/`org` are passed straight to loadSlackConfig per target —
 * callers already have these from the daemon's agent registry, so this
 * function stays a pure router rather than re-deriving them.
 */
export async function dispatchSlackMessage(
  event: SlackSocketMessageEvent,
  targets: DispatchTarget[],
  frameworkRoot: string,
  org: string,
  resolveUserName: UserNameResolver,
): Promise<DispatchResult> {
  const result: DispatchResult = {
    delivered: [],
    skippedNoChannelMatch: false,
    skippedUserNotAllowed: [],
  };

  const matchingChannel = targets.filter((t) => {
    const cfg = loadSlackConfig(frameworkRoot, org, t.name);
    return !!cfg && cfg.allowed_channels.includes(event.channel);
  });

  if (matchingChannel.length === 0) {
    result.skippedNoChannelMatch = true;
    return result;
  }

  const displayName = await resolveUserName(event.user);
  // Ported from grandamenium/cortextos@d647b862d: scrub SSNs and
  // structurally-unambiguous credential shapes (Slack/Telegram/Anthropic/
  // GitHub/AWS token shapes) out of the inbound text BEFORE it is formatted
  // and queued to any agent's PTY — a sensitive value must never reach the
  // durable queue or persisted stdout.log in the clear. Computed once, not
  // per-target: the text is identical for every delivery target below.
  const redactedText = redactInboundText(event.text);

  for (const target of matchingChannel) {
    const cfg = loadSlackConfig(frameworkRoot, org, target.name);
    // cfg is guaranteed non-null here (filtered above), but re-check
    // narrows the type without a non-null assertion.
    if (!cfg) continue;

    if (!isSlackUserAllowed(cfg, event.team, event.user)) {
      result.skippedUserNotAllowed.push(target.name);
      continue;
    }

    const formatted = FastChecker.formatSlackTextMessage(
      displayName,
      event.channel,
      redactedText,
      target.name,
    );

    // Dedup on the Slack message identity (channel + ts), not the formatted
    // text: post-redaction, two messages differing only in a redacted value
    // format identically and would wrongly collapse. channel+ts also covers
    // Socket Mode redeliveries and the message/app_mention pair for one post.
    if (target.checker.isDuplicate(`slack:${event.channel}:${event.ts}`)) continue;
    target.checker.queueSlackMessage(formatted);
    result.delivered.push(target.name);
  }

  return result;
}

/**
 * TTL-cached users.info lookup — avoids one Slack API call per message for
 * frequently-messaging users. Not exported as a class: the daemon holds one
 * closure-captured cache per SlackAPI instance, same lifetime as the
 * connection itself.
 */
export function makeUserNameResolver(
  fetchUserInfo: (userId: string) => Promise<{ real_name?: string; name?: string } | null>,
  ttlMs = 10 * 60 * 1000,
): UserNameResolver {
  const cache = new Map<string, { name: string; expiresAt: number }>();
  return async (userId: string): Promise<string> => {
    const cached = cache.get(userId);
    if (cached && cached.expiresAt > Date.now()) return cached.name;
    let name = userId; // fall back to the raw id if the lookup fails
    try {
      const info = await fetchUserInfo(userId);
      if (info) name = info.real_name || info.name || userId;
    } catch {
      /* fall back to raw id — never block delivery on a display-name lookup */
    }
    cache.set(userId, { name, expiresAt: Date.now() + ttlMs });
    return name;
  };
}
