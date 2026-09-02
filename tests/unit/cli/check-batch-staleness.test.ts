/**
 * tests/unit/cli/check-batch-staleness.test.ts
 *
 * Covers `bus check-batch-staleness <batch-id>` — the orphan-task-watchdog
 * follow-up to dispatch-batch (#160, task_1787921691733_11462336). This file
 * exercises only the CLI wrapper's own logic — argument/option wiring, the
 * --stale-after default and override, invalid-duration handling, and the
 * single-JSON-line output convention (matching check-stale-tasks'). The pure
 * report-building logic (bucketing, threshold math, project scoping) has its
 * own direct coverage in tests/unit/bus/task-management.test.ts.
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
  it('forwards only the batch id when --stale-after is omitted, letting checkBatchStaleness apply its own default', async () => {
    await busCommand.parseAsync(['node', 'bus', 'check-batch-staleness', 'batch-123']);

    expect(checkBatchStalenessMock).toHaveBeenCalledTimes(1);
    // No third argument — the CLI must not restate the 2h default as a second
    // number; the default lives in exactly one place, checkBatchStaleness's
    // own parameter default (STALE_IN_PROGRESS_MS).
    expect(checkBatchStalenessMock.mock.calls[0]).toEqual([expect.anything(), 'batch-123']);
  });

  it('parses a custom --stale-after duration into milliseconds', async () => {
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

    await busCommand.parseAsync(['node', 'bus', 'check-batch-staleness', 'batch-123']);

    const logSpy = vi.mocked(console.log);
    expect(logSpy).toHaveBeenCalledTimes(1);
    const parsed = JSON.parse(logSpy.mock.calls[0][0] as string);
    expect(parsed.project).toBe('batch-123');
    expect(parsed.orphaned).toEqual([{ id: 'task_a' }]);
  });

  it('error: an unparseable --stale-after exits 1 without calling checkBatchStaleness', async () => {
    const exitSpy = mockExit();

    await expect(
      busCommand.parseAsync(['node', 'bus', 'check-batch-staleness', 'batch-123', '--stale-after', 'not-a-duration']),
    ).rejects.toThrow(/__PROCESS_EXIT_1__/);

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(checkBatchStalenessMock).not.toHaveBeenCalled();
  });
});
