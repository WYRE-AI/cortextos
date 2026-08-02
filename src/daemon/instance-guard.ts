// Topology guard — 2026-07-13 two-daemon incident (duplicate fleet, bus
// double-delivery).
//
// ROOT CAUSE THIS PREVENTS
// ------------------------
// The daemon resolved its instance from env CTX_INSTANCE_ID ONLY and treated
// the `--instance <id>` argv (passed by ecosystem.config.js) as decoration.
// ecosystem.config.js resolves INSTANCE_ID from the CALLING shell at eval time
// and bakes it into the app env — so `pm2 start --update-env` from a shell
// without CTX_INSTANCE_ID set re-baked the *gateway-named* app onto instance
// 'default'. Both daemons then ran the same instance: duplicate agent
// lineages, double message delivery, dueling restarts. Silent split-brain.
//
// Two guards turn that class of divergence into a LOUD boot failure instead:
//   1. resolveInstanceId — argv and env must AGREE when both are present.
//   2. assertSingleDaemon — refuse to boot when the instance's daemon.pid
//      already points at a live process that isn't us.
// Refusing a boot is recoverable (pm2 logs show exactly why); a duplicate
// fleet is what this fleet just spent a day untangling.

import { chmodSync, existsSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { atomicWriteSync, ensureDir } from '../utils/atomic.js';
import { isPidAlive, processStartTimeMs, START_TIME_TOLERANCE_MS } from '../utils/agent-pidfile.js';

/** Extract the value of `--instance <id>` or `--instance=<id>`, or null. */
function argvInstance(argv: string[]): string | null {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--instance') {
      const next = argv[i + 1];
      // A missing/flag-like value is "unset", not a crash — same fail-safe
      // posture as the rest of the daemon's config parsing.
      return next && !next.startsWith('--') ? next : null;
    }
    if (a.startsWith('--instance=')) {
      return a.slice('--instance='.length) || null;
    }
  }
  return null;
}

/**
 * Resolve the daemon's instance id from argv + env, refusing to start on a
 * mismatch. Precedence when only one source is present: that source; when
 * neither: 'default'. Empty strings are unset, not values.
 */
export function resolveInstanceId(argv: string[], env: NodeJS.ProcessEnv): string {
  const fromArgv = argvInstance(argv);
  const fromEnv = env.CTX_INSTANCE_ID || null;

  if (fromArgv && fromEnv && fromArgv !== fromEnv) {
    throw new Error(
      `[daemon] REFUSING TO START: --instance argv says '${fromArgv}' but env CTX_INSTANCE_ID says '${fromEnv}'. ` +
      `These MUST agree — a mismatch means the pm2 app env was re-baked from the wrong shell ` +
      `(the classic vector: 'pm2 start --update-env' without CTX_INSTANCE_ID exported; see the ` +
      `2026-07-13 two-daemon incident). Fix: pm2 delete the app, then re-create it from a shell ` +
      `with CTX_INSTANCE_ID=${fromArgv} exported: 'CTX_INSTANCE_ID=${fromArgv} pm2 start ecosystem.config.js && pm2 save'.`,
    );
  }
  return fromArgv || fromEnv || 'default';
}

/**
 * Record this daemon's pid for the boot guard. Two files:
 *   daemon.pid        — bare int, format unchanged (operators `cat` it and the
 *                       deploy runbook's invariant check compares it to pm2's pid)
 *   daemon.start-time — epoch-ms process start time (`ps -o lstart=`), the
 *                       pid-recycling anchor assertSingleDaemon() uses to tell a
 *                       still-running daemon from a recycled pid after a crash
 *                       (daemon.pid is only unlinked on GRACEFUL shutdown, so a
 *                       crash leaves it behind indefinitely).
 * Best-effort on the anchor: if `ps` fails the anchor is simply absent, which
 * the guard treats as no-anchor (fail-closed), same as a legacy pidfile.
 *
 * WRITE ORDERING IS LOAD-BEARING: anchor FIRST, pid SECOND (pid = commit
 * point). Inverted, a failed anchor write pairs a FRESH pid with a STALE
 * anchor from a previous generation — a third daemon booting while this one
 * is live would observe start-time(live) ≠ stale-anchor as a positive
 * "recycled pid" disproof and boot past it: the guard inverted into a
 * false-BOOT. Anchor-first degrades the same failure to fresh-anchor +
 * OLD-dead-pid, which boots harmlessly and never disproves a live daemon.
 * Both writes are atomic (temp+rename) per repo convention.
 */
export function recordDaemonPid(ctxRoot: string, pid: number): void {
  ensureDir(ctxRoot);
  const pidFile = join(ctxRoot, 'daemon.pid');
  const anchorFile = join(ctxRoot, 'daemon.start-time');
  const startedAt = processStartTimeMs(pid);
  if (startedAt !== null) {
    atomicWriteSync(anchorFile, String(startedAt));
  } else {
    // `ps` hiccup — no anchor for THIS generation. A PRIOR generation's stale
    // anchor left next to the fresh pid would recreate the false-boot pairing
    // via this skip path (start-time(live) ≠ stale anchor = bogus "recycled"
    // disproof), so remove it: the state degrades to no-anchor = fail-closed
    // refuse, per the decision table on assertSingleDaemon.
    rmSync(anchorFile, { force: true });
  }
  atomicWriteSync(pidFile, String(pid));
  if (process.platform !== 'win32') {
    try {
      chmodSync(pidFile, 0o600);
      if (startedAt !== null) chmodSync(anchorFile, 0o600);
    } catch { /* best effort */ }
  }
}

/**
 * Single-daemon-per-instance boot guard: throw if this instance's daemon.pid
 * points at a live process other than us that we cannot POSITIVELY rule out as
 * a still-running daemon. Decision table (fail-closed on unknowns, boot only
 * on positive disproof — a wrong refusal is recoverable, a second daemon is
 * the split-brain):
 *   no file / dead pid / corrupt pid / our own pid  → boot
 *   alive + anchor MISMATCHES real start time       → boot (recycled pid — the
 *     crash-then-long-gap case: daemon.pid persists across crashes and the OS
 *     eventually reuses the pid for an unrelated process)
 *   alive + anchor matches                          → refuse (confirmed daemon)
 *   alive + no/corrupt/unreadable anchor            → refuse (cannot disprove)
 *
 * OPERATIONAL INVARIANT: the daemon uses pm2 restart / stop-then-start, NEVER
 * `pm2 reload` — reload spawns-new-before-kill-old, so this guard structurally
 * refuses it BY DESIGN. A refusal under reload is the guard working, not a bug.
 */
export function assertSingleDaemon(ctxRoot: string, currentPid: number): void {
  const pidFile = join(ctxRoot, 'daemon.pid');
  let recorded: number;
  try {
    if (!existsSync(pidFile)) return;
    recorded = parseInt(readFileSync(pidFile, 'utf-8').trim(), 10);
  } catch {
    return; // unreadable → cannot confirm a live daemon → boot
  }
  if (!Number.isInteger(recorded) || recorded <= 0) return; // corrupt → boot
  if (recorded === currentPid) return; // our own record (restart path)
  if (!isPidAlive(recorded)) return; // stale record from a crash → boot

  // Alive — check the start-time anchor before refusing (pid-recycling disproof).
  let anchor: number | null = null;
  try {
    const anchorFile = join(ctxRoot, 'daemon.start-time');
    if (existsSync(anchorFile)) {
      const parsed = parseInt(readFileSync(anchorFile, 'utf-8').trim(), 10);
      anchor = Number.isInteger(parsed) && parsed > 0 ? parsed : null;
    }
  } catch {
    anchor = null; // unreadable anchor → treated as absent (fail-closed below)
  }
  if (anchor !== null) {
    const observed = processStartTimeMs(recorded);
    if (observed !== null && Math.abs(observed - anchor) > START_TIME_TOLERANCE_MS) {
      return; // live pid is NOT the recorded daemon — recycled pid, safe to boot
    }
  }

  throw new Error(
    `[daemon] REFUSING TO START: ${pidFile} already points at live pid ${recorded} — ` +
    `a daemon for this instance appears to be running. Two daemons on one instance is the ` +
    `2026-07-13 split-brain incident. If that pid is NOT a cortextos daemon (stale file + ` +
    `pid reuse), delete ${pidFile} and start again; otherwise stop the existing daemon first ` +
    `(pm2 stop <app> or kill ${recorded}).`,
  );
}
