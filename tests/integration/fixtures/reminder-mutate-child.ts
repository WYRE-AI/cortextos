/**
 * Standalone child-process fixture for concurrent-reminder-mutations.test.ts.
 *
 * Deliberately bypasses resolveEnv()/resolvePaths() — resolvePaths()
 * hardcodes homedir() and ignores CTX_ROOT (task_1787945037599_69002535), so
 * the real `bus ack-reminder` CLI cannot be safely sandboxed into a tmp dir
 * today: a child spawned through the CLI with CTX_ROOT overridden would
 * silently write into the REAL production ~/.cortextos state instead. This
 * fixture imports reminders.ts functions directly with an explicit BusPaths
 * pointed at the test's own tmp dir, so a real multi-process concurrency
 * test is possible without that risk.
 *
 * Usage: tsx reminder-mutate-child.ts <stateDir> <ack|mark-injected> <id>
 */
import { ackReminder, markReminderInjected } from '../../../src/bus/reminders';
import type { BusPaths } from '../../../src/types/index';

const [, , stateDir, op, id] = process.argv;

if (!stateDir || !op || !id) {
  console.error('usage: reminder-mutate-child.ts <stateDir> <ack|mark-injected> <id>');
  process.exit(2);
}

function makePaths(dir: string): BusPaths {
  return {
    ctxRoot: dir,
    inbox: dir,
    inflight: dir,
    processed: dir,
    logDir: dir,
    stateDir: dir,
    taskDir: dir,
    approvalDir: dir,
    analyticsDir: dir,
  } as BusPaths;
}

const paths = makePaths(stateDir);

switch (op) {
  case 'ack':
    ackReminder(paths, id);
    break;
  case 'mark-injected':
    markReminderInjected(paths, id);
    break;
  default:
    console.error(`unknown op: ${op}`);
    process.exit(2);
}
