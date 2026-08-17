/**
 * OAuth token rotation system for cortextOS.
 *
 * Manages multi-account Claude OAuth credentials with automatic rotation
 * based on utilization thresholds.
 *
 * Key invariants:
 * - Refresh tokens are one-time use — always write accounts.json atomically
 *   BEFORE any preflight that could fail
 * - CLAUDE_CODE_OAUTH_TOKEN is a bare access token string (not JSON blob)
 * - accounts.json lives at state/oauth/accounts.json (per-instance, not per-org)
 * - Usage cache TTL = 3 minutes (API rate limit ~5 req/token)
 */

import { existsSync, readFileSync, chmodSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { execFile } from 'child_process';
import { atomicWriteSync, ensureDir } from '../utils/atomic.js';

// Hand-rolled Promise wrapper rather than util.promisify(execFile): Node's
// built-in execFile carries a promisify.custom symbol that changes resolve
// shape ({stdout, stderr} object) in a way that's invisible to (and doesn't
// survive) mocking the child_process module in tests. An explicit wrapper
// keeps the real callback contract (error, stdout, stderr) directly testable.
function execFileAsync(
  file: string,
  args: string[],
  options: { env: NodeJS.ProcessEnv; timeout: number; encoding: BufferEncoding },
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(file, args, options, (error, stdout, stderr) => {
      if (error) {
        reject(error);
        return;
      }
      resolve({ stdout: stdout as string, stderr: stderr as string });
    });
  });
}

// --- Types ---

export interface OAuthAccount {
  label: string;
  access_token: string;
  refresh_token: string;
  expires_at: number; // Unix ms
  last_refreshed: string; // ISO 8601
  five_hour_utilization: number; // 0.0–1.0
  seven_day_utilization: number; // 0.0–1.0
  /**
   * Operator-set retirement flag. A disabled account is never selected as a
   * rotation candidate and cannot be made active via set-oauth-account —
   * needed because a CANCELLED subscription still passes the setup-token
   * liveness preflight (it authenticates fine, it just has no capacity), so
   * without this flag rotate-oauth can silently move the fleet onto a dead
   * seat. Retiring a seat is a supported operation, not a hand-edit.
   */
  disabled?: boolean;
}

export interface AccountsStore {
  active: string;
  accounts: Record<string, OAuthAccount>;
  rotation_log: RotationLogEntry[];
}

export interface RotationLogEntry {
  timestamp: string;
  from: string;
  to: string;
  reason: string;
  five_hour_util: number;
  seven_day_util: number;
}

export interface UsageSnapshot {
  account: string;
  five_hour_utilization: number;
  seven_day_utilization: number;
  fetched_at: string;
}

export interface UsageCache {
  snapshot: UsageSnapshot;
  expires_at: number; // Unix ms
}

export interface CheckUsageResult {
  account: string;
  five_hour_utilization: number;
  seven_day_utilization: number;
  cached: boolean;
  fetched_at: string;
}

export interface RotateResult {
  rotated: boolean;
  reason: string;
  from?: string;
  to?: string;
}

const CACHE_TTL_MS = 3 * 60 * 1000; // 3 minutes
const ROTATION_LOG_MAX = 50;

// Setup-token liveness ping — much shorter TTL than the usage cache. A
// rotation storm (multiple agents hitting the same wall near-simultaneously)
// could otherwise fire a real inference call against the same candidate
// account once per rotating agent; this caps that to one ping per window.
const SETUP_TOKEN_LIVENESS_CACHE_TTL_MS = 60 * 1000; // 1 minute
const SETUP_TOKEN_PING_TIMEOUT_MS = 30 * 1000;
const SETUP_TOKEN_PING_MODEL = 'claude-haiku-4-5-20251001';
const SETUP_TOKEN_PING_PROMPT = 'Reply with exactly one word: ok';

// Utilization thresholds for rotation trigger
const THRESHOLD_5H = 0.85;
const THRESHOLD_7D = 0.80;
// Alert thresholds (warn before rotating)
export const ALERT_5H = 0.80;
export const ALERT_7D = 0.70;

// --- Path helpers ---

function oauthDir(ctxRoot: string): string {
  return join(ctxRoot, 'state', 'oauth');
}

function accountsPath(ctxRoot: string): string {
  return join(oauthDir(ctxRoot), 'accounts.json');
}

function usageDir(ctxRoot: string): string {
  return join(ctxRoot, 'state', 'usage');
}

function usageCachePath(ctxRoot: string): string {
  return join(usageDir(ctxRoot), 'cache.json');
}

function usageLatestPath(ctxRoot: string): string {
  return join(usageDir(ctxRoot), 'latest.json');
}

function setupTokenLivenessCachePath(ctxRoot: string): string {
  return join(oauthDir(ctxRoot), 'setup-token-liveness-cache.json');
}

function usageDailyPath(ctxRoot: string): string {
  const today = new Date().toISOString().split('T')[0];
  return join(usageDir(ctxRoot), `${today}.jsonl`);
}

// --- Account store helpers ---

export function loadAccounts(ctxRoot: string): AccountsStore | null {
  const path = accountsPath(ctxRoot);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as AccountsStore;
  } catch {
    return null;
  }
}

function saveAccounts(ctxRoot: string, store: AccountsStore): void {
  ensureDir(oauthDir(ctxRoot));
  const path = accountsPath(ctxRoot);
  atomicWriteSync(path, JSON.stringify(store, null, 2));
  try { chmodSync(path, 0o600); } catch { /* ignore */ }
}

export function getActiveAccount(ctxRoot: string): { name: string; account: OAuthAccount } | null {
  const store = loadAccounts(ctxRoot);
  if (!store) return null;
  const account = store.accounts[store.active];
  if (!account) return null;
  return { name: store.active, account };
}

// --- Usage cache helpers ---

function loadCache(ctxRoot: string): UsageCache | null {
  const path = usageCachePath(ctxRoot);
  if (!existsSync(path)) return null;
  try {
    const cache = JSON.parse(readFileSync(path, 'utf-8')) as UsageCache;
    return cache;
  } catch {
    return null;
  }
}

function saveCache(ctxRoot: string, snapshot: UsageSnapshot): void {
  ensureDir(usageDir(ctxRoot));
  const cache: UsageCache = {
    snapshot,
    expires_at: Date.now() + CACHE_TTL_MS,
  };
  atomicWriteSync(usageCachePath(ctxRoot), JSON.stringify(cache, null, 2));
  atomicWriteSync(usageLatestPath(ctxRoot), JSON.stringify(snapshot, null, 2));

  // Append to daily JSONL log
  const { appendFileSync } = require('fs');
  try {
    appendFileSync(usageDailyPath(ctxRoot), JSON.stringify(snapshot) + '\n');
  } catch { /* ignore */ }
}

// --- check-usage-api ---

/**
 * Fetch utilization from Anthropic usage API for the active account.
 * Respects 3-minute TTL cache to avoid hitting rate limits.
 */
export async function checkUsageApi(
  ctxRoot: string,
  opts: { force?: boolean; account?: string } = {},
): Promise<CheckUsageResult> {
  // Check cache first (unless force)
  if (!opts.force) {
    const cache = loadCache(ctxRoot);
    if (cache && cache.expires_at > Date.now()) {
      return { ...cache.snapshot, cached: true };
    }
  }

  // Determine which account to check
  let accessToken: string | undefined;
  let accountName: string;

  if (opts.account) {
    const store = loadAccounts(ctxRoot);
    const acct = store?.accounts[opts.account];
    if (!acct) throw new Error(`Account "${opts.account}" not found in accounts.json`);
    accessToken = acct.access_token;
    accountName = opts.account;
  } else {
    // Fall back to env / Keychain
    const active = getActiveAccount(ctxRoot);
    if (active) {
      accessToken = active.account.access_token;
      accountName = active.name;
    } else {
      accessToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
      accountName = 'env';
      if (!accessToken) throw new Error('No OAuth token available (no accounts.json and CLAUDE_CODE_OAUTH_TOKEN not set)');
    }
  }

  const response = await fetch('https://api.anthropic.com/api/oauth/usage', {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'anthropic-beta': 'oauth-2025-04-20',
    },
  });

  if (!response.ok) {
    throw new Error(`Usage API returned ${response.status}: ${await response.text()}`);
  }

  // The Anthropic OAuth usage API returns NESTED objects:
  //   { five_hour: { utilization, resets_at }, seven_day: {...}, ... }
  // The earlier flat-only parsing always returned undefined → normalize → 0
  // → "100% remaining" regardless of real usage. That made the watchdog
  // blind to real burn (it tripped only on ccusage's heuristic) and
  // hid Sondre's actual quota in the dashboard. Keep flat fallbacks in
  // case the API ever returns either shape.
  const data = await response.json() as {
    five_hour?: { utilization?: number };
    seven_day?: { utilization?: number };
    five_hour_utilization?: number;
    seven_day_utilization?: number;
    fiveHourUtilization?: number;
    sevenDayUtilization?: number;
  };

  // Normalize 0–100 → 0.0–1.0 if needed
  const normalize = (v: number | undefined) => {
    if (v === undefined) return 0;
    return v > 1 ? v / 100 : v;
  };

  const fiveHour = normalize(
    data.five_hour?.utilization ?? data.five_hour_utilization ?? data.fiveHourUtilization,
  );
  const sevenDay = normalize(
    data.seven_day?.utilization ?? data.seven_day_utilization ?? data.sevenDayUtilization,
  );
  const fetchedAt = new Date().toISOString();

  const snapshot: UsageSnapshot = {
    account: accountName,
    five_hour_utilization: fiveHour,
    seven_day_utilization: sevenDay,
    fetched_at: fetchedAt,
  };

  // Update cache and accounts.json utilization fields
  saveCache(ctxRoot, snapshot);

  const store = loadAccounts(ctxRoot);
  if (store && store.accounts[accountName]) {
    store.accounts[accountName].five_hour_utilization = fiveHour;
    store.accounts[accountName].seven_day_utilization = sevenDay;
    saveAccounts(ctxRoot, store);
  }

  return { ...snapshot, cached: false };
}

// --- setup-token liveness (preflight for tokens checkUsageApi can't validate) ---

/**
 * Setup-tokens (`sk-ant-oat01-` prefix) lack the `user:profile` scope, so
 * checkUsageApi's call to /api/oauth/usage 403s on every one of them —
 * rotateOAuth's preflight would always fail for this token type without this
 * branch. checkUsageApi itself is UNTOUCHED by this file: the real-OAuth-grant
 * path (tokens WITH the scope) still goes through it exactly as before. This
 * only applies to the setup-token branch of rotateOAuth's preflight.
 */
export function isSetupToken(token: string): boolean {
  return token.startsWith('sk-ant-oat01-');
}

export interface SetupTokenLivenessResult {
  account: string;
  alive: boolean;
  cached: boolean;
  checked_at: string;
}

interface SetupTokenLivenessCache {
  [accountName: string]: { alive: boolean; checked_at: number };
}

function loadLivenessCache(ctxRoot: string): SetupTokenLivenessCache {
  const path = setupTokenLivenessCachePath(ctxRoot);
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as SetupTokenLivenessCache;
  } catch {
    return {};
  }
}

function saveLivenessCache(ctxRoot: string, cache: SetupTokenLivenessCache): void {
  ensureDir(oauthDir(ctxRoot));
  atomicWriteSync(setupTokenLivenessCachePath(ctxRoot), JSON.stringify(cache, null, 2));
}

// Common absolute install locations for the `claude` CLI, checked before
// falling back to a bare PATH lookup. The daemon runs as a single long-lived
// PM2-managed process — PM2 (and other process managers/launchd/systemd)
// often start with a PATH assembled BEFORE the user's shell rc files run
// (nvm, homebrew shellenv, etc.), so `process.env.PATH` inside the daemon can
// be missing the directory `claude` actually lives in even though it
// resolves fine in an interactive shell. cortextOS hit and fixed the
// identical class of bug for the `cortextos` binary in hook-crash-alert.ts
// (PATH-unaware execFile → silent ENOENT). A bare `spawnSync('claude', ...)`
// here would fail the same way, except the ENOENT gets swallowed by the
// generic status!==0 check below and misreported as "account unreachable,
// dead, or revoked" — a false negative that looks like a real account
// failure instead of an environment problem.
const CLAUDE_BINARY_CANDIDATES = [
  process.env.CLAUDE_CLI_PATH,
  '/opt/homebrew/bin/claude',
  '/usr/local/bin/claude',
  join(homedir(), '.local/bin/claude'),
  join(homedir(), '.claude/local/claude'),
].filter((p): p is string => Boolean(p));

let cachedClaudeBinary: string | null = null;

/**
 * Resolve an absolute, PATH-independent path to the `claude` binary where
 * possible. Falls back to the bare command name (existing PATH-dependent
 * behavior) only if none of the known install locations exist, so this is
 * never worse than before — only better when one of the candidates hits.
 * Result is cached for the process lifetime (install location doesn't change
 * mid-run) so repeated preflight calls don't re-stat the filesystem.
 */
export function resolveClaudeBinary(): string {
  if (cachedClaudeBinary) return cachedClaudeBinary;
  for (const candidate of CLAUDE_BINARY_CANDIDATES) {
    if (existsSync(candidate)) {
      cachedClaudeBinary = candidate;
      return candidate;
    }
  }
  cachedClaudeBinary = 'claude';
  return cachedClaudeBinary;
}

/**
 * Validate a setup-token candidate via a cheap one-shot inference ping
 * instead of the scope-gated usage API. Cannot recover real utilization for
 * this token type (accounts.json's utilization fields stay whatever they
 * already were — never fabricated) — this only answers "does this token
 * still authenticate," which is what rotateOAuth's preflight actually needs
 * to gate on for setup-tokens.
 *
 * TTL-cached (1 min, much shorter than checkUsageApi's 3 min) so a rotation
 * storm across multiple agents hitting the same candidate doesn't fire one
 * real inference call per agent.
 *
 * Uses execFile (async, non-blocking), NOT spawnSync: the daemon is a single
 * long-lived process managing every agent's PTY, Telegram polling, and
 * hang-detection. A synchronous spawn here blocks that entire process for up
 * to SETUP_TOKEN_PING_TIMEOUT_MS (30s) per call — precisely during a
 * rate-limit cascade, the exact scenario this preflight exists to handle.
 * execFile lets the event loop keep servicing everything else while the
 * ping is in flight.
 */
export async function checkSetupTokenLiveness(
  ctxRoot: string,
  accountName: string,
  opts: { force?: boolean } = {},
): Promise<SetupTokenLivenessResult> {
  if (!opts.force) {
    const cache = loadLivenessCache(ctxRoot);
    const entry = cache[accountName];
    if (entry && Date.now() - entry.checked_at < SETUP_TOKEN_LIVENESS_CACHE_TTL_MS) {
      return {
        account: accountName,
        alive: entry.alive,
        cached: true,
        checked_at: new Date(entry.checked_at).toISOString(),
      };
    }
  }

  const store = loadAccounts(ctxRoot);
  const account = store?.accounts[accountName];
  if (!account) throw new Error(`Account "${accountName}" not found in accounts.json`);

  let alive: boolean;
  try {
    const { stdout } = await execFileAsync(
      resolveClaudeBinary(),
      ['-p', SETUP_TOKEN_PING_PROMPT, '--model', SETUP_TOKEN_PING_MODEL],
      {
        env: { ...process.env, CLAUDE_CODE_OAUTH_TOKEN: account.access_token },
        timeout: SETUP_TOKEN_PING_TIMEOUT_MS,
        encoding: 'utf-8',
      },
    );
    alive = (stdout || '').trim().length > 0;
  } catch {
    // Non-zero exit, timeout, or spawn failure (e.g. ENOENT) — all treated as
    // "not alive." A genuine invocation error (missing binary) and a genuine
    // dead account both fail closed here; resolveClaudeBinary() minimizes the
    // former so this mostly reflects the latter.
    alive = false;
  }
  const checkedAt = Date.now();

  const cache = loadLivenessCache(ctxRoot);
  cache[accountName] = { alive, checked_at: checkedAt };
  saveLivenessCache(ctxRoot, cache);

  return {
    account: accountName,
    alive,
    cached: false,
    checked_at: new Date(checkedAt).toISOString(),
  };
}

// --- refresh-oauth-token ---

/**
 * Refresh an OAuth token for the given account.
 * CRITICAL: writes accounts.json atomically BEFORE returning.
 * Refresh tokens are one-time use — the write must never be deferred.
 */
export async function refreshOAuthToken(
  ctxRoot: string,
  accountName?: string,
): Promise<{ account: string; expires_at: number }> {
  const store = loadAccounts(ctxRoot);
  if (!store) throw new Error('No accounts.json found. Cannot refresh.');

  const name = accountName || store.active;
  const account = store.accounts[name];
  if (!account) throw new Error(`Account "${name}" not found in accounts.json`);
  if (!account.refresh_token) throw new Error(`Account "${name}" has no refresh_token`);

  const response = await fetch('https://console.anthropic.com/v1/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'refresh_token',
      refresh_token: account.refresh_token,
    }),
  });

  if (!response.ok) {
    throw new Error(`Token refresh failed (${response.status}): ${await response.text()}`);
  }

  const tokens = await response.json() as {
    access_token: string;
    refresh_token: string;
    expires_in?: number;
  };

  if (!tokens.access_token || !tokens.refresh_token) {
    throw new Error('Token refresh response missing access_token or refresh_token');
  }

  const expiresAt = Date.now() + (tokens.expires_in ?? 3600) * 1000;

  // ATOMIC WRITE — must happen before any further use of the new tokens
  store.accounts[name] = {
    ...account,
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    expires_at: expiresAt,
    last_refreshed: new Date().toISOString(),
  };
  saveAccounts(ctxRoot, store);

  return { account: name, expires_at: expiresAt };
}

// --- rotate-oauth ---

/**
 * Rotate the active OAuth account based on utilization thresholds.
 *
 * Two-phase write:
 *   Phase 1: accounts.json (permanent, written after refresh)
 *   Phase 2: agent .env files (conditional on preflight passing)
 */
export async function rotateOAuth(
  ctxRoot: string,
  frameworkRoot: string,
  org: string,
  opts: { reason?: string; agent?: string; force?: boolean } = {},
): Promise<RotateResult> {
  const store = loadAccounts(ctxRoot);
  if (!store) return { rotated: false, reason: 'No accounts.json found' };

  const currentName = store.active;
  const current = store.accounts[currentName];
  if (!current) return { rotated: false, reason: `Active account "${currentName}" not found` };

  // Check utilization thresholds (or force flag)
  const needsRotation = opts.force ||
    current.five_hour_utilization >= THRESHOLD_5H ||
    current.seven_day_utilization >= THRESHOLD_7D;

  if (!needsRotation) {
    return {
      rotated: false,
      reason: `Utilization within limits (5h: ${pct(current.five_hour_utilization)}, 7d: ${pct(current.seven_day_utilization)})`,
    };
  }

  // Candidates sorted by 5h utilization. For real OAuth-grant tokens this is
  // a genuine signal (prefer the least-used alternative). For setup-tokens
  // it is NOT — their utilization fields are always 0.0/stale (no live
  // signal exists for this token type), so the sort is an arbitrary tie
  // order, not a real ranking. Either way, the LOOP below (not the sort) is
  // what actually finds a live account: it tries candidates in this order
  // and uses the first one that passes preflight, falling through to the
  // next on failure rather than giving up after a single arbitrary pick.
  const candidates = Object.entries(store.accounts)
    .filter(([name, acct]) => name !== currentName && !acct.disabled)
    .sort(([, a], [, b]) => a.five_hour_utilization - b.five_hour_utilization);

  if (candidates.length === 0) {
    return { rotated: false, reason: 'No alternate accounts available for rotation' };
  }

  let nextName: string | undefined;
  let preflight: CheckUsageResult | undefined;
  const attemptFailures: string[] = [];

  for (const [candidateName, candidateAccountInitial] of candidates) {
    let candidateAccount = candidateAccountInitial;

    // Refresh this candidate's token if expiring within 2 hours.
    if (candidateAccount.expires_at - Date.now() < 2 * 60 * 60 * 1000) {
      await refreshOAuthToken(ctxRoot, candidateName);
      const refreshed = loadAccounts(ctxRoot)!;
      candidateAccount = refreshed.accounts[candidateName];
    }

    // PREFLIGHT: verify this candidate's token actually works.
    // Setup-tokens (sk-ant-oat01-) 403 on checkUsageApi's scope-gated usage
    // endpoint, so they're validated via a one-shot inference ping instead —
    // see checkSetupTokenLiveness's docblock. Real OAuth-grant tokens (with
    // the scope) take the EXACT same checkUsageApi path as always —
    // untouched, byte-identical.
    try {
      if (isSetupToken(candidateAccount.access_token)) {
        const liveness = await checkSetupTokenLiveness(ctxRoot, candidateName, { force: true });
        if (!liveness.alive) {
          throw new Error('setup-token inference ping failed (account unreachable, dead, or revoked)');
        }
        // No real utilization signal exists for this token type — preserve
        // whatever was already cached rather than assert a fabricated number.
        preflight = {
          account: candidateName,
          five_hour_utilization: candidateAccount.five_hour_utilization,
          seven_day_utilization: candidateAccount.seven_day_utilization,
          cached: false,
          fetched_at: liveness.checked_at,
        };
      } else {
        preflight = await checkUsageApi(ctxRoot, { force: true, account: candidateName });
      }
      nextName = candidateName;
      break; // first live candidate wins — stop trying further ones
    } catch (err) {
      attemptFailures.push(`"${candidateName}": ${err}`);
      // fall through to the next candidate
    }
  }

  if (!nextName || !preflight) {
    // Every candidate failed preflight — genuinely exhausted, not a
    // single-arbitrary-pick false-negative. Surface all attempts so the
    // caller (and any alert built on the reason string) can see it tried
    // more than one account before giving up.
    return {
      rotated: false,
      reason: `Preflight failed for all ${candidates.length} candidate account(s): ${attemptFailures.join('; ')}`,
    };
  }

  // PHASE 1: Update accounts.json (active + rotation_log)
  const reloaded = loadAccounts(ctxRoot)!;
  reloaded.active = nextName;
  reloaded.accounts[nextName].five_hour_utilization = preflight.five_hour_utilization;
  reloaded.accounts[nextName].seven_day_utilization = preflight.seven_day_utilization;

  const logEntry: RotationLogEntry = {
    timestamp: new Date().toISOString(),
    from: currentName,
    to: nextName,
    reason: opts.reason || buildRotationReason(current),
    five_hour_util: current.five_hour_utilization,
    seven_day_util: current.seven_day_utilization,
  };
  reloaded.rotation_log = [logEntry, ...reloaded.rotation_log].slice(0, ROTATION_LOG_MAX);
  saveAccounts(ctxRoot, reloaded);

  // PHASE 2: Write bare access token to agent .env files
  const finalStore = loadAccounts(ctxRoot)!;
  const newToken = finalStore.accounts[nextName].access_token;
  writeTokenToAgents(frameworkRoot, org, newToken, opts.agent);

  return {
    rotated: true,
    reason: logEntry.reason,
    from: currentName,
    to: nextName,
  };
}

// --- Helpers ---

function buildRotationReason(account: OAuthAccount): string {
  if (account.five_hour_utilization >= THRESHOLD_5H) {
    return `5h utilization at ${pct(account.five_hour_utilization)} (threshold: ${pct(THRESHOLD_5H)})`;
  }
  return `7d utilization at ${pct(account.seven_day_utilization)} (threshold: ${pct(THRESHOLD_7D)})`;
}

function pct(v: number): string {
  return `${Math.round(v * 100)}%`;
}

/**
 * Write the bare access token to agent .env files.
 * Writes CLAUDE_CODE_OAUTH_TOKEN=<token> — bare string, not JSON.
 * Scoped to a specific agent if opts.agent is set, otherwise all agents in org.
 */
export function writeTokenToAgents(
  frameworkRoot: string,
  org: string,
  token: string,
  targetAgent?: string,
): void {
  const agentsBase = join(frameworkRoot, 'orgs', org, 'agents');
  if (!existsSync(agentsBase)) return;

  const { readdirSync, writeFileSync } = require('fs');

  let agentNames: string[];
  if (targetAgent) {
    agentNames = [targetAgent];
  } else {
    try {
      agentNames = readdirSync(agentsBase, { withFileTypes: true })
        .filter((d: { isDirectory(): boolean }) => d.isDirectory())
        .map((d: { name: string }) => d.name);
    } catch {
      return;
    }
  }

  for (const name of agentNames) {
    const envPath = join(agentsBase, name, '.env');
    if (!existsSync(envPath)) continue;

    try {
      let content = readFileSync(envPath, 'utf-8');

      if (content.includes('CLAUDE_CODE_OAUTH_TOKEN=')) {
        // Replace existing line
        content = content.replace(
          /^CLAUDE_CODE_OAUTH_TOKEN=.*$/m,
          `CLAUDE_CODE_OAUTH_TOKEN=${token}`,
        );
      } else {
        // Append new line
        content = content.trimEnd() + `\nCLAUDE_CODE_OAUTH_TOKEN=${token}\n`;
      }

      atomicWriteSync(envPath, content);
      try { chmodSync(envPath, 0o600); } catch { /* ignore */ }
    } catch { /* skip agents whose .env we can't write */ }
  }
}

/**
 * Flip the active account and record the rotation, WITHOUT any preflight.
 * Used by the daemon's rotation manager, whose preflight is an inference ping
 * (the usage API rejects setup-tokens — no user:profile scope).
 */
export function setActiveAccount(
  ctxRoot: string,
  name: string,
  logEntry: { reason: string; from: string },
): void {
  const store = loadAccounts(ctxRoot);
  if (!store) throw new Error('No accounts.json found');
  if (!store.accounts[name]) throw new Error(`Account "${name}" not found in accounts.json`);
  if (store.accounts[name].disabled) {
    throw new Error(`Account "${name}" is disabled (retired) — re-enable it in accounts.json before activating`);
  }
  const from = store.accounts[logEntry.from];
  store.active = name;
  store.rotation_log = [{
    timestamp: new Date().toISOString(),
    from: logEntry.from,
    to: name,
    reason: logEntry.reason,
    five_hour_util: from?.five_hour_utilization ?? 0,
    seven_day_util: from?.seven_day_utilization ?? 0,
  }, ...store.rotation_log].slice(0, ROTATION_LOG_MAX);
  saveAccounts(ctxRoot, store);
}
