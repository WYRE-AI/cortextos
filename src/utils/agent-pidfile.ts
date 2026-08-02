// Per-agent PID tracking + ownership-verified reaping.
//
// WHY THIS EXISTS
// ---------------
// The daemon tracks running agents in an in-memory Map (AgentManager.agents).
// start/stop/dedup all key off that Map with no reconcile against real process
// liveness, so the Map can diverge from reality:
//   - a PTY that survives a daemon crash is not in the new Map => `stop` no-ops
//     and never kills it ("stop didn't kill murph");
//   - a Map entry whose PTY died via a path that skipped onExit blocks every
//     future `start` with "deduped — already in registry".
// This module persists each agent's PTY pid to disk so liveness is checkable
// ACROSS daemon generations, and provides an OWNERSHIP-VERIFIED reap so we never
// kill the wrong process.
//
// SAFETY (load-bearing — a wrong kill destabilizes the fleet)
// -----------------------------------------------------------
// The catastrophic case is pid recycling: our agent dies, the OS reassigns its
// pid to an unrelated process, and a naive reaper kills that innocent process.
// Guard: a recorded pid is only ever reaped when BOTH
//   (a) it is alive (process.kill(pid, 0) does not throw ESRCH), AND
//   (b) its ACTUAL process start time matches the start time we recorded when we
//       spawned it (a recycled pid gets a brand-new, much-later start time).
// If ownership cannot be POSITIVELY confirmed, we refuse to kill and return
// 'unverified' — failing closed. Missing an orphan is recoverable; killing a
// live bystander is not.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export interface AgentPidRecord {
  pid: number;
  agentName: string;
  /** Date.now() at spawn (ms). */
  spawnedAt: number;
  /** Process start time (epoch ms) captured just after spawn — the recycling anchor. */
  startedAt: number | null;
  /** Daemon pid that spawned this PTY — distinguishes our generation from a foreign daemon. */
  daemonPid: number;
}

/** How far apart the recorded and observed process start times may be and still
 *  be considered the same process. lstart granularity is 1s; allow generous slack
 *  for clock/parse jitter. A recycled pid is off by many seconds-to-days. */
const START_TIME_TOLERANCE_MS = 5_000;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function pidFilePath(stateDir: string): string {
  return join(stateDir, 'agent.pid');
}

/** Epoch-ms start time of a live pid via `ps -o lstart=`, or null if unavailable. */
export function processStartTimeMs(pid: number): number | null {
  try {
    const out = execFileSync('ps', ['-p', String(pid), '-o', 'lstart='], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (!out) return null;
    const ms = Date.parse(out);
    return Number.isNaN(ms) ? null : ms;
  } catch {
    // pid not found / ps failed — treat as unknown.
    return null;
  }
}

/** True if the pid exists (alive). ESRCH => dead; EPERM => alive but not ours. */
export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Record this agent's PTY pid after a successful spawn. Best-effort; never throws. */
export function writeAgentPid(stateDir: string, agentName: string, pid: number, daemonPid: number): void {
  try {
    const file = pidFilePath(stateDir);
    if (!existsSync(dirname(file))) mkdirSync(dirname(file), { recursive: true });
    const record: AgentPidRecord = {
      pid,
      agentName,
      spawnedAt: Date.now(),
      startedAt: processStartTimeMs(pid),
      daemonPid,
    };
    writeFileSync(file, JSON.stringify(record), 'utf-8');
  } catch {
    // pidfile is an optimization for reconcile; never let it break spawn.
  }
}

/** Read the recorded pid, or null if missing/corrupt. */
export function readAgentPid(stateDir: string): AgentPidRecord | null {
  const file = pidFilePath(stateDir);
  if (!existsSync(file)) return null;
  try {
    const rec = JSON.parse(readFileSync(file, 'utf-8')) as AgentPidRecord;
    if (typeof rec?.pid !== 'number' || rec.pid <= 0) return null;
    return rec;
  } catch {
    return null;
  }
}

/** Remove the pidfile (clean stop / after a confirmed reap). Best-effort. */
export function clearAgentPid(stateDir: string): void {
  try {
    rmSync(pidFilePath(stateDir), { force: true });
  } catch {
    /* ignore */
  }
}

export type OwnershipVerdict = 'owned' | 'dead' | 'unverified';

/**
 * Decide whether a recorded pid may be safely reaped as THIS agent's process.
 *   'dead'       — pid is not alive (safe to clear registry/pidfile, nothing to kill)
 *   'owned'      — pid is alive AND its start time matches our record => our process
 *   'unverified' — pid is alive but ownership could NOT be confirmed (recycled? foreign?)
 *                  => DO NOT KILL. Fail closed.
 */
export function verifyOwnership(record: AgentPidRecord): OwnershipVerdict {
  if (!isPidAlive(record.pid)) return 'dead';
  // Alive — confirm it is still OUR process via start-time anchor.
  if (record.startedAt == null) return 'unverified'; // no anchor recorded — cannot prove
  const observed = processStartTimeMs(record.pid);
  if (observed == null) return 'unverified';
  return Math.abs(observed - record.startedAt) <= START_TIME_TOLERANCE_MS ? 'owned' : 'unverified';
}

export interface ReapResult {
  reaped: boolean;
  verdict: OwnershipVerdict;
  pid: number;
}

/**
 * Ownership-verified reap of an orphaned agent PTY recorded in the pidfile.
 * Kills ONLY when ownership is positively confirmed ('owned'). SIGTERM, then
 * SIGKILL after a short grace if still alive. Clears the pidfile on 'owned'/'dead'.
 * On 'unverified' it leaves the process and the pidfile untouched and lets the
 * caller surface a warning.
 */
export async function reapOrphan(
  stateDir: string,
  record: AgentPidRecord,
  log: (msg: string) => void,
  sigkillDelayMs = 2_000,
): Promise<ReapResult> {
  const verdict = verifyOwnership(record);
  if (verdict === 'dead') {
    clearAgentPid(stateDir);
    return { reaped: false, verdict, pid: record.pid };
  }
  if (verdict === 'unverified') {
    log(
      `[reap] REFUSING to kill pid ${record.pid} for ${record.agentName}: ownership unverified ` +
        `(alive but start-time does not match record — likely a recycled/foreign pid). Manual check advised.`,
    );
    return { reaped: false, verdict, pid: record.pid };
  }
  // verdict === 'owned' — safe to signal.
  let ended = false;
  try {
    process.kill(record.pid, 'SIGTERM');
    const deadline = Date.now() + sigkillDelayMs;
    while (Date.now() < deadline && isPidAlive(record.pid)) {
      await sleep(50); // async grace wait — does not serialize other boot reaps
    }
    if (!isPidAlive(record.pid)) {
      ended = true;
      log(`[reap] reaped orphaned PTY pid ${record.pid} for ${record.agentName} (exited on SIGTERM).`);
    } else if (verifyOwnership(record) === 'owned') {
      // TOCTOU guard: the pid may have exited on SIGTERM and been RECYCLED to an
      // unrelated process during the grace window. We only reach here when it is
      // STILL provably our process — so escalating is safe.
      process.kill(record.pid, 'SIGKILL');
      ended = true;
      log(`[reap] SIGKILLed orphaned PTY pid ${record.pid} for ${record.agentName} (ownership re-confirmed).`);
    } else {
      // Alive but no longer ownership-verified (exited on SIGTERM then recycled?,
      // or a transient ps failure). Fail closed: do NOT SIGKILL. ACCRETION GUARD:
      // leave `ended` false so the pidfile is NOT cleared below — otherwise a
      // still-alive orphan would become untracked and evade the next boot-reap.
      log(
        `[reap] pid ${record.pid} for ${record.agentName} is no longer ownership-verified before SIGKILL ` +
          `— NOT sending SIGKILL and LEAVING the pidfile for the next boot-reap.`,
      );
    }
  } catch (err) {
    log(`[reap] error reaping pid ${record.pid} for ${record.agentName}: ${(err as Error).message}`);
  }
  // Only clear the pidfile when the process is actually gone. Clearing it while
  // the process is still alive (the fail-closed skip above) would orphan it from
  // the next boot-reap (accretion) and make `reaped` dishonest.
  if (ended) clearAgentPid(stateDir);
  return { reaped: ended, verdict, pid: record.pid };
}
