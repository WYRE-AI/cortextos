// src/daemon/rotation-manager.ts
// Daemon-side OAuth rotation orchestrator (spec: docs/superpowers/specs/
// 2026-07-16-limit-rotation-design.md). Reacts to LimitEvents from PTY
// scanners, proactively preflights the active account, owns
// state/oauth/rotation-state.json. Preflight is an inference ping — the usage
// API 403s on setup-tokens (no user:profile scope).

import { existsSync, readFileSync, chmodSync } from 'fs';
import { join } from 'path';
import { atomicWriteSync, ensureDir } from '../utils/atomic.js';
import { loadAccounts, setActiveAccount, writeTokenToAgents } from '../bus/oauth.js';
import type { LimitEvent } from './limit-detector.js';

export type PreflightResult = 'ok' | 'limit' | 'error';

export interface RotationDeps {
  ctxRoot: string;
  frameworkRoot: string;
  org: string;
  now?: () => number;
  preflight: (accessToken: string) => Promise<PreflightResult>;
  restartAgent: (name: string) => Promise<void>;
  sendAlert: (text: string) => void;
  log: (msg: string) => void;
}

interface RotationState {
  limitBlocked: Record<string, { detectedAt: number; kind: string; resetAt: number | null }>;
  exhausted: Record<string, number>; // account name -> known resetAt (epoch ms)
  lastRotationAt: number;
  retryAt: number | null;
  lastPreflightAt: number;
  alertedHalt: boolean;
  // Preflight-INFRASTRUCTURE tracking (PR #54 review, F2): a run of 'error'
  // results (broken binary/model/env) looks identical to genuine exhaustion
  // ('limit') to the halt logic below unless tracked separately — and
  // alertedHalt only resets on a successful rotation, so an infra failure
  // that never produces a single 'limit'/'ok' would otherwise alert ONCE
  // and then go silent forever. consecutiveInfraTicks/lastInfraAlertAt give
  // it its own recurring, distinctly-worded alert.
  consecutiveInfraTicks: number;
  lastInfraAlertAt: number;
}

const ROTATION_COOLDOWN_MS = 10 * 60_000;
const PREFLIGHT_INTERVAL_MS = 30 * 60_000;
const RETRY_FALLBACK_MS = 30 * 60_000;
const TICK_MS = 60_000;
const INFRA_ALERT_TICK_THRESHOLD = 2; // consecutive proactive-only error ticks before alerting
const INFRA_ALERT_COOLDOWN_MS = 30 * 60_000; // re-alert cadence once confirmed broken

const EMPTY_STATE: RotationState = {
  limitBlocked: {}, exhausted: {}, lastRotationAt: 0,
  retryAt: null, lastPreflightAt: 0, alertedHalt: false,
  consecutiveInfraTicks: 0, lastInfraAlertAt: 0,
};

function statePath(ctxRoot: string): string {
  return join(ctxRoot, 'state', 'oauth', 'rotation-state.json');
}

function loadState(ctxRoot: string): RotationState {
  try {
    if (!existsSync(statePath(ctxRoot))) return { ...EMPTY_STATE, limitBlocked: {}, exhausted: {} };
    return { ...EMPTY_STATE, ...JSON.parse(readFileSync(statePath(ctxRoot), 'utf-8')) };
  } catch {
    return { ...EMPTY_STATE, limitBlocked: {}, exhausted: {} };
  }
}

/** FastChecker consult: is this agent's recovery owned by the rotation manager? */
export function isLimitBlocked(ctxRoot: string, agent: string): boolean {
  return agent in loadState(ctxRoot).limitBlocked;
}

export class RotationManager {
  private readonly now: () => number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private rotating = false;

  constructor(private readonly deps: RotationDeps) {
    this.now = deps.now ?? (() => Date.now());
  }

  private save(state: RotationState): void {
    ensureDir(join(this.deps.ctxRoot, 'state', 'oauth'));
    atomicWriteSync(statePath(this.deps.ctxRoot), JSON.stringify(state, null, 2));
    try { chmodSync(statePath(this.deps.ctxRoot), 0o600); } catch { /* ignore */ }
  }

  start(): void {
    this.timer = setInterval(() => { void this.tick(); }, TICK_MS);
    // Don't hold the process open for the rotation tick alone.
    (this.timer as { unref?: () => void }).unref?.();
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  async onLimitEvent(agent: string, ev: LimitEvent): Promise<void> {
    const t = this.now();
    const state = loadState(this.deps.ctxRoot);
    state.limitBlocked[agent] = { detectedAt: t, kind: ev.kind, resetAt: ev.resetAt };
    // The active account is exhausted by definition of the event. Always mark it
    // (fallback expiry when no hint) — the mark also tells doRotation's
    // active-recovery recheck "don't waste a ping, the banner is fresh proof".
    const active = loadAccounts(this.deps.ctxRoot)?.active;
    if (active) state.exhausted[active] = ev.resetAt ?? t + RETRY_FALLBACK_MS;
    this.save(state);
    this.deps.log(`[rotation] ${agent} limit-blocked (${ev.kind}, reset ${ev.resetAt ? new Date(ev.resetAt).toISOString() : 'unknown'})`);
    await this.attemptRotation('limit banner on ' + agent);
  }

  async tick(): Promise<void> {
    const t = this.now();
    const state = loadState(this.deps.ctxRoot);
    const blocked = Object.keys(state.limitBlocked).length > 0;

    if (blocked && (state.retryAt === null || t >= state.retryAt)) {
      await this.attemptRotation('retry for blocked agents');
      return;
    }
    if (!blocked && t - state.lastPreflightAt >= PREFLIGHT_INTERVAL_MS) {
      state.lastPreflightAt = t;
      this.save(state);
      const store = loadAccounts(this.deps.ctxRoot);
      if (!store) return;
      const result = await this.deps.preflight(store.accounts[store.active]?.access_token ?? '');
      if (result === 'limit') {
        this.deps.log(`[rotation] proactive preflight: active account "${store.active}" exhausted — rotating ahead of the fleet`);
        const s2 = loadState(this.deps.ctxRoot);
        s2.exhausted[store.active] = t + RETRY_FALLBACK_MS; // no hint from a ping; conservative
        s2.consecutiveInfraTicks = 0; // a real 'limit' proves the mechanism works
        this.save(s2);
        await this.attemptRotation('proactive preflight found active account exhausted');
      } else if (result === 'error') {
        const s2 = loadState(this.deps.ctxRoot);
        s2.consecutiveInfraTicks += 1;
        this.maybeAlertInfra(s2, t, `proactive preflight errored ${s2.consecutiveInfraTicks}x in a row on active account "${store.active}"`);
        this.save(s2);
      } else if (state.consecutiveInfraTicks > 0) {
        // 'ok' — the mechanism works; clear any infra-error streak.
        const s2 = loadState(this.deps.ctxRoot);
        s2.consecutiveInfraTicks = 0;
        this.save(s2);
      }
    }
  }

  /**
   * Distinctly-worded, separately-cooled-down alert for "the preflight
   * MECHANISM itself is broken" (bad binary path / retired model alias /
   * env issue) as opposed to "accounts are genuinely rate-limited." Without
   * this, an infra failure looks identical to exhaustion to the halt logic
   * below, alerts ONCE (alertedHalt only resets on a successful rotation),
   * and then goes silent forever even though it will never self-resolve the
   * way real exhaustion does on a reset schedule.
   */
  private maybeAlertInfra(state: RotationState, t: number, detail: string): void {
    if (state.consecutiveInfraTicks < INFRA_ALERT_TICK_THRESHOLD) return;
    if (t - state.lastInfraAlertAt < INFRA_ALERT_COOLDOWN_MS) return;
    state.lastInfraAlertAt = t;
    const msg = `⚠️ cortextOS: OAuth preflight is returning ERROR, not limit/ok (${detail}). This usually means the preflight MECHANISM itself (claude binary path or --model alias) is broken, NOT that accounts are exhausted — check account-preflight.ts's resolveClaudeBinary()/FLEET_MODEL (CTX_PREFLIGHT_MODEL). Will keep re-alerting every ${INFRA_ALERT_COOLDOWN_MS / 60_000}min until a real ok/limit result clears it.`;
    this.deps.log('[rotation] ' + msg);
    this.deps.sendAlert(msg);
  }

  /** Serialized: concurrent limit events from several agents fold into one rotation. */
  private async attemptRotation(reason: string): Promise<void> {
    if (this.rotating) return;
    this.rotating = true;
    try {
      await this.doRotation(reason);
    } finally {
      this.rotating = false;
    }
  }

  private async doRotation(reason: string): Promise<void> {
    const t = this.now();
    let state = loadState(this.deps.ctxRoot);
    if (t - state.lastRotationAt < ROTATION_COOLDOWN_MS) {
      this.deps.log('[rotation] within cooldown — blocked agents wait for next tick');
      return;
    }
    const store = loadAccounts(this.deps.ctxRoot);
    if (!store) { this.deps.log('[rotation] no accounts.json — cannot rotate'); return; }

    const candidates = Object.keys(store.accounts).filter(name => {
      if (name === store.active) return false;
      const resetAt = state.exhausted[name];
      return !(resetAt && resetAt > t);
    });

    let attempted = 0;
    let sawNonError = false; // an 'ok' or 'limit' anywhere this invocation proves the mechanism works

    for (const name of candidates) {
      const result = await this.deps.preflight(store.accounts[name].access_token);
      attempted += 1;
      if (result === 'ok') {
        state.consecutiveInfraTicks = 0;
        setActiveAccount(this.deps.ctxRoot, name, { reason, from: store.active });
        writeTokenToAgents(this.deps.frameworkRoot, this.deps.org, store.accounts[name].access_token);
        // Reload: preflights are slow (real inference); more agents may have blocked meanwhile.
        state = loadState(this.deps.ctxRoot);
        const toRestart = Object.keys(state.limitBlocked);
        for (const agent of toRestart) {
          try {
            await this.deps.restartAgent(agent);
            delete state.limitBlocked[agent];
          } catch (err) {
            this.deps.log(`[rotation] restart failed for ${agent}: ${err} — stays blocked for next tick`);
          }
        }
        state.lastRotationAt = this.now();
        state.retryAt = null;
        state.alertedHalt = false;
        state.consecutiveInfraTicks = 0;
        delete state.exhausted[name];
        this.save(state);
        const msg = `🔄 cortextOS rotated to account "${name}" (${reason}). Restarted: ${toRestart.join(', ') || 'none'}.`;
        this.deps.log('[rotation] ' + msg);
        this.deps.sendAlert(msg);
        return;
      }
      if (result === 'limit') {
        sawNonError = true;
        state.exhausted[name] = state.exhausted[name] ?? t + RETRY_FALLBACK_MS;
        this.deps.log(`[rotation] candidate "${name}" exhausted`);
      } else {
        this.deps.log(`[rotation] candidate "${name}" preflight error — skipped, not marked exhausted`);
      }
    }

    // Bench dry — the ACTIVE account may itself have recovered (5h windows reset
    // on their own). Recheck it unless a still-fresh exhausted mark says otherwise;
    // on recovery, restart blocked agents onto it — no account flip needed.
    const activeExhaustedUntil = state.exhausted[store.active] ?? 0;
    if (activeExhaustedUntil <= t) {
      const activeResult = await this.deps.preflight(store.accounts[store.active].access_token);
      attempted += 1;
      if (activeResult === 'ok') {
        state = loadState(this.deps.ctxRoot);
        const toRestart = Object.keys(state.limitBlocked);
        for (const agent of toRestart) {
          try {
            await this.deps.restartAgent(agent);
            delete state.limitBlocked[agent];
          } catch (err) {
            this.deps.log(`[rotation] restart failed for ${agent}: ${err} — stays blocked for next tick`);
          }
        }
        state.lastRotationAt = this.now();
        state.retryAt = null;
        state.alertedHalt = false;
        state.consecutiveInfraTicks = 0;
        delete state.exhausted[store.active];
        this.save(state);
        const msg = `🔄 cortextOS: active account "${store.active}" recovered (${reason}). Restarted: ${toRestart.join(', ') || 'none'}.`;
        this.deps.log('[rotation] ' + msg);
        if (toRestart.length) this.deps.sendAlert(msg);
        return;
      }
      if (activeResult === 'limit') sawNonError = true;
      const s3 = loadState(this.deps.ctxRoot);
      s3.exhausted[store.active] = t + RETRY_FALLBACK_MS;
      state.exhausted[store.active] = s3.exhausted[store.active];
      this.save(s3);
    }

    // Infra-vs-exhaustion classification for THIS invocation (F2): if every
    // single preflight attempted just now came back 'error' (never a single
    // 'ok'/'limit'), that's evidence the MECHANISM is broken, not that the
    // fleet is genuinely rate-limited — alert on that distinctly, with its
    // own recurring cadence, alongside (not instead of) the halt below.
    if (attempted > 0 && !sawNonError) {
      state.consecutiveInfraTicks += 1;
      this.maybeAlertInfra(state, t, `${attempted}/${attempted} preflight attempt(s) errored this rotation attempt (${reason})`);
    } else if (sawNonError) {
      state.consecutiveInfraTicks = 0;
    }

    // All dry: halt, single alert, schedule retry at earliest known reset.
    const knownResets = [
      ...Object.values(state.exhausted),
      ...Object.values(state.limitBlocked).map(b => b.resetAt).filter((x): x is number => x !== null),
    ];
    state.retryAt = knownResets.length ? Math.min(...knownResets) + 5 * 60_000 : t + RETRY_FALLBACK_MS;
    const alertNeeded = !state.alertedHalt;
    state.alertedHalt = true;
    this.save(state);
    const msg = `⛔ cortextOS: ALL OAuth accounts exhausted. Blocked: ${Object.keys(state.limitBlocked).join(', ') || 'none yet'}. Auto-retry at ${new Date(state.retryAt).toISOString()}.`;
    this.deps.log('[rotation] ' + msg);
    if (alertNeeded) this.deps.sendAlert(msg);
  }
}
