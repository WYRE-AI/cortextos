/**
 * tests/integration/concurrent-reminder-mutations.test.ts
 *
 * Pins the lost-update race flagged in PR #163 review (dev, task_1783983487266_03083173):
 * createReminder / ackReminder / markReminderInjected / pruneReminders all do
 * readReminders -> mutate -> writeReminders against ONE shared
 * pending-reminders.json, with no inter-process lock and a plain
 * writeFileSync — unlike bus/crons.ts's identical read-modify-write shape,
 * which uses withFileLockSync + atomicWriteSync right next to it in the same
 * codebase. Before this fix that gap was low-stakes (the only writer was a
 * rare restart); ReminderScheduler makes the daemon write every 30s per due
 * reminder, fleet-wide, concurrently with the agent independently running
 * `ack-reminder` in a separate CLI process — a real race, not theoretical.
 *
 * The repro spawns N real child PROCESSES (not just async calls — Node is
 * single-threaded, so only real OS processes can interleave mid-read/write),
 * each acking a DIFFERENT reminder ID against the same pending-reminders.json.
 * After all complete, every ack MUST be reflected on disk.
 *
 * SAFETY NOTE — why this does NOT spawn `dist/cli.js bus ack-reminder` the
 * way concurrent-cron-mutations.test.ts spawns `dist/cli.js bus update-cron`:
 * resolvePaths() (src/utils/paths.ts) hardcodes homedir() and ignores
 * CTX_ROOT entirely (task_1787945037599_69002535). The reminders CLI
 * commands call resolvePaths(), so a child spawned via the CLI with
 * CTX_ROOT overridden would silently write into the REAL production
 * ~/.cortextos state instead of the test's tmp dir. This test instead spawns
 * tests/integration/fixtures/reminder-mutate-child.ts via `tsx`, which
 * imports reminders.ts functions directly with an EXPLICIT BusPaths — the
 * same production code path (ackReminder -> readReminders/writeReminders),
 * fully sandboxed, zero risk to real agent state.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { createRequire } from 'module';
import { createReminder } from '../../src/bus/reminders';
import type { BusPaths, Reminder } from '../../src/types/index';

const execFileAsync = promisify(execFile);

const CHILD_SCRIPT = join(__dirname, 'fixtures', 'reminder-mutate-child.ts');

// Resolve tsx's CLI entry via Node's own module resolution (createRequire),
// not a hardcoded node_modules/.bin path — this repo's worktrees have their
// OWN near-empty node_modules and rely on Node walking up to the primary
// checkout's node_modules for everything, so a literal `.bin/tsx` path
// resolved relative to __dirname would not exist here even though tsx is
// genuinely reachable (verified: `npx tsx --version` works from this exact
// worktree). require.resolve uses the same walk-up algorithm construction
// relies on elsewhere, so it finds tsx regardless of hoisting depth.
const require_ = createRequire(__filename);
let tsxCliPath: string | null = null;
try {
  const tsxPkgPath = require_.resolve('tsx/package.json');
  tsxCliPath = join(dirname(tsxPkgPath), 'dist', 'cli.mjs');
  if (!existsSync(tsxCliPath)) tsxCliPath = null;
} catch {
  tsxCliPath = null;
}

let stateDir: string;

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

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), 'concurrent-reminders-'));
});

afterEach(() => {
  try { rmSync(stateDir, { recursive: true }); } catch { /* ignore */ }
});

function readRemindersFromDisk(): Reminder[] {
  const filePath = join(stateDir, 'pending-reminders.json');
  if (!existsSync(filePath)) return [];
  return JSON.parse(readFileSync(filePath, 'utf-8')) as Reminder[];
}

interface ChildResult {
  id: string;
  ok: boolean;
  code: number | null;
  stderr: string;
}

async function runAck(id: string): Promise<ChildResult> {
  try {
    await execFileAsync(process.execPath, [tsxCliPath!, CHILD_SCRIPT, stateDir, 'ack', id]);
    return { id, ok: true, code: 0, stderr: '' };
  } catch (err) {
    const e = err as { code?: number; stderr?: string; message?: string };
    return {
      id,
      ok: false,
      code: e.code ?? null,
      stderr: (e.stderr ?? e.message ?? '').slice(0, 400),
    };
  }
}

describe.skipIf(tsxCliPath === null)(
  'concurrent bus ack-reminder lost-update race (PR #163 review finding #2)',
  () => {
    it('N parallel acks against distinct reminders on one file — every ack MUST survive', async () => {
      const N = 8;
      const ITERATIONS = 5;
      const lostPerIteration: number[] = [];
      const forensics: string[] = [];
      let childFailures = 0;

      for (let iter = 0; iter < ITERATIONS; iter++) {
        const paths = makePaths(stateDir);
        const past = new Date(Date.now() - 1000).toISOString();
        const ids = Array.from({ length: N }, (_, i) =>
          createReminder(paths, past, `iter${iter}-reminder-${i}`).id,
        );

        const results = await Promise.all(ids.map(id => runAck(id)));

        const onDisk = readRemindersFromDisk();
        const lostIds = ids.filter(id => {
          const r = onDisk.find(x => x.id === id);
          return !r || r.status !== 'acked';
        });
        lostPerIteration.push(lostIds.length);

        const failed = results.filter(r => !r.ok);
        childFailures += failed.length;

        if (lostIds.length > 0 || failed.length > 0) {
          forensics.push(
            `iter ${iter}: lost=[${lostIds.join(', ') || 'none'}] childFailures=${failed.length}` +
            (failed.length
              ? ` -> ${failed.map(f => `${f.id} exit=${f.code} stderr=${JSON.stringify(f.stderr)}`).join(' | ')}`
              : ' (ALL CHILDREN EXITED 0 — an ack was overwritten while the lock was held)') +
            `\n  on-disk statuses: ${JSON.stringify(onDisk.map(r => `${r.id}=${r.status}`))}`,
          );
        }

        // Reminders don't get pruned mid-test; clear the file between
        // iterations so iteration N+1 starts from a known-empty state
        // instead of accumulating every prior iteration's rows.
        rmSync(join(stateDir, 'pending-reminders.json'), { force: true });
      }

      const totalLost = lostPerIteration.reduce((a, b) => a + b, 0);
      if (forensics.length > 0) {
        // eslint-disable-next-line no-console
        console.warn(
          `[concurrent-reminder-mutations] lost per iteration: ${lostPerIteration.join(', ')} ` +
          `(total ${totalLost} of ${N * ITERATIONS}), child failures: ${childFailures}\n` +
          forensics.join('\n'),
        );
      }
      expect(childFailures, `ack-reminder child process(es) failed:\n${forensics.join('\n')}`).toBe(0);
      expect(totalLost, `concurrent acks must not lose any update:\n${forensics.join('\n')}`).toBe(0);
    }, 60_000);
  },
);
