/**
 * Mock Discord gateway client for tests.
 *
 * The real Discord gateway is a persistent WebSocket speaking the Discord
 * gateway protocol — too heavy to stand up in a unit/E2E test. This mock plays
 * the same role tests/playwright/mock-telegram-server.ts plays for Telegram:
 * it lets inbound message handling be exercised WITHOUT a real bot token or
 * network.
 *
 * It implements the narrow GatewayClientLike surface that DiscordGateway
 * depends on (on/once/login/destroy) and adds an `emitMessage()` helper so a
 * test can simulate a user posting in a channel and assert that the adapter
 * routes it correctly. login() records the token but never dials out; the
 * `MockDiscordGateway` records every login/destroy so supervision logic can be
 * asserted.
 */
import { EventEmitter } from 'events';
import type {
  GatewayClientLike,
  GatewayClientFactory,
} from '../../src/discord/gateway';

export interface MockMessageInput {
  id?: string;
  channelId: string;
  authorId?: string;
  authorName?: string;
  authorIsBot?: boolean;
  content: string;
}

export class MockDiscordClient extends EventEmitter implements GatewayClientLike {
  public loggedInToken: string | null = null;
  public destroyed = false;
  public loginCount = 0;
  public destroyCount = 0;
  private nextId = 1;

  async login(token: string): Promise<string> {
    this.loggedInToken = token;
    this.loginCount += 1;
    // Defer the ready emit so listeners attached before login still fire.
    queueMicrotask(() => this.emit('ready'));
    return token;
  }

  async destroy(): Promise<void> {
    this.destroyed = true;
    this.destroyCount += 1;
    this.removeAllListeners('messageCreate');
  }

  /**
   * Simulate a user (or bot) posting a message. Produces the same flat shape
   * discord.js exposes via Message (author.bot, channelId, content) that
   * DiscordGateway.toInboundMessage understands.
   */
  emitMessage(input: MockMessageInput): string {
    const id = input.id ?? String(this.nextId++);
    this.emit('messageCreate', {
      id,
      channelId: input.channelId,
      content: input.content,
      author: {
        id: input.authorId ?? '4200',
        username: input.authorName ?? 'tester',
        bot: input.authorIsBot ?? false,
      },
    });
    return id;
  }
}

/**
 * A factory + handle pair: pass `factory` to DiscordGateway and keep `client`
 * to drive messages. The factory returns the SAME client every call (a gateway
 * is started once), so a test can emit before/after start consistently.
 */
export class MockDiscordGateway {
  public readonly client = new MockDiscordClient();

  get factory(): GatewayClientFactory {
    return () => this.client;
  }
}
