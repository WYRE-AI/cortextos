// src/daemon/rotation-manager.ts
// Daemon-side OAuth rotation orchestrator (spec: docs/superpowers/specs/
// 2026-07-16-limit-rotation-design.md). Reacts to LimitEvents from PTY
// scanners, proactively preflights the active account, owns
// state/oauth/rotation-state.json. Preflight is an inference ping — the usage
// API 403s on setup-tokens (no user:profile scope).

import { existsSync, readFileSync, readdirSync, writeFileSync, chmodSync } from 'fs';
import { join } from 'path';
import { atomicWriteSync, ensureDir } from '../utils/atomic.js';
import { loadAccounts, resolveAgentAccountName, setActiveAccount, writeTokenToAgents } from '../bus/oauth.js';
import {
  attemptGlmFallback,
  clearGlmFallbackActive,
  loadGlmFallbackState,
  markGlmFallbackActive,
  type GlmFallbackActiveEntry,
  type GlmFallbackAttemptResult,
} from './glm-fallback.js';
import type { LimitEvent } from './limit-detector.js';

export type PreflightResult = 'ok' | 'limit' | 'error';

export interface RotationDeps {
  ctxRoot: string;
  frameworkRoot: string;
  org: string;
  now?: () => number;
  preflight: (accessToken: string) => Promise<PreflightResult>;
  /**
   * Restart `name`. A resolved promise is not confirmation that a PTY is
   * running: AgentManager.restartAgent returns normally for not-found and
   * restart-lock no-ops, and AgentProcess.start() swallows spawn errors
   * (status `crashed`) then resolves. Return true only when THIS call left
   * a running PTY. Return false for those no-op / swallowed-start cases.
   * Throw only for unexpected failures — callers treat false and a throw
   * the same way: the restart did not produce a running PTY.
   */
  restartAgent: (name: string, reason?: string) => Promise<boolean>;
  sendAlert: (text: string) => void;
  log: (msg: string) => void;
  /**
   * Injection point for Tier 2 (GLM-5.3 cross-provider fallback), tests only
   * — defaults to the real glm-fallback.ts implementation. Called exactly
   * once, from the "every Tier 1 account exhausted" halt branch below.
   */
  tryGlmFallback?: (ctxRoot: string, blockedAgents: string[], reason: string, log: (msg: string) => void) => GlmFallbackAttemptResult;
  /**
   * Enumerate agents to restart when an active-account flip happens while
   * NOBODY is limitBlocked (see restartAllRunningAgents) — a proactive
   * preflight rotation, or the active account recovering with no one
   * waiting on it. writeTokenToAgents() rewrites every agent's .env
   * unconditionally regardless of which path triggered the flip, so a
   * flip with an empty restart set otherwise leaves every already-running
   * agent split-brain (new .env on disk, old credential still loaded in
   * its process) until its own unrelated next restart. Real incident:
   * 2026-10-26T22:50:49Z, 9 of 14 agents stayed split-brain for ~71
   * minutes this way (task_1793058444001_76153432).
   *
   * Defaults to every directory under frameworkRoot/orgs/{org}/agents/ —
   * the same population writeTokenToAgents() already touches
   * unconditionally, so a caller that doesn't wire in a live process
   * registry still gets the conservative "everyone whose .env we just
   * rewrote" set. The daemon wires in its real live-agent registry
   * instead (agent-manager.ts), which is more precise.
   */
  listRunningAgents?: () => string[];
}

/**
 * A raw OBSERVATION ("account X returned exhausted at T, via Y"), not a bare
 * derived verdict. A bare resetAt number (the old shape) can only ever go
 * stale silently — exactly like a stored ALL_EXHAUSTED boolean or a hand-set
 * expiry, it stops being re-derived the moment it's written. Recording
 * observedAt + source means the observation itself stays true forever, even
 * once resetAt's guess is wrong.
 */
export interface ExhaustionObservation {
  observedAt: number; // epoch ms — when this observation was made
  resetAt: number; // derived: earliest time a retry might succeed (best current guess)
  source: 'limit-banner' | 'proactive-preflight' | 'candidate-preflight' | 'active-recheck' | 'legacy-migrated';
}

export interface RotationState {
  limitBlocked: Record<string, { detectedAt: number; kind: string; resetAt: number | null }>;
  exhausted: Record<string, ExhaustionObservation>;
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

/**
 * Pre-migration state carried a bare resetAt number per account. Convert on
 * read so every caller only ever sees the observation shape — observedAt 0
 * marks "migrated, true observation time unknown" rather than fabricating one.
 */
function migrateExhausted(raw: unknown): Record<string, ExhaustionObservation> {
  const out: Record<string, ExhaustionObservation> = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === 'number') {
      out[name] = { observedAt: 0, resetAt: value, source: 'legacy-migrated' };
    } else if (value && typeof value === 'object' && typeof (value as ExhaustionObservation).resetAt === 'number') {
      out[name] = value as ExhaustionObservation;
    }
  }
  return out;
}

function loadState(ctxRoot: string): RotationState {
  try {
    if (!existsSync(statePath(ctxRoot))) return { ...EMPTY_STATE, limitBlocked: {}, exhausted: {} };
    const parsed = JSON.parse(readFileSync(statePath(ctxRoot), 'utf-8'));
    return { ...EMPTY_STATE, ...parsed, exhausted: migrateExhausted(parsed.exhausted) };
  } catch {
    return { ...EMPTY_STATE, limitBlocked: {}, exhausted: {} };
  }
}

/** Read-only accessor for callers outside the manager (e.g. list-oauth-accounts) — same migration, no side effects. */
export function loadRotationState(ctxRoot: string): RotationState {
  return loadState(ctxRoot);
}

/**
 * Default for RotationDeps.listRunningAgents — see its doc comment.
 * Deliberately NOT `discoverAllAgents` (src/utils/agent-dir.ts): that helper
 * is multi-org and enabled-agents.json-driven, a different population than
 * `writeTokenToAgents()` actually writes to (strictly `orgs/{org}/agents/*`,
 * no cross-org scan, no qualified `engineer/agent` names). Restarting a
 * population wider than what just got a new token would restart agents
 * `restartAgent()` may not even resolve by that name — reintroducing a
 * different split-brain-adjacent mismatch while fixing this one.
 */
function listAgentDirs(frameworkRoot: string, org: string): string[] {
  const agentsBase = join(frameworkRoot, 'orgs', org, 'agents');
  if (!existsSync(agentsBase)) return [];
  try {
    return readdirSync(agentsBase, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return [];
  }
}

/**
 * Has this agent produced a fresh heartbeat since `sinceMs`? Used to prune
 * stale `limitBlocked` entries for an agent that recovered via a restart
 * path OTHER than this manager's own restartBlockedAgents()/
 * restartAllRunningAgents() — e.g. the hang-detector's no-beat force-restart,
 * or a context-force-restart — so the entry never clears on its own
 * (task_1793058444001_76153432, finding 3). Deliberately reads the broad
 * `last_heartbeat` field (bumped even by the daemon's own idle watchdog
 * beat), not `last_session_heartbeat` — this only needs to know the agent's
 * process came back up and is reachable again, not that it is actively
 * processing a turn right now.
 */
function isObservedHealthySince(ctxRoot: string, agent: string, sinceMs: number): boolean {
  try {
    const hbPath = join(ctxRoot, 'state', agent, 'heartbeat.json');
    if (!existsSync(hbPath)) return false;
    const hb = JSON.parse(readFileSync(hbPath, 'utf-8')) as { last_heartbeat?: string };
    if (!hb.last_heartbeat) return false;
    return new Date(hb.last_heartbeat).getTime() > sinceMs;
  } catch {
    return false;
  }
}

/**
 * Pure derivation of retryAt from current exhausted/limitBlocked data —
 * null when neither tracks anything. Factored out so it can be recomputed
 * on every tick() (finding 4: retryAt was observed pinned at a stale value
 * across many consecutive ticks despite limitBlocked/exhausted changing
 * underneath it — doRotation's own recompute only runs when doRotation is
 * actually re-entered, which its cooldown guard and tick()'s own `t <
 * retryAt` gate can both skip for many ticks in a row), not just inside
 * doRotation's halt branch.
 */
function computeRetryAt(state: RotationState, liveAccounts: Record<string, unknown>): number | null {
  const knownResets = [
    ...Object.entries(state.exhausted)
      .filter(([name]) => name in liveAccounts)
      .map(([, rec]) => rec.resetAt),
    ...Object.values(state.limitBlocked).map((b) => b.resetAt).filter((x): x is number => x !== null),
  ];
  return knownResets.length ? Math.min(...knownResets) + 5 * 60_000 : null;
}

/**
 * Drop exhaustion marks for accounts no longer in accounts.json (retired or
 * removed). BUG FOUND 2026-08-20: a retired account's mark is never cleared
 * by the normal path (that only fires on a successful rotation INTO the
 * account, which can't happen for a retired one), so it sits in `exhausted`
 * forever. Math.min() over knownResets then picks the oldest one it can find
 * — an account retired weeks ago poisons the derived retryAt to a timestamp
 * already in the past, permanently, on every single computation. Reproduced
 * live: aaronmsachs-max20 retired 2026-08-14, its exhausted mark from
 * 2026-07-22T11:00Z was still driving retryAt on 2026-08-20 — the exact
 * "105 occurrences, retryAt reprinted unchanged" symptom.
 */
function pruneOrphanedExhaustion(state: RotationState, liveAccounts: Record<string, unknown>): boolean {
  let changed = false;
  for (const name of Object.keys(state.exhausted)) {
    if (!(name in liveAccounts)) {
      delete state.exhausted[name];
      changed = true;
    }
  }
  return changed;
}

/** FastChecker consult: is this agent's recovery owned by the rotation manager? */
export function isLimitBlocked(ctxRoot: string, agent: string): boolean {
  return agent in loadState(ctxRoot).limitBlocked;
}

export class RotationManager {
  private readonly now: () => number;
  private readonly tryGlmFallback: NonNullable<RotationDeps['tryGlmFallback']>;
  private readonly listRunningAgents: NonNullable<RotationDeps['listRunningAgents']>;
  private timer: ReturnType<typeof setInterval> | null = null;
  private rotating = false;

  constructor(private readonly deps: RotationDeps) {
    this.now = deps.now ?? (() => Date.now());
    this.tryGlmFallback = deps.tryGlmFallback ??
      ((ctxRoot, blockedAgents, reason, log) => attemptGlmFallback(ctxRoot, blockedAgents, reason, { log, now: this.now }));
    this.listRunningAgents = deps.listRunningAgents ??
      (() => listAgentDirs(this.deps.frameworkRoot, this.deps.org));
  }

  private save(state: RotationState): void {
    ensureDir(join(this.deps.ctxRoot, 'state', 'oauth'));
    atomicWriteSync(statePath(this.deps.ctxRoot), JSON.stringify(state, null, 2));
    try { chmodSync(statePath(this.deps.ctxRoot), 0o600); } catch { /* ignore */ }
  }

  /**
   * Write a hook-crash-alert.ts-recognized `.rotation-recovered` marker
   * before restarting a previously limit-blocked agent, so the SessionEnd
   * hook classifies the restart correctly instead of falling through to the
   * `crash` default (or getting caught by the rate-limit substring scan) —
   * see task_1789351994840_86202746. Mirrors soft-restart-all's `.user-restart`
   * write (src/cli/bus.ts) — write the marker synchronously BEFORE the
   * restart call, since that's what actually kills the old PTY session.
   * Best-effort: a failed write only costs classification accuracy on this
   * one restart, same as before this fix — it must never block the restart.
   */
  private writeRestartMarker(agent: string, reason: string): void {
    try {
      const stateDir = join(this.deps.ctxRoot, 'state', agent);
      ensureDir(stateDir);
      writeFileSync(join(stateDir, '.rotation-recovered'), reason);
    } catch { /* best-effort — see doc comment above */ }
  }

  /**
   * Put a Tier 2 marker back exactly as it was. Used when a Tier 1 restart
   * does not leave a running PTY: the marker was cleared first so a
   * successful spawn would not re-apply GLM, and a failed spawn must not
   * lose it.
   */
  private restoreGlmFallback(agent: string, prior: GlmFallbackActiveEntry | undefined): void {
    if (!prior) return;
    markGlmFallbackActive(this.deps.ctxRoot, agent, prior.reason, () => prior.since);
  }

  /**
   * Restart the right population after an active-account flip succeeds:
   * everyone currently limitBlocked, UNLESS that set is empty — nobody was
   * waiting on this rotation (a proactive preflight rotation, or the active
   * account recovering with no one blocked), so restarting the (empty)
   * blocked set would restart zero agents even though writeTokenToAgents()
   * just rewrote every agent's .env unconditionally. See
   * RotationDeps.listRunningAgents for the incident this closes
   * (task_1793058444001_76153432, fix direction 1). Shared by both
   * doRotation() success branches.
   */
  private async restartAfterFlip(state: RotationState, markerReason: string, restartReason: string): Promise<string[]> {
    return Object.keys(state.limitBlocked).length === 0
      ? this.restartAllRunningAgents(markerReason, restartReason)
      : this.restartBlockedAgents(state, markerReason, restartReason);
  }

  /**
   * Restart every currently limit-blocked agent and clear it from
   * `state.limitBlocked` only when restartOneAgent confirms a running
   * Tier 1 PTY — see restartOneAgent for the shared GLM/marker mechanics.
   */
  private async restartBlockedAgents(state: RotationState, markerReason: string, restartReason: string): Promise<string[]> {
    const toRestart = Object.keys(state.limitBlocked);
    for (const agent of toRestart) {
      const started = await this.restartOneAgent(agent, markerReason, restartReason);
      if (started) delete state.limitBlocked[agent];
    }
    return toRestart;
  }

  /** Restart EVERY currently-running agent — see restartAfterFlip and restartOneAgent. */
  private async restartAllRunningAgents(markerReason: string, restartReason: string): Promise<string[]> {
    const toRestart = this.listRunningAgents();
    for (const agent of toRestart) {
      await this.restartOneAgent(agent, markerReason, restartReason);
    }
    return toRestart;
  }

  /**
   * Shared single-agent restart, used by both restartBlockedAgents and
   * restartAllRunningAgents. A resolved restartAgent() call is not
   * confirmation a PTY is running — see RotationDeps.restartAgent — so this
   * returns true only when it actually confirms one.
   *
   * Any GLM-active marker is cleared immediately before the restart so the
   * new PTY does not pick the override back up, and restored when the
   * restart throws or does not confirm a running PTY — the agent then just
   * stays in whatever state it was already in (blocked, or split-brain)
   * until the next attempt notices it again.
   *
   * `restartReason` is the `.restart-planned` text restartAgent() writes.
   * It stays distinct from `markerReason`: classifyFromMarkers reads
   * `.rotation-recovered` first, and the planned marker is the fallback.
   */
  private async restartOneAgent(agent: string, markerReason: string, restartReason: string): Promise<boolean> {
    const existing = loadGlmFallbackState(this.deps.ctxRoot).active[agent];
    const priorGlm = existing ? { since: existing.since, reason: existing.reason } : undefined;
    if (priorGlm) clearGlmFallbackActive(this.deps.ctxRoot, agent);
    try {
      this.writeRestartMarker(agent, markerReason);
      const started = await this.deps.restartAgent(agent, restartReason);
      if (started === true) return true;
      this.restoreGlmFallback(agent, priorGlm);
      this.deps.log(`[rotation] restart for ${agent} resolved without a running Tier 1 PTY (${restartReason})`);
      return false;
    } catch (err) {
      this.restoreGlmFallback(agent, priorGlm);
      this.deps.log(`[rotation] restart failed for ${agent}: ${err} (${restartReason})`);
      return false;
    }
  }

  start(): void {
    this.timer = setInterval(() => { void this.tick(); }, TICK_MS);
    // Don't hold the process open for the rotation tick alone.
    (this.timer as { unref?: () => void }).unref?.();
  }

  /**
   * Drop limitBlocked entries for agents independently observed healthy
   * (a fresh heartbeat) since they were marked blocked — they recovered via
   * a restart path this manager doesn't own (hang-detector, context-force-
   * restart) and restartBlockedAgents() will never see them to clear them
   * itself. Left unpruned, a stale entry sits forever and keeps poisoning
   * retryAt's Math.min() the same way pruneOrphanedExhaustion() already
   * guards against for `exhausted` (task_1793058444001_76153432, fix
   * direction 3, first half).
   */
  private pruneStaleLimitBlocked(state: RotationState): boolean {
    let changed = false;
    for (const [agent, rec] of Object.entries(state.limitBlocked)) {
      if (isObservedHealthySince(this.deps.ctxRoot, agent, rec.detectedAt)) {
        delete state.limitBlocked[agent];
        changed = true;
        this.deps.log(`[rotation] pruned stale limitBlocked entry for ${agent} — observed healthy (heartbeat advanced past ${new Date(rec.detectedAt).toISOString()}), recovered via a non-rotation restart path`);
      }
    }
    return changed;
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  async onLimitEvent(agent: string, ev: LimitEvent): Promise<void> {
    const t = this.now();
    const state = loadState(this.deps.ctxRoot);
    state.limitBlocked[agent] = { detectedAt: t, kind: ev.kind, resetAt: ev.resetAt };
    // The active account is exhausted by definition of the event — but
    // "active" per WHOM? accounts.json's global `active` field is the
    // obvious read, and the only one checked before this fix. Cross-check
    // what `agent`'s own .env token actually resolves to first; fall back
    // to the global field only when that resolution is unavailable
    // (task_1793058444001_76153432, fix direction 2).
    //
    // Scope, stated honestly: `.env` is the SAME file fix direction 1's
    // restart-gate (writeTokenToAgents) just rewrote, so during the exact
    // live split-brain window (new .env on disk, old credential still
    // loaded in the process) this cross-check sees the NEW account too and
    // agrees with the global field — it cannot distinguish a still-stale
    // process from a resynced one. What it DOES catch: a deliberate
    // per-agent pin (`set-oauth-account --agent`) or any other path that
    // leaves one agent's `.env` genuinely different from the global field
    // — a real account mismatch fix direction 1 doesn't cover. Defense in
    // depth for a different failure, not a second detector for the same one.
    const store = loadAccounts(this.deps.ctxRoot);
    const active = store?.active;
    const ownAccount = store ? resolveAgentAccountName(this.deps.frameworkRoot, this.deps.org, agent, store) : null;
    const exhaustedAccount = ownAccount ?? active;
    if (ownAccount && active && ownAccount !== active) {
      this.deps.log(`[rotation] ${agent} reported a limit event while accounts.json says active="${active}" but ${agent}'s own .env token resolves to "${ownAccount}" — marking "${ownAccount}" exhausted, not the global active field (split-brain guard)`);
    }
    if (exhaustedAccount) {
      state.exhausted[exhaustedAccount] = { observedAt: t, resetAt: ev.resetAt ?? t + RETRY_FALLBACK_MS, source: 'limit-banner' };
    }
    this.save(state);
    this.deps.log(`[rotation] ${agent} limit-blocked (${ev.kind}, reset ${ev.resetAt ? new Date(ev.resetAt).toISOString() : 'unknown'})`);
    await this.attemptRotation('limit banner on ' + agent);
  }

  async tick(): Promise<void> {
    const t = this.now();
    const state = loadState(this.deps.ctxRoot);
    let dirty = this.pruneStaleLimitBlocked(state);

    const blocked = Object.keys(state.limitBlocked).length > 0;

    // Keep an EXISTING retryAt current even on ticks where no rotation
    // attempt actually runs — doRotation's own recompute only fires when it
    // is re-entered, and both its cooldown guard and the `t < retryAt` gate
    // just below can skip that for many consecutive ticks while
    // limitBlocked/exhausted keeps changing underneath it
    // (task_1793058444001_76153432, fix direction 3, second half).
    //
    // Gated on retryAt !== null deliberately: null means "no scheduled
    // retry yet — try as soon as possible," which is exactly what the gate
    // below does with it. Recomputing from current exhausted/limitBlocked
    // data here would manufacture a real (possibly far-future) retryAt out
    // of stale exhaustion marks left over from an already-resolved rotation
    // and WRONGLY defer a retry that should fire immediately — this must
    // only ever refresh a retry that is already scheduled, never invent one.
    if (blocked && state.retryAt !== null) {
      const storeForRetry = loadAccounts(this.deps.ctxRoot);
      if (storeForRetry) {
        const fresh = computeRetryAt(state, storeForRetry.accounts);
        if (fresh !== null && fresh !== state.retryAt) {
          state.retryAt = fresh;
          dirty = true;
        }
      }
    }
    if (dirty) this.save(state);

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
        // no hint from a ping; conservative fallback
        s2.exhausted[store.active] = { observedAt: t, resetAt: t + RETRY_FALLBACK_MS, source: 'proactive-preflight' };
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

    // A retired/removed account's exhaustion mark can never be cleared by the
    // normal path (that only fires on rotating INTO it) — prune it here, on
    // every rotation attempt, so it can't sit forever poisoning retryAt below.
    if (pruneOrphanedExhaustion(state, store.accounts)) this.save(state);

    const candidates = Object.keys(store.accounts).filter(name => {
      if (name === store.active) return false;
      // Operator-retired seats are never candidates: a cancelled subscription
      // still passes the inference preflight (it authenticates; it just has
      // no capacity), so this filter is the only protection on the daemon's
      // unattended rotation path — same rule as the bus rotate-oauth builder.
      if (store.accounts[name].disabled) return false;
      const rec = state.exhausted[name];
      return !(rec && rec.resetAt > t);
    });

    let attempted = 0;
    let sawNonError = false; // an 'ok' or 'limit' anywhere this invocation proves the mechanism works

    for (const name of candidates) {
      const result = await this.deps.preflight(store.accounts[name].access_token);
      attempted += 1;
      if (result === 'ok') {
        state.consecutiveInfraTicks = 0;
        try {
          setActiveAccount(this.deps.ctxRoot, name, { reason, from: store.active });
        } catch (err) {
          // Defense-in-depth: an operator can disable an account between our
          // store load and this call — setActiveAccount re-reads the file and
          // refuses disabled targets. Skip to the next candidate instead of
          // letting the throw crash the whole unattended rotation attempt.
          this.deps.log(`[rotation] candidate ${name} rejected by setActiveAccount (${err}) — trying next`);
          continue;
        }
        writeTokenToAgents(this.deps.frameworkRoot, this.deps.org, store.accounts[name].access_token);
        // Reload: preflights are slow (real inference); more agents may have blocked meanwhile.
        state = loadState(this.deps.ctxRoot);
        // GLM markers are cleared inside restartAfterFlip's chosen restart
        // method immediately before each restart, and restored unless that
        // call confirms a running Tier 1 PTY. Do not clear them here first
        // — a pre-clear throws away the entry a failed restart has to put
        // back. See restartAfterFlip's doc comment for why the restart
        // population depends on whether anyone was limitBlocked.
        const toRestart = await this.restartAfterFlip(
          state,
          `rotation recovery: account "${name}" now active (${reason})`,
          `oauth rotation -> account "${name}" (${reason})`,
        );
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
        // Keep an existing resetAt guess (don't push a real hint out with a
        // fresh fallback), but observedAt always advances — we just
        // re-confirmed this a moment ago, and that observation matters even
        // when the derived retry time doesn't change.
        const existing = state.exhausted[name];
        state.exhausted[name] = {
          observedAt: t,
          resetAt: existing?.resetAt ?? t + RETRY_FALLBACK_MS,
          source: existing?.source ?? 'candidate-preflight',
        };
        this.deps.log(`[rotation] candidate "${name}" exhausted`);
      } else {
        this.deps.log(`[rotation] candidate "${name}" preflight error — skipped, not marked exhausted`);
      }
    }

    // Bench dry — the ACTIVE account may itself have recovered (5h windows reset
    // on their own). Recheck it unless a still-fresh exhausted mark says otherwise;
    // on recovery, restart blocked agents onto it — no account flip needed.
    const activeExhaustedUntil = state.exhausted[store.active]?.resetAt ?? 0;
    if (activeExhaustedUntil <= t) {
      const activeResult = await this.deps.preflight(store.accounts[store.active].access_token);
      attempted += 1;
      if (activeResult === 'ok') {
        state = loadState(this.deps.ctxRoot);
        // Same as the candidate-rotation branch: restartAfterFlip owns the
        // GLM clear/restore. A pre-clear here cannot be undone. No
        // active-account write happens in this branch (it recovered in
        // place, no flip), but a prior rotation into it could still have
        // left non-blocked agents split-brain.
        const toRestart = await this.restartAfterFlip(
          state,
          `rotation recovery: account "${store.active}" recovered (${reason})`,
          `oauth rotation -> account "${store.active}" (recovered)`,
        );
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
      s3.exhausted[store.active] = { observedAt: t, resetAt: t + RETRY_FALLBACK_MS, source: 'active-recheck' };
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
    // BUG FIX: exclude accounts no longer in store.accounts (retired/removed)
    // — pruneOrphanedExhaustion already drops these going forward, but this
    // filter is the load-bearing guard against Math.min() ever picking an
    // ancient orphaned mark again, belt-and-braces with the prune above.
    // computeRetryAt() is the same derivation tick() now also runs every
    // cycle (fix direction 3) — factored out rather than duplicated.
    state.retryAt = computeRetryAt(state, store.accounts) ?? t + RETRY_FALLBACK_MS;
    const alertNeeded = !state.alertedHalt;
    state.alertedHalt = true;
    this.save(state);
    const msg = `⛔ cortextOS: ALL OAuth accounts exhausted. Blocked: ${Object.keys(state.limitBlocked).join(', ') || 'none yet'}. Auto-retry at ${new Date(state.retryAt).toISOString()}.`;
    this.deps.log('[rotation] ' + msg);
    if (alertNeeded) this.deps.sendAlert(msg);

    // Tier 2 (GLM-5.3 cross-provider fallback) — entered ONLY here, having
    // just verified every Tier 1 account (bench + active recheck) failed
    // preflight this invocation. Ships disabled; a no-config or
    // enabled:false fleet gets a guaranteed no-op. See glm-fallback.ts.
    const blockedNow = Object.keys(state.limitBlocked);
    if (blockedNow.length > 0) {
      const glmResult = this.tryGlmFallback(this.deps.ctxRoot, blockedNow, reason, this.deps.log);
      if (glmResult.candidates.length > 0) {
        // Mark BEFORE restartAgent. AgentPTY.spawn reads the marker while
        // building the env, so a mark that lands only after the promise
        // resolves never reaches the new PTY. Keep the mark (and count the
        // agent as entered) only when the call confirms a running PTY.
        // A throw or a resolved no-op clears it — otherwise the next
        // attempt's already-active filter would skip an agent that never
        // actually started on GLM.
        const entered: string[] = [];
        for (const agent of glmResult.candidates) {
          markGlmFallbackActive(this.deps.ctxRoot, agent, reason, this.now);
          try {
            const started = await this.deps.restartAgent(agent);
            if (started === true) {
              entered.push(agent);
            } else {
              clearGlmFallbackActive(this.deps.ctxRoot, agent);
              this.deps.log(`[glm-fallback] restart for ${agent} resolved without a running PTY — mark cleared, remains a candidate for the next attempt`);
            }
          } catch (err) {
            clearGlmFallbackActive(this.deps.ctxRoot, agent);
            this.deps.log(`[glm-fallback] restart failed for ${agent}: ${err} — NOT marked Tier-2-active, remains a candidate for the next attempt`);
          }
        }
        if (entered.length > 0) {
          const glmMsg = `🟡 cortextOS: Tier 2 (GLM-5.3/Z.ai) entered for ${entered.join(', ')} — all Tier 1 accounts exhausted. Held on Tier 1: ${glmResult.excluded.join(', ') || 'none'}.`;
          this.deps.log('[glm-fallback] ' + glmMsg);
          this.deps.sendAlert(glmMsg);
        }
      }
    }
  }
}
