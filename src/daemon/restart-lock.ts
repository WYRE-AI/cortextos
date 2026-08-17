import { readFileSync, writeFileSync, unlinkSync } from 'fs';
import { join } from 'path';

// Cross-path restart-in-flight lock (2026-07-13 restart-storm fix).
//
// CONFIRMED root mechanism: the automated hang/context actuators (fast-checker.ts's
// forceHangRestart/forceContextRestart, calling AgentProcess.sessionRefresh() directly)
// and the manual/CLI restart path (agent-manager.ts's restartAgent, calling
// stopAgent+startAgent) are two structurally DIFFERENT call shapes on the same agent,
// sharing NO coordination. If both fire within seconds of each other, each is unaware
// the other already restarted the agent — both spawn a fresh session, producing two
// live duplicates. This lock is the single shared gate BOTH paths check first.
//
// GOVERNING PRINCIPLE — fail OPEN on lock-mechanism trouble: this lock exists to
// prevent a double-restart, not to gate whether a restart is allowed to happen at all.
// If the lock file itself can't be read/written, the safer default is to let the
// restart proceed (a hung/crashed agent staying hung is worse than an occasional
// double-restart from a rare fs error) — but that fallback is loud (returns a reason
// string a caller should log), never silent.

const STALE_MS = 2 * 60_000; // well beyond any real restart's duration; reclaim if the holder crashed mid-restart without releasing

export interface RestartLockResult {
  acquired: boolean;
  reason: string;
}

interface LockFileData {
  source: string;
  at: number;
}

function lockPath(stateDir: string): string {
  return join(stateDir, '.restart-in-flight');
}

/**
 * Attempt to acquire the restart-in-flight lock for an agent's state directory.
 * `source` identifies the caller (e.g. 'hang-detector', 'context-handoff',
 * 'manual-cli-restart') purely for logging/diagnostics — it has no effect on
 * acquisition logic (a second attempt from the SAME source is blocked too, not just
 * cross-source, since the point is "is a restart already in flight", not "is a
 * DIFFERENT kind of restart in flight").
 *
 * ATOMIC by construction: the primary acquire attempt is a SINGLE `writeFileSync`
 * with the `wx` flag (open with O_CREAT|O_EXCL — fails with EEXIST if the file
 * already exists), not a separate existsSync-then-writeFileSync pair. The prior
 * two-call version had a real TOCTOU window: two processes could both pass the
 * existsSync check before either's writeFileSync landed, both believing they'd
 * acquired. `wx` closes that at the OS level — the create-if-absent check and the
 * write happen as one atomic syscall.
 */
export function tryAcquireRestartLock(stateDir: string, source: string): RestartLockResult {
  const path = lockPath(stateDir);
  try {
    writeFileSync(path, JSON.stringify({ source, at: Date.now() } satisfies LockFileData), { encoding: 'utf-8', flag: 'wx' });
    return { acquired: true, reason: 'acquired' };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code !== 'EEXIST') {
      // Fail-open on any OTHER lock-mechanism trouble (permissions, disk full, etc.)
      // — see the governing-principle note at the top of this file.
      return { acquired: true, reason: `lock check failed (${err instanceof Error ? err.message : String(err)}) — proceeding fail-open` };
    }
    // EEXIST: something is already holding the lock. Read it to decide fresh-vs-stale.
    try {
      const raw = readFileSync(path, 'utf-8');
      const data = JSON.parse(raw) as LockFileData;
      if (typeof data.at === 'number' && typeof data.source === 'string') {
        const age = Date.now() - data.at;
        if (age < STALE_MS) {
          return {
            acquired: false,
            reason: `restart already in flight (source=${data.source}, ${Math.round(age / 1000)}s ago)`,
          };
        }
        // Stale — the holder likely crashed mid-restart without releasing. Reclaim.
      }
      // Malformed content (missing/wrong-typed fields) — treat like stale, reclaim.
    } catch {
      // Couldn't read/parse the existing lock — treat as reclaimable rather than
      // fail-closed-forever on a corrupt file.
    }
    // Reclaim: overwrite unconditionally (no `wx` needed here — we've already
    // decided the existing holder is stale/corrupt/unreadable and are taking over).
    try {
      writeFileSync(path, JSON.stringify({ source, at: Date.now() } satisfies LockFileData), 'utf-8');
      return { acquired: true, reason: 'acquired (reclaimed stale/corrupt lock)' };
    } catch (writeErr) {
      return { acquired: true, reason: `lock reclaim-write failed (${writeErr instanceof Error ? writeErr.message : String(writeErr)}) — proceeding fail-open` };
    }
  }
}

/**
 * Read-only peek: is a restart currently in flight for this agent?
 *
 * Non-mutating counterpart to tryAcquireRestartLock — used by
 * injectMessageDetailed (agent-process.ts) to check the SAME lock the
 * restart paths use, without acquiring/reclaiming it. Mirrors
 * tryAcquireRestartLock's staleness logic exactly (a lock older than
 * STALE_MS, or unreadable/malformed, is treated as NOT in flight — the
 * governing fail-open principle above applies here too: a peek that can't
 * confirm a restart is genuinely in flight must not block message
 * injection on a hunch).
 */
export function isRestartInFlight(stateDir: string): boolean {
  const path = lockPath(stateDir);
  try {
    const raw = readFileSync(path, 'utf-8');
    const data = JSON.parse(raw) as LockFileData;
    if (typeof data.at !== 'number' || typeof data.source !== 'string') return false;
    return Date.now() - data.at < STALE_MS;
  } catch {
    // No lock file, or unreadable/malformed — not in flight (fail-open).
    return false;
  }
}

/** Release the restart-in-flight lock. Harmless no-op if already clear. */
export function releaseRestartLock(stateDir: string): void {
  try {
    unlinkSync(lockPath(stateDir));
  } catch {
    // Non-critical — a missing file (already released, or never acquired) is fine;
    // and if unlink genuinely fails for another reason, the staleness timeout above
    // reclaims it eventually rather than wedging the lock forever.
  }
}
