/**
 * hook-activity-beat.ts — PreToolUse hook.
 *
 * Writes a Unix timestamp to last_activity.flag on EVERY tool call, mid-turn —
 * unlike the Stop hook (hook-idle-flag.ts), which only writes on turn
 * COMPLETION. This closes hang-detector class 3: a single work turn that runs
 * longer than the grace window (a build, a full test suite, a long research
 * pass) and spans a delivered cron fire reads as beatless under the existing
 * dual-source read (last_session_heartbeat / last_idle.flag), because neither
 * source updates until the turn finishes — even though the session is
 * actively working the whole time. Every tool call is itself proof of
 * liveness, so this is a third, mid-turn-capable source. See
 * src/daemon/hang-detector.ts for how it's combined with the other two.
 *
 * Deliberately as cheap and fail-safe as hook-idle-flag.ts: never blocks the
 * tool call, never throws past main(), ignores its stdin payload entirely
 * (only the timing of the call matters, not which tool or what args).
 */
import { writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

async function main(): Promise<void> {
  const agentName = process.env.CTX_AGENT_NAME;
  const instanceId = process.env.CTX_INSTANCE_ID || 'default';
  if (!agentName) return;

  const stateDir = join(homedir(), '.cortextos', instanceId, 'state', agentName);
  try {
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, 'last_activity.flag'), String(Math.floor(Date.now() / 1000)), 'utf-8');
  } catch { /* ignore */ }
}

main().catch(() => process.exit(0));
