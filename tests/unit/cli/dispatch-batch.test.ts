/**
 * tests/unit/cli/dispatch-batch.test.ts
 *
 * Covers `bus dispatch-batch` for task_1787921691733_11462336: a batch of
 * work items described only in a bus message body has no durable per-item
 * completion state — the message's ack tracks delivery, not how much of the
 * batch got done before a session died. dispatch-batch creates one task per
 * item under a shared, traceable project id (the durable, session-death-proof
 * primitive) instead.
 *
 * `createTask`/`sendMessage` are mocked rather than exercised against real
 * disk: resolvePaths() (used by every task-command action handler, not just
 * this one) hardcodes homedir()/.cortextos/<instance> and ignores CTX_ROOT
 * entirely — unlike resolveEnv(), which IS CTX_ROOT-aware, that value is
 * never threaded through to resolvePaths(). A CLI-level test that skipped
 * mocking would therefore write into the real ~/.cortextos/default tree
 * (confirmed by hand while building this feature — cleaned up, no lasting
 * effect, but not a mistake to repeat in an automated test). createTask
 * itself already has direct coverage in tests/unit/bus/task-management.test.ts
 * and task.test.ts against a real (tempdir) BusPaths; this file exercises the
 * wrapper's own logic — validation, batch-id generation, one-task-per-item,
 * one summary message — not createTask's persistence, which is out of scope
 * here.
 *
 * Not covered here: the `-` (stdin) items-file path. `readFileSync` is an
 * ESM named export and vitest cannot spy on/redefine it ("Module namespace
 * is not configurable in ESM"), and the branch itself is a one-line ternary
 * already reachable by inspection — a real piped-stdin check belongs in a
 * manual/integration pass, not fought through a mocking limitation here.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const createTaskMock = vi.fn((_paths: unknown, _agent: string, _org: string, title: string) => `task_${title.length}_mock`);
const sendMessageMock = vi.fn();

vi.mock('../../../src/bus/task.js', () => ({
  createTask: (...args: unknown[]) => createTaskMock(...args),
  updateTask: vi.fn(),
  completeTask: vi.fn(),
  claimTask: vi.fn(),
  readTaskAudit: vi.fn(),
  checkTaskDependenciesWithStatus: vi.fn(),
  compactTasks: vi.fn(),
  listTasks: vi.fn(),
  checkStaleTasks: vi.fn(),
  checkBatchStaleness: vi.fn(),
  archiveTasks: vi.fn(),
  checkHumanTasks: vi.fn(),
}));

vi.mock('../../../src/bus/message.js', () => ({
  sendMessage: (...args: unknown[]) => sendMessageMock(...args),
  checkInboxWithStatus: vi.fn(),
  ackInbox: vi.fn(),
}));

import { busCommand, parseDispatchBatchItems } from '../../../src/cli/bus';

function mockExit(): ReturnType<typeof vi.spyOn> {
  return vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new Error(`__PROCESS_EXIT_${code}__`);
  }) as never);
}

beforeEach(() => {
  createTaskMock.mockClear();
  sendMessageMock.mockClear();
  process.env.CTX_AGENT_NAME = 'dispatcher';
  process.env.CTX_INSTANCE_ID = 'default';
  process.env.CTX_ORG = 'testorg';
});

// ---------------------------------------------------------------------------
// parseDispatchBatchItems — pure validation logic
// ---------------------------------------------------------------------------

describe('parseDispatchBatchItems', () => {
  it('parses a valid items array', () => {
    const items = parseDispatchBatchItems('[{"title": "a"}, {"title": "b", "desc": "d"}]');
    expect(items).toEqual([{ title: 'a', desc: undefined }, { title: 'b', desc: 'd' }]);
  });

  it('rejects invalid JSON', () => {
    expect(() => parseDispatchBatchItems('not json')).toThrow(/not valid JSON/);
  });

  it('rejects a non-array', () => {
    expect(() => parseDispatchBatchItems('{"title": "a"}')).toThrow(/non-empty JSON array/);
  });

  it('rejects an empty array', () => {
    expect(() => parseDispatchBatchItems('[]')).toThrow(/non-empty JSON array/);
  });

  it('rejects an item with no title', () => {
    expect(() => parseDispatchBatchItems('[{"desc": "d"}]')).toThrow(/item 0 is missing/);
  });

  it('rejects an item with an empty-string title', () => {
    expect(() => parseDispatchBatchItems('[{"title": "  "}]')).toThrow(/item 0 is missing/);
  });

  it('rejects a non-string desc', () => {
    expect(() => parseDispatchBatchItems('[{"title": "a", "desc": 5}]')).toThrow(/item 0's "desc"/);
  });

  it('reports the correct index for a later malformed item', () => {
    expect(() => parseDispatchBatchItems('[{"title": "a"}, {"title": "b"}, {}]')).toThrow(/item 2 is missing/);
  });
});

// ---------------------------------------------------------------------------
// dispatch-batch CLI wiring
// ---------------------------------------------------------------------------

describe('bus dispatch-batch', () => {
  it('creates one task per item, all under the same generated batch/project id', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const itemsFile = `/tmp/dispatch-batch-test-items-${Date.now()}.json`;
    await import('fs').then(fs => fs.writeFileSync(itemsFile, JSON.stringify([
      { title: 'migrate A.ts' },
      { title: 'migrate B.ts', desc: 'step 2' },
    ])));

    await busCommand.parseAsync(['node', 'bus', 'dispatch-batch', 'worker-agent', itemsFile]);

    expect(createTaskMock).toHaveBeenCalledTimes(2);
    const projects = createTaskMock.mock.calls.map(c => (c[4] as { project: string }).project);
    expect(projects[0]).toBe(projects[1]);
    expect(projects[0]).toMatch(/^batch-\d+-\d+$/);

    const assignees = createTaskMock.mock.calls.map(c => (c[4] as { assignee: string }).assignee);
    expect(assignees).toEqual(['worker-agent', 'worker-agent']);

    // batch id printed first, then one line per created task id.
    expect(logSpy.mock.calls[0][0]).toBe(projects[0]);

    await import('fs').then(fs => fs.rmSync(itemsFile));
  });

  it('sends exactly one summary message to the assignee, not one per item', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const itemsFile = `/tmp/dispatch-batch-test-items-${Date.now()}.json`;
    await import('fs').then(fs => fs.writeFileSync(itemsFile, JSON.stringify([
      { title: 'x' }, { title: 'y' }, { title: 'z' },
    ])));

    await busCommand.parseAsync(['node', 'bus', 'dispatch-batch', 'worker-agent', itemsFile]);

    expect(sendMessageMock).toHaveBeenCalledTimes(1);
    const body = sendMessageMock.mock.calls[0][4] as string;
    expect(body).toMatch(/list-tasks --project batch-\d+-\d+ --status pending/);
    expect(body).toMatch(/3 task\(s\) created/);

    await import('fs').then(fs => fs.rmSync(itemsFile));
  });

  it('does not send a summary message when dispatching to itself', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const itemsFile = `/tmp/dispatch-batch-test-items-${Date.now()}.json`;
    await import('fs').then(fs => fs.writeFileSync(itemsFile, JSON.stringify([{ title: 'x' }])));

    await busCommand.parseAsync(['node', 'bus', 'dispatch-batch', 'dispatcher', itemsFile]);

    expect(sendMessageMock).not.toHaveBeenCalled();

    await import('fs').then(fs => fs.rmSync(itemsFile));
  });

  it('--project overrides the generated batch id', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const itemsFile = `/tmp/dispatch-batch-test-items-${Date.now()}.json`;
    await import('fs').then(fs => fs.writeFileSync(itemsFile, JSON.stringify([{ title: 'x' }])));

    await busCommand.parseAsync(['node', 'bus', 'dispatch-batch', 'worker-agent', itemsFile, '--project', 'batch-custom-id']);

    expect((createTaskMock.mock.calls[0][4] as { project: string }).project).toBe('batch-custom-id');

    await import('fs').then(fs => fs.rmSync(itemsFile));
  });

  it('error: nonexistent items file exits 1 without creating any task', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exitSpy = mockExit();

    await expect(
      busCommand.parseAsync(['node', 'bus', 'dispatch-batch', 'worker-agent', '/tmp/does-not-exist-dispatch-batch.json']),
    ).rejects.toThrow(/__PROCESS_EXIT_1__/);

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(createTaskMock).not.toHaveBeenCalled();
    expect(errSpy.mock.calls[0][0]).toMatch(/Could not read items file/);
  });

  it('error: malformed items file exits 1 without creating any task (atomic — no partial batch)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mockExit();
    const itemsFile = `/tmp/dispatch-batch-test-bad-${Date.now()}.json`;
    await import('fs').then(fs => fs.writeFileSync(itemsFile, JSON.stringify([
      { title: 'good one' },
      { desc: 'missing title' },
    ])));

    await expect(
      busCommand.parseAsync(['node', 'bus', 'dispatch-batch', 'worker-agent', itemsFile]),
    ).rejects.toThrow(/__PROCESS_EXIT_1__/);

    // The whole batch is validated before any task is created — item 1's
    // defect must not leave item 0 created with nothing pointing at it.
    expect(createTaskMock).not.toHaveBeenCalled();

    await import('fs').then(fs => fs.rmSync(itemsFile));
  });

  it('error: invalid assignee name exits 1', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mockExit();

    await expect(
      busCommand.parseAsync(['node', 'bus', 'dispatch-batch', '../not-a-valid-agent', '/tmp/whatever.json']),
    ).rejects.toThrow(/__PROCESS_EXIT_/);

    expect(createTaskMock).not.toHaveBeenCalled();
  });
});
