/**
 * tests/unit/cli/check-batch-staleness.test.ts
 *
 * Covers `bus check-batch-staleness <batch-id>` — the orphan-task-watchdog
 * follow-up to dispatch-batch (#160, task_1787921691733_11462336). An
 * in_progress batch item whose assignee session died mid-item sits
 * indistinguishable from a genuinely active one under a plain
 * `list-tasks --project <id>` view; this command scans one batch and reports
 * which in_progress items have gone stale past a threshold instead of
 * trusting "in_progress" forever. Pattern drawn from Hermes/NousResearch's
 * A2A peering model: a timeout on a pending state should transition it to an
 * explicit terminal/flagged state, not leave it in silent limbo
 * (task_1788300304747_69074594).
 *
 * `checkBatchStaleness` is mocked, following dispatch-batch.test.ts's
 * approach: the pure report-building logic (bucketing, threshold math,
 * project scoping) already has direct coverage against a real tempdir
 * BusPaths in tests/unit/bus/task-management.test.ts. This file exercises
 * only the CLI wrapper's own logic — argument/option wiring, the
 * --stale-after default and override, invalid-duration handling, and that
 * the report is printed as a single JSON line (matching check-stale-tasks'
 * and archive-tasks' existing output convention).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const checkBatchStalenessMock = vi.fn(() => ({
  project: 'batch-mock',
  stale_after_ms: 7_200_000,
  total: 0,
  orphaned: [],
  active: [],
  pending: [],
  completed: 0,
  blocked: 0,
  cancelled: 0,
}));

vi.mock('../../../src/bus/task.js', () => ({
  createTask: vi.fn(),
  updateTask: vi.fn(),
  completeTask: vi.fn(),
  claimTask: vi.fn(),
  readTaskAudit: vi.fn(),
  checkTaskDependenciesWithStatus: vi.fn(),
  compactTasks: vi.fn(),
  listTasks: vi.fn(),
  checkStaleTasks: vi.fn(),
  checkBatchStaleness: (...args: unknown[]) => checkBatchStalenessMock(...args),
  archiveTasks: vi.fn(),
  checkHumanTasks: vi.fn(),
}));

vi.mock('../../../src/bus/message.js', () => ({
  sendMessage: vi.fn(),
  checkInboxWithStatus: vi.fn(),
  ackInbox: vi.fn(),
}));

import { busCommand } from '../../../src/cli/bus';

function mockExit(): ReturnType<typeof vi.spyOn> {
  return vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new Error(`__PROCESS_EXIT_${code}__`);
  }) as never);
}

beforeEach(() => {
  checkBatchStalenessMock.mockClear();
  // vi.spyOn returns the SAME underlying spy on repeat calls against the
  // same method, so without an explicit clear here call counts would
  // accumulate across tests in this file (the log call from test N would
  // still be sitting in test N+1's spy history).
  vi.spyOn(console, 'log').mockImplementation(() => {}).mockClear();
  vi.spyOn(console, 'error').mockImplementation(() => {}).mockClear();
  process.env.CTX_AGENT_NAME = 'dispatcher';
  process.env.CTX_INSTANCE_ID = 'default';
  process.env.CTX_ORG = 'testorg';
});

describe('bus check-batch-staleness', () => {
  it('forwards the batch id and the 2h default threshold when --stale-after is omitted', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});

    await busCommand.parseAsync(['node', 'bus', 'check-batch-staleness', 'batch-123']);

    expect(checkBatchStalenessMock).toHaveBeenCalledTimes(1);
    const [, project, staleAfterMs] = checkBatchStalenessMock.mock.calls[0];
    expect(project).toBe('batch-123');
    expect(staleAfterMs).toBe(7_200_000); // 2h
  });

  it('parses a custom --stale-after duration into milliseconds', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});

    await busCommand.parseAsync(['node', 'bus', 'check-batch-staleness', 'batch-123', '--stale-after', '30m']);

    const [, , staleAfterMs] = checkBatchStalenessMock.mock.calls[0];
    expect(staleAfterMs).toBe(1_800_000); // 30m
  });

  it('prints the report as a single JSON line', async () => {
    checkBatchStalenessMock.mockReturnValueOnce({
      project: 'batch-123',
      stale_after_ms: 7_200_000,
      total: 2,
      orphaned: [{ id: 'task_a' }],
      active: [{ id: 'task_b' }],
      pending: [],
      completed: 0,
      blocked: 0,
      cancelled: 0,
    } as never);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await busCommand.parseAsync(['node', 'bus', 'check-batch-staleness', 'batch-123']);

    expect(logSpy).toHaveBeenCalledTimes(1);
    const parsed = JSON.parse(logSpy.mock.calls[0][0] as string);
    expect(parsed.project).toBe('batch-123');
    expect(parsed.orphaned).toEqual([{ id: 'task_a' }]);
  });

  it('error: an unparseable --stale-after exits 1 without calling checkBatchStaleness', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const exitSpy = mockExit();

    await expect(
      busCommand.parseAsync(['node', 'bus', 'check-batch-staleness', 'batch-123', '--stale-after', 'not-a-duration']),
    ).rejects.toThrow(/__PROCESS_EXIT_1__/);

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(checkBatchStalenessMock).not.toHaveBeenCalled();
  });
});
