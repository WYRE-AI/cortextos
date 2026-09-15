// tests/unit/glm-fallback.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  loadGlmFallbackConfig,
  loadGlmFallbackState,
  isGlmFallbackActive,
  markGlmFallbackActive,
  clearGlmFallbackActive,
  clearGlmFallbackForRecoveredAgents,
  buildGlmEnvVars,
  fetchZaiApiKey,
  attemptGlmFallback,
  applyGlmFallbackEnv,
  DEFAULT_GLM_FALLBACK_CONFIG,
} from '../../src/daemon/glm-fallback.js';

let ctxRoot: string;

beforeEach(() => {
  ctxRoot = mkdtempSync(join(tmpdir(), 'glm-ctx-'));
});

describe('loadGlmFallbackConfig', () => {
  it('defaults to disabled when no config file exists', () => {
    expect(loadGlmFallbackConfig(ctxRoot)).toEqual(DEFAULT_GLM_FALLBACK_CONFIG);
  });

  it('defaults to disabled (fails closed, not open) when the config file is malformed JSON', () => {
    mkdirSync(join(ctxRoot, 'state', 'glm-fallback'), { recursive: true });
    writeFileSync(join(ctxRoot, 'state', 'glm-fallback', 'config.json'), '{not json');
    expect(loadGlmFallbackConfig(ctxRoot).enabled).toBe(false);
  });

  it('reads an explicit enabled:true config', () => {
    mkdirSync(join(ctxRoot, 'state', 'glm-fallback'), { recursive: true });
    writeFileSync(
      join(ctxRoot, 'state', 'glm-fallback', 'config.json'),
      JSON.stringify({ enabled: true, excludedAgents: ['pearl'] }),
    );
    const cfg = loadGlmFallbackConfig(ctxRoot);
    expect(cfg.enabled).toBe(true);
    expect(cfg.excludedAgents).toEqual(['pearl']);
  });
});

describe('GLM fallback active-state tracking', () => {
  it('is not active for an agent with no state file', () => {
    expect(isGlmFallbackActive(ctxRoot, 'boss')).toBe(false);
  });

  it('marks and clears an agent, persisted to disk', () => {
    markGlmFallbackActive(ctxRoot, 'boss', 'all tier1 exhausted', () => 1000);
    expect(isGlmFallbackActive(ctxRoot, 'boss')).toBe(true);
    const state = loadGlmFallbackState(ctxRoot);
    expect(state.active.boss).toEqual({ since: 1000, reason: 'all tier1 exhausted' });

    clearGlmFallbackActive(ctxRoot, 'boss');
    expect(isGlmFallbackActive(ctxRoot, 'boss')).toBe(false);
  });

  it('clearGlmFallbackForRecoveredAgents clears only the named agents, leaves others untouched', () => {
    markGlmFallbackActive(ctxRoot, 'boss', 'r', () => 1);
    markGlmFallbackActive(ctxRoot, 'dev', 'r', () => 1);
    clearGlmFallbackForRecoveredAgents(ctxRoot, ['boss']);
    expect(isGlmFallbackActive(ctxRoot, 'boss')).toBe(false);
    expect(isGlmFallbackActive(ctxRoot, 'dev')).toBe(true);
  });
});

describe('buildGlmEnvVars', () => {
  it('is pure and returns the exact env block Z.ai/Claude Code needs', () => {
    expect(buildGlmEnvVars('secret-key-123')).toEqual({
      ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic',
      ANTHROPIC_AUTH_TOKEN: 'secret-key-123',
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'glm-5.3',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'glm-5.3',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'glm-5.3',
      API_TIMEOUT_MS: '3000000',
    });
  });
});

describe('fetchZaiApiKey', () => {
  it('returns the trimmed value on success', () => {
    expect(fetchZaiApiKey(() => 'abc123\n')).toBe('abc123');
  });

  it('returns null (fails closed) when the fetcher throws', () => {
    expect(fetchZaiApiKey(() => { throw new Error('cortex-secret: not found'); })).toBeNull();
  });

  it('returns null on an empty value rather than a blank token', () => {
    expect(fetchZaiApiKey(() => '   ')).toBeNull();
  });
});

describe('attemptGlmFallback', () => {
  function enable(excludedAgents: string[] = DEFAULT_GLM_FALLBACK_CONFIG.excludedAgents) {
    mkdirSync(join(ctxRoot, 'state', 'glm-fallback'), { recursive: true });
    writeFileSync(
      join(ctxRoot, 'state', 'glm-fallback', 'config.json'),
      JSON.stringify({ enabled: true, excludedAgents }),
    );
  }

  it('is a guaranteed no-op when disabled (no config file at all)', () => {
    const log = vi.fn();
    const result = attemptGlmFallback(ctxRoot, ['boss'], 'all exhausted', { log });
    expect(result).toEqual({ candidates: [], excluded: [], skippedReason: 'disabled' });
    expect(isGlmFallbackActive(ctxRoot, 'boss')).toBe(false);
  });

  it('excludes Aaron-facing agents by default even when enabled', () => {
    enable();
    const log = vi.fn();
    const result = attemptGlmFallback(ctxRoot, ['boss', 'pearl', 'marketing'], 'all exhausted', {
      log,
      fetchKey: () => 'key',
    });
    expect(result.candidates).toEqual(['boss']);
    expect(result.excluded.sort()).toEqual(['marketing', 'pearl']);
  });

  it('does NOT mark anyone active itself — that is the caller\'s job, only after a confirmed restart (PR #186 review fix)', () => {
    enable();
    const result = attemptGlmFallback(ctxRoot, ['boss'], 'all exhausted', { log: vi.fn(), fetchKey: () => 'key' });
    expect(result.candidates).toEqual(['boss']);
    expect(isGlmFallbackActive(ctxRoot, 'boss')).toBe(false);
  });

  it('fails closed and returns no candidates when the key fetch fails', () => {
    enable();
    const log = vi.fn();
    const result = attemptGlmFallback(ctxRoot, ['boss'], 'all exhausted', {
      log,
      fetchKey: () => { throw new Error('secret not found'); },
    });
    expect(result).toEqual({ candidates: [], excluded: [], skippedReason: 'key-fetch-failed' });
    expect(isGlmFallbackActive(ctxRoot, 'boss')).toBe(false);
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/ZAI_API_KEY fetch failed/));
  });

  it('excludes an agent already marked active from the candidate list — the caller marks after entry, this checks the caller did', () => {
    enable();
    const fetchKey = vi.fn(() => 'key');
    const result1 = attemptGlmFallback(ctxRoot, ['boss'], 'r1', { log: vi.fn(), fetchKey });
    expect(result1.candidates).toEqual(['boss']);
    // Simulate what rotation-manager does after a CONFIRMED restart.
    markGlmFallbackActive(ctxRoot, 'boss', 'r1', () => 1);

    const log2 = vi.fn();
    const result2 = attemptGlmFallback(ctxRoot, ['boss'], 'r2', { log: log2, fetchKey });
    expect(result2).toEqual({ candidates: [], excluded: [], skippedReason: 'no-eligible-agents' });
  });

  it('regression (PR #186 review, dev): an agent whose restart FAILED must remain a candidate on the next attempt, not get silently stuck forever', () => {
    // This models what a naive "mark active before restart" implementation
    // gets wrong — a real caller (rotation-manager) marks active only AFTER
    // a confirmed restartAgent success, so a restart failure leaves the
    // agent unmarked and it must show up as a candidate again here.
    enable();
    const fetchKey = vi.fn(() => 'key');
    const result1 = attemptGlmFallback(ctxRoot, ['boss'], 'r1', { log: vi.fn(), fetchKey });
    expect(result1.candidates).toEqual(['boss']);
    // Caller's restartAgent() throws — caller does NOT mark active.
    expect(isGlmFallbackActive(ctxRoot, 'boss')).toBe(false);

    const result2 = attemptGlmFallback(ctxRoot, ['boss'], 'retry', { log: vi.fn(), fetchKey });
    expect(result2.candidates).toEqual(['boss']); // still retryable, not stuck
  });
});

describe('applyGlmFallbackEnv (the PTY spawn-time hook)', () => {
  it('leaves env untouched for an agent not marked Tier-2-active — the common case', () => {
    const env: Record<string, string> = { CLAUDE_CODE_OAUTH_TOKEN: 'tok' };
    applyGlmFallbackEnv(env, ctxRoot, 'boss', { fetchKey: () => 'should-not-be-called' });
    expect(env).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: 'tok' });
  });

  it('injects the Z.ai env block for an agent marked Tier-2-active', () => {
    mkdirSync(join(ctxRoot, 'state', 'glm-fallback'), { recursive: true });
    writeFileSync(join(ctxRoot, 'state', 'glm-fallback', 'config.json'), JSON.stringify({ enabled: true, excludedAgents: [] }));
    markGlmFallbackActive(ctxRoot, 'boss', 'test', () => 1);

    const env: Record<string, string> = { CLAUDE_CODE_OAUTH_TOKEN: 'stale-tok' };
    applyGlmFallbackEnv(env, ctxRoot, 'boss', { fetchKey: () => 'zai-key' });
    expect(env.ANTHROPIC_BASE_URL).toBe('https://api.z.ai/api/anthropic');
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe('zai-key');
    expect(env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe('glm-5.3');
  });

  it('kill switch: does NOT apply the override once the global config flips back to disabled, even if state still says active', () => {
    mkdirSync(join(ctxRoot, 'state', 'glm-fallback'), { recursive: true });
    writeFileSync(join(ctxRoot, 'state', 'glm-fallback', 'config.json'), JSON.stringify({ enabled: true, excludedAgents: [] }));
    markGlmFallbackActive(ctxRoot, 'boss', 'test', () => 1);
    // Operator flips the kill switch off — state file still says active.
    writeFileSync(join(ctxRoot, 'state', 'glm-fallback', 'config.json'), JSON.stringify({ enabled: false, excludedAgents: [] }));

    const env: Record<string, string> = { CLAUDE_CODE_OAUTH_TOKEN: 'tok' };
    applyGlmFallbackEnv(env, ctxRoot, 'boss', { fetchKey: () => 'zai-key' });
    expect(env.ANTHROPIC_BASE_URL).toBeUndefined();
  });

  it('fails toward keeping the existing (likely stale) env rather than a partially-applied override when the key fetch fails at spawn time', () => {
    mkdirSync(join(ctxRoot, 'state', 'glm-fallback'), { recursive: true });
    writeFileSync(join(ctxRoot, 'state', 'glm-fallback', 'config.json'), JSON.stringify({ enabled: true, excludedAgents: [] }));
    markGlmFallbackActive(ctxRoot, 'boss', 'test', () => 1);

    const env: Record<string, string> = { CLAUDE_CODE_OAUTH_TOKEN: 'stale-tok' };
    const log = vi.fn();
    applyGlmFallbackEnv(env, ctxRoot, 'boss', { fetchKey: () => { throw new Error('down'); }, log });
    expect(env).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: 'stale-tok' });
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/key fetch failed at spawn time/));
  });
});
