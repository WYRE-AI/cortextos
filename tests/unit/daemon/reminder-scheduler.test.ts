/**
 * tests/unit/daemon/reminder-scheduler.test.ts
 *
 * Unit tests for ReminderScheduler — the live 30s poller that closes the gap
 * documented in task_1783983487266_03083173: getOverdueReminders() was only
 * ever read from buildReminderBlock() (restart-only paths), so a reminder
 * scheduled during a continuously-running session was silently skipped
 * forever until the agent happened to restart after fire_at.
 *
 * All timing is driven by vitest fake timers, mirroring cron-scheduler.test.ts.
 * Disk I/O goes through a real tmp BusPaths dir (reminders.ts has no I/O to
 * mock behind an interface the way crons.ts does) so tests exercise the real
 * read/write/mark-injected round trip, not a mock of it.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { ReminderScheduler } from '../../../src/daemon/reminder-scheduler';
import {
  createReminder,
  listReminders,
  ackReminder,
} from '../../../src/bus/reminders';
import type { BusPaths } from '../../../src/types/index';

function makePaths(dir: string): BusPaths {
  return {
    ctxRoot: dir,
    inbox: join(dir, 'inbox'),
    inflight: join(dir, 'inflight'),
    processed: join(dir, 'processed'),
    logDir: join(dir, 'logs'),
    stateDir: join(dir, 'state'),
    taskDir: join(dir, 'tasks'),
    approvalDir: join(dir, 'approvals'),
    analyticsDir: join(dir, 'analytics'),
  };
}

const TICK = ReminderScheduler.TICK_INTERVAL_MS;

describe('ReminderScheduler', () => {
  let testDir: string;
  let paths: BusPaths;
  let injected: string[];
  let injectResult: boolean;
  let logs: string[];
  let scheduler: ReminderScheduler;

  beforeEach(() => {
    vi.useFakeTimers();
    testDir = join(tmpdir(), `reminder-scheduler-test-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
    paths = makePaths(testDir);
    injected = [];
    injectResult = true;
    logs = [];

    scheduler = new ReminderScheduler({
      agentName: 'test-agent',
      logger: (msg) => { logs.push(msg); },
      // Test double for AgentManager.injectAgent — records the text and
      // returns injectResult (flip to false to simulate "agent not running").
      inject: (_agentName, text) => {
        injected.push(text);
        return injectResult;
      },
      // Point the scheduler at the tmp dir instead of the real ~/.cortextos —
      // resolvePathsFn mirrors the shape of resolvePaths(agentName, instanceId)
      // but the test supplies its own so no real home-dir I/O happens.
      resolvePathsFn: () => paths,
    });
  });

  afterEach(() => {
    scheduler.stop();
    vi.useRealTimers();
    rmSync(testDir, { recursive: true, force: true });
  });

  it('injects an overdue reminder on the next tick', async () => {
    const past = new Date(Date.now() - 1000).toISOString();
    const r = createReminder(paths, past, 'check the deploy');
    scheduler.start();

    await vi.advanceTimersByTimeAsync(TICK);

    expect(injected).toHaveLength(1);
    expect(injected[0]).toContain('check the deploy');
    expect(injected[0]).toContain(r.id);
  });

  it('does not inject a reminder that is not yet due', async () => {
    const future = new Date(Date.now() + 3600_000).toISOString();
    createReminder(paths, future, 'not yet');
    scheduler.start();

    await vi.advanceTimersByTimeAsync(TICK * 3);

    expect(injected).toHaveLength(0);
  });

  it('marks the reminder injected after a successful delivery, and never re-injects it', async () => {
    const past = new Date(Date.now() - 1000).toISOString();
    const r = createReminder(paths, past, 'once only');
    scheduler.start();

    await vi.advanceTimersByTimeAsync(TICK * 5);

    expect(injected).toHaveLength(1);
    const all = listReminders(paths, { all: true });
    expect(all.find(x => x.id === r.id)?.injected_at).toBeTruthy();
  });

  it('retries on the next tick if inject fails (agent not running)', async () => {
    injectResult = false;
    const past = new Date(Date.now() - 1000).toISOString();
    createReminder(paths, past, 'retry me');
    scheduler.start();

    await vi.advanceTimersByTimeAsync(TICK * 2);
    expect(injected.length).toBeGreaterThanOrEqual(2); // attempted at least twice, never marked injected

    const all = listReminders(paths, { all: true });
    expect(all[0].injected_at).toBeFalsy();

    // Now let it succeed — the very next tick should deliver it exactly once more.
    injectResult = true;
    const countBefore = injected.length;
    await vi.advanceTimersByTimeAsync(TICK);
    expect(injected.length).toBe(countBefore + 1);

    await vi.advanceTimersByTimeAsync(TICK * 3);
    expect(injected.length).toBe(countBefore + 1); // no further retries once delivered
  });

  it('does not inject an already-acked reminder', async () => {
    const past = new Date(Date.now() - 1000).toISOString();
    const r = createReminder(paths, past, 'handled already');
    ackReminder(paths, r.id);
    scheduler.start();

    await vi.advanceTimersByTimeAsync(TICK * 3);

    expect(injected).toHaveLength(0);
  });

  it('delivers multiple independently-overdue reminders in the same tick', async () => {
    const past = new Date(Date.now() - 1000).toISOString();
    createReminder(paths, past, 'first');
    createReminder(paths, past, 'second');
    scheduler.start();

    await vi.advanceTimersByTimeAsync(TICK);

    expect(injected).toHaveLength(2);
  });

  it('stop() clears the timer so no further ticks fire', async () => {
    const past = new Date(Date.now() - 1000).toISOString();
    createReminder(paths, past, 'stop test');
    scheduler.start();
    scheduler.stop();

    await vi.advanceTimersByTimeAsync(TICK * 5);

    expect(injected).toHaveLength(0);
  });

  it('a failed resolvePathsFn logs a warning and does not throw', async () => {
    const throwingScheduler = new ReminderScheduler({
      agentName: 'broken-agent',
      inject: () => true,
      logger: (msg) => { logs.push(msg); },
      resolvePathsFn: () => { throw new Error('boom'); },
    });
    throwingScheduler.start();

    await vi.advanceTimersByTimeAsync(TICK); // must not throw / reject
    expect(logs.some(l => l.includes('boom'))).toBe(true);

    throwingScheduler.stop();
  });
});
