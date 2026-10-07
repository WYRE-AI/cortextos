/**
 * tests/integration/concurrent-task-blocker-mutations.test.ts
 *
 * Pins the concurrent-cycle race that motivated taskGraphLockDir on #141
 * (analyst's finding: the lock-ordering fix was correct by inspection but
 * had no test that actually exercised concurrent execution).
 *
 * The race: task A and task B start with no edges between them. Two
 * concurrent `update-task` calls run at the same time — one adding "A
 * blocked_by B", the other adding "B blocked_by A". Each call's cycle
 * check (detectCycleOrThrow) reads the OTHER task's blocked_by from disk.
 * If both calls read before either writes, each sees an edge-free graph,
 * each independently concludes its own addition is cycle-free, and both
 * writes land — a real two-task cycle that neither call's own (correct,
 * in isolation) validation ever saw.
 *
 * With taskGraphLockDir serializing the whole validate-then-write sequence,
 * this becomes impossible: whichever call acquires the lock first commits
 * its edge; the second call then validates against the GRAPH AS IT NOW
 * ACTUALLY IS and correctly rejects its own addition as a cycle. Expected
 * outcome, every iteration: exactly one child succeeds, exactly one child
 * fails with a cycle error, and the two edges are never BOTH present.
 *
 * Spawns real child processes via the production CLI (`node dist/cli.js
 * bus update-task`), same harness pattern as concurrent-cron-mutations.test.ts
 * and concurrent-reminder-mutations.test.ts. Requires `npm run build` to have
 * produced `dist/cli.js` — skipped with a clear message if absent.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

const REPO_ROOT = join(__dirname, '..', '..');
const DIST_CLI  = join(REPO_ROOT, 'dist', 'cli.js');
const ORG = 'testorg';

let fakeHome: string;

beforeEach(() => {
  // resolvePaths() derives ctxRoot from os.homedir() — isolate via HOME,
  // same convention as bus-task-error-handling-cli.test.ts.
  fakeHome = mkdtempSync(join(tmpdir(), 'concurrent-task-blockers-'));
  mkdirSync(join(fakeHome, '.cortextos', 'default', 'orgs', ORG, 'tasks'), { recursive: true });
});

afterEach(() => {
  try { rmSync(fakeHome, { recursive: true }); } catch { /* ignore */ }
});

function taskPath(id: string): string {
  return join(fakeHome, '.cortextos', 'default', 'orgs', ORG, 'tasks', `${id}.json`);
}

function writeTask(id: string, overrides: Record<string, unknown> = {}): void {
  const task = {
    id,
    title: 'test task',
    description: '',
    type: 'agent',
    needs_approval: false,
    status: 'pending',
    assigned_to: 'dev',
    created_by: 'dev',
    org: ORG,
    priority: 'normal',
    project: '',
    kpi_key: null,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    completed_at: null,
    due_date: null,
    archived: false,
    ...overrides,
  };
  writeFileSync(taskPath(id), JSON.stringify(task));
}

function readTask(id: string): { blocked_by?: string[]; blocks?: string[] } {
  return JSON.parse(readFileSync(taskPath(id), 'utf-8'));
}

interface ChildResult {
  ok: boolean;
  code: number | null;
  stderr: string;
}

async function runUpdateTaskBlockedBy(taskId: string, blockerId: string): Promise<ChildResult> {
  try {
    await execFileAsync(
      process.execPath,
      [DIST_CLI, 'bus', 'update-task', taskId, '--blocked-by', blockerId],
      { env: { ...process.env, HOME: fakeHome, CTX_AGENT_NAME: 'dev', CTX_ORG: ORG } },
    );
    return { ok: true, code: 0, stderr: '' };
  } catch (err) {
    const e = err as { code?: number; stderr?: string; message?: string };
    return { ok: false, code: e.code ?? null, stderr: (e.stderr ?? e.message ?? '').slice(0, 400) };
  }
}

describe.skipIf(!existsSync(DIST_CLI))('concurrent update-task --blocked-by: cross-task cycle race', () => {
  it('two concurrent mutually-blocking updates must never BOTH succeed (pinned, expected to FAIL pre-fix)', async () => {
    const ITERATIONS = 8;
    const badIterations: string[] = [];

    for (let iter = 0; iter < ITERATIONS; iter++) {
      const a = `task_race_a_${iter}`;
      const b = `task_race_b_${iter}`;
      writeTask(a);
      writeTask(b);

      // Concurrent: A declares "blocked_by B" while B declares "blocked_by A".
      const [resA, resB] = await Promise.all([
        runUpdateTaskBlockedBy(a, b),
        runUpdateTaskBlockedBy(b, a),
      ]);

      const aAfter = readTask(a);
      const bAfter = readTask(b);
      const aBlockedByB = (aAfter.blocked_by ?? []).includes(b);
      const bBlockedByA = (bAfter.blocked_by ?? []).includes(a);

      const bothSucceeded = resA.ok && resB.ok;
      const bothEdgesPresent = aBlockedByB && bBlockedByA;
      const exactlyOneSucceeded = resA.ok !== resB.ok;
      const theFailureMentionsCycle =
        (!resA.ok && /cycle/i.test(resA.stderr)) || (!resB.ok && /cycle/i.test(resB.stderr));

      if (bothSucceeded || bothEdgesPresent || !exactlyOneSucceeded || !theFailureMentionsCycle) {
        badIterations.push(
          `iter ${iter}: resA.ok=${resA.ok} resB.ok=${resB.ok} ` +
          `aBlockedByB=${aBlockedByB} bBlockedByA=${bBlockedByA} ` +
          `resA.stderr=${JSON.stringify(resA.stderr)} resB.stderr=${JSON.stringify(resB.stderr)}`,
        );
      }
    }

    expect(
      badIterations,
      `concurrent mutually-blocking update-task calls must resolve to exactly one ` +
      `cycle-rejected loser every time, never both succeeding:\n${badIterations.join('\n')}`,
    ).toEqual([]);
  }, 60_000);
});
