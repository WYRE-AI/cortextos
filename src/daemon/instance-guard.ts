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

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { isPidAlive } from '../utils/agent-pidfile.js';

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
 * Single-daemon-per-instance boot guard: throw if this instance's daemon.pid
 * points at a live process other than us. Unknown states (no file, dead pid,
 * corrupt content) boot fine — we only refuse when a second live daemon can be
 * POSITIVELY indicated. (A recycled pid can false-positive this; the error
 * says exactly how to clear a stale file, and refusing is the recoverable
 * direction for this incident class.)
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

  throw new Error(
    `[daemon] REFUSING TO START: ${pidFile} already points at live pid ${recorded} — ` +
    `a daemon for this instance appears to be running. Two daemons on one instance is the ` +
    `2026-07-13 split-brain incident. If that pid is NOT a cortextos daemon (stale file + ` +
    `pid reuse), delete ${pidFile} and start again; otherwise stop the existing daemon first ` +
    `(pm2 stop <app> or kill ${recorded}).`,
  );
}
