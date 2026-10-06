import { describe, it, expect } from 'vitest';
import { redactTokens, redactInboundText } from '../../../src/slack/slack-redact';

describe('redactInboundText', () => {
  it('redacts an SSN', () => {
    expect(redactInboundText('my ssn is 123-45-6789')).toBe('my ssn is [REDACTED-SSN]');
  });

  it('redacts a Slack bot token', () => {
    expect(redactInboundText('token: xoxb-123-abc')).toBe('token: xoxb-****');
  });

  it('redacts a Slack app token', () => {
    expect(redactInboundText('token: xapp-1-A123-456-abcdef')).toBe('token: xapp-****');
  });

  it('redacts a GitHub PAT', () => {
    expect(redactInboundText('use ghp_abc123DEF456')).toBe('use ghp_****');
  });

  it('redacts GitHub App user-to-server (ghu_) and refresh (ghr_) tokens', () => {
    expect(redactInboundText('use ghu_abc123DEF456')).toBe('use ghu_****');
    expect(redactInboundText('use ghr_abc123DEF456')).toBe('use ghr_****');
  });

  it('redacts an AWS access key id', () => {
    expect(redactInboundText('key AKIAABCDEFGHIJKLMNOP')).toBe('key AKIA****');
  });

  it('redacts a Telegram bot token', () => {
    expect(redactInboundText('123456789:AAHfoo-bar_Baz1234567890')).toBe('123456789:****');
  });

  it('redacts an Anthropic API key', () => {
    expect(redactInboundText('sk-ant-api03-abcDEF123')).toBe('sk-ant-api****');
  });

  it('does not touch ordinary prose containing "bot" or "bearer" (no loose heuristic)', () => {
    expect(redactInboundText('tell the bot not to delete')).toBe('tell the bot not to delete');
    expect(redactInboundText('bearer of bad news')).toBe('bearer of bad news');
  });

  it('leaves text with no sensitive shapes untouched', () => {
    expect(redactInboundText('hello, how are you today?')).toBe('hello, how are you today?');
  });
});

describe('redactTokens (log/error-string redaction, not for untrusted inbound text)', () => {
  it('redacts the loose Bearer heuristic', () => {
    expect(redactTokens('Authorization: Bearer abc123')).toBe('Authorization: Bearer ****');
  });

  it('redacts the loose Bot heuristic', () => {
    expect(redactTokens('Bot xyz789')).toBe('Bot ****');
  });

  it('also redacts structural credential shapes', () => {
    expect(redactTokens('xoxb-123-abc')).toBe('xoxb-****');
  });
});
