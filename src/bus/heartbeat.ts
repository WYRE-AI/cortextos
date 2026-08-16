import { readdirSync, readFileSync, existsSync, unlinkSync, statSync } from 'fs';
import { join } from 'path';
import type { Heartbeat, BusPaths, HeartbeatRow } from '../types/index.js';
import { listAgents } from './agents.js';
import { atomicWriteSync, ensureDir } from '../utils/atomic.js';

/**
 * SessionEnd-hook end-type markers (see src/hooks/hook-crash-alert.ts). A
 * restart writes one of these; the crash-alert hook reads it WITHOUT consuming
 * it, because one restart fires the hook twice and both firings must classify
 * from the same marker. clearEndMarkers is the marker's primary cleanup: an
 * agent updating its heartbeat is genuinely alive in its post-restart session,
 * so a pending end-marker is stale and is removed here — but only once it is
 * past the grace window below. The hook's TTL is the backstop for a start that
 * fails before ever heartbeating.
 */
const END_TYPE_MARKERS = [
  '.restart-planned',
  '.session-refresh',
  '.user-restart',
  '.user-disable',
  '.user-stop',
  '.daemon-crashed',
  '.daemon-stop',
];

/**
 * A marker younger than this is left alone by clearEndMarkers — it may belong
 * to a restart still in flight. The hazard: the post-restart session can reach
 * its first heartbeat before the dying restart's SECOND SessionEnd firing
 * lands (firing#2 is typically 13-22s after firing#1, but not hard-bounded).
 * Without a grace window, that heartbeat would wipe the marker and firing#2
 * would classify `crash` — the exact false positive this whole change exists
 * to kill, reintroduced under a narrower window.
 *
 * The grace makes that race negligible, not mathematically zero: a firing#2
 * delayed past 120s under heavy load could still miss the marker. That is the
 * same bounded residual as the hook's TTL and is accepted. The window is sized
 * generously on the TTL's cost asymmetry — too tight reopens the FP; too loose
 * only delays cleanup harmlessly (the heartbeat clears it on a later pass, and
 * the 300s hook TTL backstops). 120s clears any plausible firing#2 delay while
 * staying well under the TTL.
 */
const MARKER_CLEAR_GRACE_MS = 120_000; // 2 minutes

/**
 * Remove SessionEnd-hook end-type markers from an agent's state dir, skipping
 * any marker younger than MARKER_CLEAR_GRACE_MS (an in-flight restart whose
 * second hook firing may not have landed yet). `nowMs` is injectable for tests.
 */
export function clearEndMarkers(stateDir: string, nowMs: number = Date.now()): void {
  for (const file of END_TYPE_MARKERS) {
    const p = join(stateDir, file);
    if (!existsSync(p)) continue;
    try {
      if (nowMs - statSync(p).mtimeMs < MARKER_CLEAR_GRACE_MS) continue; // in-flight — leave it
      unlinkSync(p);
    } catch { /* ignore — best-effort cleanup */ }
  }
}

/**
 * Update heartbeat for the current agent.
 * Writes to: {ctxRoot}/state/{agent}/heartbeat.json
 * Matches bash update-heartbeat.sh format exactly.
 */
export function updateHeartbeat(
  paths: BusPaths,
  agentName: string,
  status: string,
  options?: { org?: string; timezone?: string; loopInterval?: string; currentTask?: string; displayName?: string; source?: 'session' | 'watchdog' },
): void {
  ensureDir(paths.stateDir);

  const ts = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  const mode = options?.timezone ? detectDayNightMode(options.timezone) : detectDayNightMode('UTC');
  const hbPath = join(paths.stateDir, 'heartbeat.json');

  // last_session_heartbeat advances ONLY on a genuine session-authored beat (the
  // default source). The 50-min watchdog beat (source=watchdog) MUST preserve the prior
  // value, never advance or zero it — the hang detector keys on last_session_heartbeat
  // to tell live session processing apart from the watchdog keeping last_heartbeat
  // fresh. updateHeartbeat rewrites the WHOLE object, so a watchdog beat carries the
  // prior value forward or it would be dropped (mass false-positive at the next sweep).
  const source = options?.source ?? 'session';
  let lastSessionHeartbeat: string | undefined = source === 'session' ? ts : undefined;
  if (source !== 'session' && existsSync(hbPath)) {
    try {
      lastSessionHeartbeat = (JSON.parse(readFileSync(hbPath, 'utf-8')) as Heartbeat).last_session_heartbeat;
    } catch { /* no prior value to carry forward — leave undefined (sensor fail-safes) */ }
  }

  const heartbeat: Heartbeat = {
    agent: agentName,
    org: options?.org ?? '',
    ...(options?.displayName ? { display_name: options.displayName } : {}),
    status,
    current_task: options?.currentTask ?? '',
    mode,
    last_heartbeat: ts,
    ...(lastSessionHeartbeat ? { last_session_heartbeat: lastSessionHeartbeat } : {}),
    loop_interval: options?.loopInterval ?? '',
  };

  atomicWriteSync(
    hbPath,
    JSON.stringify(heartbeat),
  );

  // The agent is alive in its (post-restart) session — clear stale SessionEnd
  // markers so the crash-alert hook cannot misclassify a later genuine crash
  // as a planned restart. Markers inside the grace window are left in place
  // (an in-flight restart's second hook firing may not have landed); they are
  // cleared on a later heartbeat. This is the primary marker cleanup; the
  // hook's TTL is the failed-start backstop.
  clearEndMarkers(paths.stateDir);
}

/**
 * Detect day/night mode based on timezone.
 * Day: 8:00 - 22:00, Night: 22:00 - 8:00
 */
export function detectDayNightMode(timezone: string): 'day' | 'night' {
  try {
    const now = new Date();
    const formatted = now.toLocaleString('en-US', { timeZone: timezone, hour12: false, hour: '2-digit' });
    const hour = parseInt(formatted, 10);
    return (hour >= 8 && hour < 22) ? 'day' : 'night';
  } catch {
    // Fallback to UTC
    const hour = new Date().getUTCHours();
    return (hour >= 8 && hour < 22) ? 'day' : 'night';
  }
}

/**
 * Read every heartbeat FILE that exists.
 *
 * NARROW CONTRACT, and the narrowness is the point: this answers "which agents have
 * written a heartbeat", NOT "which agents exist". It enumerates subdirectories of
 * `state/` and consults no roster, so an agent that has never beaten is ABSENT from
 * the result rather than reported as a gap, and a `state/` dir with no roster entry is
 * returned as though it were an agent.
 *
 * Use {@link readAllHeartbeatRows} for anything that reports on the fleet. This is kept
 * for callers that genuinely want the files and nothing more.
 */
export function readAllHeartbeats(paths: BusPaths): Heartbeat[] {
  const heartbeats: Heartbeat[] = [];
  const stateDir = join(paths.ctxRoot, 'state');
  let agentDirs: string[];
  try {
    agentDirs = readdirSync(stateDir, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name);
  } catch {
    return [];
  }

  for (const agent of agentDirs) {
    const hbPath = join(stateDir, agent, 'heartbeat.json');
    try {
      const content = readFileSync(hbPath, 'utf-8');
      heartbeats.push(JSON.parse(content));
    } catch {
      // Skip agents without heartbeat
    }
  }

  return heartbeats;
}

/**
 * Read the fleet by DUAL ENUMERATION: the roster UNION the `state/` directory scan.
 *
 * Rows are keyed on the roster where one exists, so DISABLED, DEAD and NEVER-BEATEN
 * become three renderable states instead of two collapsed into one plus a silent
 * omission. The roster side comes from {@link listAgents}, which already merges
 * `enabled-agents.json` with the org directory scan — reading the JSON alone would
 * relabel a real agent missing from that file as an orphan, which is BUG-028 rebuilt
 * one layer up.
 *
 * Scoped to ONE instance (`paths.ctxRoot`). `~/.cortextos/` holds several, and this
 * says nothing about the others; callers that mean "the whole machine" must iterate.
 *
 * PASS `org` WHEN ITERATING INSTANCES. The roster's two halves are scoped differently —
 * `enabled-agents.json` is per-instance, but the directory scan is global
 * (`CTX_FRAMEWORK_ROOT`) and, unfiltered, returns EVERY org's agents. Omitting `org`
 * during a multi-instance sweep therefore imports one instance's agents into another's
 * report, where they appear as confident `roster-only` rows for agents that do not
 * belong to it.
 */
export function readAllHeartbeatRows(paths: BusPaths, org?: string | string[]): HeartbeatRow[] {
  const rows = new Map<string, HeartbeatRow>();

  // 1. Roster axis — every agent that EXISTS, beaten or not.
  const orgs: (string | undefined)[] =
    org === undefined ? [undefined] : Array.isArray(org) ? org : [org];
  for (const o of orgs) {
    for (const a of listAgents(paths.ctxRoot, o)) {
      if (rows.has(a.name)) continue; // first org wins; never duplicate a name
      rows.set(a.name, {
        agent: a.name,
        org: a.org ?? null,
        source: 'roster-only',
        enabled: a.enabled,
        heartbeat: null,
      });
    }
  }

  // 2. State axis — every agent that has WRITTEN one. Keyed on the DIRECTORY name;
  //    the `agent` field inside the file is data, not identity.
  const stateDir = join(paths.ctxRoot, 'state');
  let dirs: string[] = [];
  try {
    dirs = readdirSync(stateDir, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name);
  } catch {
    // No state dir yet — the roster rows above still stand.
  }

  for (const dir of dirs) {
    const hbPath = join(stateDir, dir, 'heartbeat.json');
    if (!existsSync(hbPath)) continue; // not an agent dir at all (oauth/, usage/, …)

    const existing = rows.get(dir);
    const row: HeartbeatRow = existing
      ? { ...existing, source: 'roster+state' }
      : { agent: dir, org: null, source: 'state-only', enabled: null, heartbeat: null };

    try {
      const hb = JSON.parse(readFileSync(hbPath, 'utf-8')) as Heartbeat;
      row.heartbeat = hb;
      if (row.org === null) row.org = hb.org ?? null;
      if (hb.agent && hb.agent !== dir) row.nameMismatch = hb.agent;
    } catch {
      row.unreadable = true; // reported, never silently skipped
    }
    rows.set(dir, row);
  }

  return [...rows.values()].sort((a, b) => a.agent.localeCompare(b.agent));
}
