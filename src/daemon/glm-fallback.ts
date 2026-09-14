// src/daemon/glm-fallback.ts
// Tier 2 cross-provider fallback (Z.ai GLM-5.3), per the design doc:
// orgs/wyre/deliverables/infra/task_1789176721585_85041330/glm-5.3-fallback-design.md
//
// Entered ONLY from rotation-manager's existing "every Tier 1 account
// exhausted" branch — never a standalone watcher (design Q2: a new observer
// drawn from the same failure-prone population adds false coverage, not
// real coverage).
//
// SHIP DISABLED. Do not set `enabled: true` in glm-fallback-config.json until
// the validation suite (tool-call fidelity, PTY/banner compat, restart
// semantics — design Q3) has passed against a throwaway canary agent. This
// module being wired in is not the same as it being trusted.

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { execFileSync } from 'child_process';
import { atomicWriteSync, ensureDir } from '../utils/atomic.js';

export interface GlmFallbackConfig {
  enabled: boolean;
  /**
   * Agents that must never fall to an unvalidated provider, even when every
   * Tier 1 account is exhausted. Design Q4: Aaron-facing agents (customer/
   * stakeholder-visible output) stay on Tier 1 and wait — even a longer wait
   * — rather than risk output quality on a model with no track record here.
   */
  excludedAgents: string[];
}

export interface GlmFallbackActiveEntry {
  since: number; // epoch ms
  reason: string;
}

export interface GlmFallbackState {
  active: Record<string, GlmFallbackActiveEntry>;
}

export const DEFAULT_GLM_FALLBACK_CONFIG: GlmFallbackConfig = {
  enabled: false,
  excludedAgents: ['pearl', 'marketing', 'scribe'],
};

const ZAI_BASE_URL = 'https://api.z.ai/api/anthropic';
const ZAI_MODEL_ALIAS = 'glm-5.3';
// GLM inference latency under this fleet's load is unverified (design Q3).
// Community-documented Z.ai/Claude-Code setups use a much longer timeout
// than Claude Code's own default for exactly this reason. A long timeout
// only relaxes a ceiling — it can't mask a real hang the way a short one
// would, so it's the safe direction to be wrong in before validation runs.
const ZAI_API_TIMEOUT_MS = '3000000';

function glmDir(ctxRoot: string): string {
  return join(ctxRoot, 'state', 'glm-fallback');
}

function configPath(ctxRoot: string): string {
  return join(glmDir(ctxRoot), 'config.json');
}

function statePath(ctxRoot: string): string {
  return join(glmDir(ctxRoot), 'state.json');
}

/** Missing file and malformed file must behave identically: disabled. Never fail open. */
export function loadGlmFallbackConfig(ctxRoot: string): GlmFallbackConfig {
  const path = configPath(ctxRoot);
  if (!existsSync(path)) return { ...DEFAULT_GLM_FALLBACK_CONFIG };
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8'));
    return {
      enabled: typeof parsed.enabled === 'boolean' ? parsed.enabled : DEFAULT_GLM_FALLBACK_CONFIG.enabled,
      excludedAgents: Array.isArray(parsed.excludedAgents)
        ? parsed.excludedAgents
        : DEFAULT_GLM_FALLBACK_CONFIG.excludedAgents,
    };
  } catch {
    return { ...DEFAULT_GLM_FALLBACK_CONFIG };
  }
}

export function loadGlmFallbackState(ctxRoot: string): GlmFallbackState {
  const path = statePath(ctxRoot);
  if (!existsSync(path)) return { active: {} };
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8'));
    return { active: parsed && typeof parsed.active === 'object' && parsed.active !== null ? parsed.active : {} };
  } catch {
    return { active: {} };
  }
}

function saveGlmFallbackState(ctxRoot: string, state: GlmFallbackState): void {
  ensureDir(glmDir(ctxRoot));
  atomicWriteSync(statePath(ctxRoot), JSON.stringify(state, null, 2));
}

export function isGlmFallbackActive(ctxRoot: string, agentName: string): boolean {
  return agentName in loadGlmFallbackState(ctxRoot).active;
}

export function markGlmFallbackActive(
  ctxRoot: string,
  agentName: string,
  reason: string,
  now: () => number = Date.now,
): void {
  const state = loadGlmFallbackState(ctxRoot);
  state.active[agentName] = { since: now(), reason };
  saveGlmFallbackState(ctxRoot, state);
}

export function clearGlmFallbackActive(ctxRoot: string, agentName: string): void {
  const state = loadGlmFallbackState(ctxRoot);
  if (agentName in state.active) {
    delete state.active[agentName];
    saveGlmFallbackState(ctxRoot, state);
  }
}

/** An agent coming back onto a real Tier 1 token must never keep serving off a stale GLM override. */
export function clearGlmFallbackForRecoveredAgents(ctxRoot: string, agents: string[]): void {
  for (const agent of agents) clearGlmFallbackActive(ctxRoot, agent);
}

/** Pure — no I/O. The env block a GLM-5.3-fallback agent needs, given an already-fetched key. */
export function buildGlmEnvVars(apiKey: string): Record<string, string> {
  return {
    ANTHROPIC_BASE_URL: ZAI_BASE_URL,
    // Z.ai's Claude-Code-compat endpoint expects a Bearer token: Claude Code
    // sends ANTHROPIC_AUTH_TOKEN as `Authorization: Bearer <token>`, distinct
    // from ANTHROPIC_API_KEY's `x-api-key` header. Verified against Z.ai's
    // own documented Claude Code setup (2026-09-14) — the referenced design
    // article didn't name the exact var.
    ANTHROPIC_AUTH_TOKEN: apiKey,
    ANTHROPIC_DEFAULT_OPUS_MODEL: ZAI_MODEL_ALIAS,
    ANTHROPIC_DEFAULT_SONNET_MODEL: ZAI_MODEL_ALIAS,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: ZAI_MODEL_ALIAS,
    API_TIMEOUT_MS: ZAI_API_TIMEOUT_MS,
  };
}

export type SecretFetcher = () => string;

function defaultFetchZaiApiKey(): string {
  // Lives in `--context conduit`, NOT cortex-secret's default context —
  // verified directly 2026-09-14 (boss's "confirmed readable" didn't name
  // the context; checking independently surfaced this before it could bite
  // a runtime fetch the way this org's wrong-context-secret history
  // repeatedly documents).
  return execFileSync('cortex-secret', ['get', 'ZAI_API_KEY', '--context', 'conduit'], {
    encoding: 'utf-8',
    timeout: 15_000,
  });
}

/**
 * Fetch the Z.ai key at the moment it's needed. Never persisted to a file,
 * never written into any .env — the caller merges the returned value
 * straight into an in-memory PTY env object. Fails closed: any error (auth
 * failure, network, missing config) returns null rather than throwing or
 * falling back to a placeholder — per this org's cortex-secret doctrine,
 * a missing secret is a blocker to surface, not to route around.
 */
export function fetchZaiApiKey(exec: SecretFetcher = defaultFetchZaiApiKey): string | null {
  try {
    const value = exec().trim();
    return value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

export interface GlmFallbackAttemptResult {
  entered: string[];
  excluded: string[];
  skippedReason?: 'disabled' | 'key-fetch-failed' | 'no-eligible-agents';
}

/**
 * Tier 2 trigger. Call ONLY from rotation-manager's "every Tier 1 account
 * exhausted" halt branch, with the agents currently blocked there.
 */
export function attemptGlmFallback(
  ctxRoot: string,
  blockedAgents: string[],
  reason: string,
  opts: { fetchKey?: SecretFetcher; log: (msg: string) => void; now?: () => number },
): GlmFallbackAttemptResult {
  const config = loadGlmFallbackConfig(ctxRoot);
  const excluded = blockedAgents.filter(a => config.excludedAgents.includes(a));

  if (!config.enabled) {
    return { entered: [], excluded, skippedReason: 'disabled' };
  }

  const eligible = blockedAgents.filter(a => !config.excludedAgents.includes(a));
  const alreadyActive = loadGlmFallbackState(ctxRoot).active;
  const toEnter = eligible.filter(a => !(a in alreadyActive));

  if (toEnter.length === 0) {
    return { entered: [], excluded, skippedReason: 'no-eligible-agents' };
  }

  const apiKey = fetchZaiApiKey(opts.fetchKey);
  if (!apiKey) {
    opts.log(
      '[glm-fallback] ZAI_API_KEY fetch failed (cortex-secret get ZAI_API_KEY --context conduit) — ' +
        'cannot enter Tier 2, staying on Tier 1 halt',
    );
    return { entered: [], excluded, skippedReason: 'key-fetch-failed' };
  }

  for (const agent of toEnter) markGlmFallbackActive(ctxRoot, agent, reason, opts.now);
  opts.log(
    `[glm-fallback] Tier 2 entered for: ${toEnter.join(', ')} (${reason}). ` +
      `Excluded, held on Tier 1: ${excluded.join(', ') || 'none'}.`,
  );
  return { entered: toEnter, excluded };
}

/**
 * Called from the default Claude Code PTY's env-build path on every spawn.
 * No-op (one cheap existsSync + small JSON read) for the overwhelming
 * majority of spawns, where the agent isn't on Tier 2 — must stay cheap
 * since it runs unconditionally, not just when GLM fallback is in play.
 */
export function applyGlmFallbackEnv(
  env: Record<string, string>,
  ctxRoot: string,
  agentName: string,
  opts: { fetchKey?: SecretFetcher; log?: (msg: string) => void } = {},
): void {
  const log = opts.log ?? ((msg: string) => { try { console.error(msg); } catch { /* ignore */ } });
  if (!isGlmFallbackActive(ctxRoot, agentName)) return;
  // Fail-safe kill switch: if the global flag has since been turned off,
  // stop applying the override even for an agent still marked active in
  // state — an operator disabling Tier 2 must take effect immediately, not
  // only for agents that haven't restarted yet.
  if (!loadGlmFallbackConfig(ctxRoot).enabled) return;

  const apiKey = fetchZaiApiKey(opts.fetchKey);
  if (!apiKey) {
    log(`[glm-fallback] ${agentName} is marked Tier-2-active but the key fetch failed at spawn time — spawning with whatever Tier 1 token is already in .env (likely stale/exhausted) rather than a broken env.`);
    return;
  }
  Object.assign(env, buildGlmEnvVars(apiKey));
}
