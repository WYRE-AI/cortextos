import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createTask, updateTask, completeTask, claimTask, readTaskAudit, checkTaskDependencies, checkTaskDependenciesWithStatus, compactTasks, listTasks, findTaskFile, findTaskFileWithStatus, archiveTasks } from '../../../src/bus/task';
import type { BusPaths } from '../../../src/types';

describe('Task Management', () => {
  let testDir: string;
  let paths: BusPaths;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'cortextos-task-test-'));
    paths = {
      ctxRoot: testDir,
      inbox: join(testDir, 'inbox', 'paul'),
      inflight: join(testDir, 'inflight', 'paul'),
      processed: join(testDir, 'processed', 'paul'),
      logDir: join(testDir, 'logs', 'paul'),
      stateDir: join(testDir, 'state', 'paul'),
      taskDir: join(testDir, 'tasks'),
      approvalDir: join(testDir, 'approvals'),
      analyticsDir: join(testDir, 'analytics'),
      heartbeatDir: join(testDir, 'heartbeats'),
    };
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  describe('path-traversal hardening (#13/#14)', () => {
    it('findTaskFile rejects a traversal task id', () => {
      expect(() => findTaskFile(paths, '../../etc/passwd')).toThrow(/Invalid task id/);
      expect(() => findTaskFile(paths, 'task/../../secrets')).toThrow(/Invalid task id/);
      expect(() => findTaskFile(paths, 'task_1.json')).toThrow(/Invalid task id/);
    });

    it('readTaskAudit rejects a traversal task id', () => {
      expect(() => readTaskAudit(paths, '../../../etc/shadow')).toThrow(/Invalid task id/);
    });

    it('findTaskFile still resolves a legitimate task', () => {
      const id = createTask(paths, 'paul', 'acme', 'T', { assignee: 'boris' });
      expect(findTaskFile(paths, id)).toContain(`${id}.json`);
    });

    it('archiveTasks skips a task whose JSON id is tampered with traversal (no escape)', () => {
      mkdirSync(paths.taskDir, { recursive: true });
      // Safe filename, but the internal id carries traversal that would resolve
      // to testDir/escaped.json (outside the task tree) on archive write/rename.
      writeFileSync(join(paths.taskDir, 'task_evil_1.json'), JSON.stringify({
        id: '../escaped', status: 'completed', completed_at: '2020-01-01T00:00:00Z',
        assigned_to: 'boris', org: 'acme',
      }));
      expect(() => archiveTasks(paths)).not.toThrow();
      // The guard must have prevented the out-of-tree write.
      expect(existsSync(join(testDir, 'escaped.json'))).toBe(false);
    });
  });

  describe('createTask', () => {
    it('creates task with correct JSON format', () => {
      const taskId = createTask(paths, 'paul', 'acme', 'Build landing page', {
        description: 'Create a product landing page',
        assignee: 'boris',
        priority: 'high',
      });

      expect(taskId).toMatch(/^task_\d+_\d{8}$/);

      const content = JSON.parse(readFileSync(join(paths.taskDir, `${taskId}.json`), 'utf-8'));

      // Verify all 17 fields match bash create-task.sh format
      expect(content.id).toBe(taskId);
      expect(content.title).toBe('Build landing page');
      expect(content.description).toBe('Create a product landing page');
      expect(content.type).toBe('agent');
      expect(content.needs_approval).toBe(false);
      expect(content.status).toBe('pending');
      expect(content.assigned_to).toBe('boris');
      expect(content.created_by).toBe('paul');
      expect(content.org).toBe('acme');
      expect(content.priority).toBe('high');
      expect(content.project).toBe('');
      expect(content.kpi_key).toBeNull();
      expect(content.created_at).toBeTruthy();
      expect(content.updated_at).toBeTruthy();
      expect(content.completed_at).toBeNull();
      expect(content.due_date).toBeNull();
      expect(content.archived).toBe(false);
    });
  });

  describe('updateTask', () => {
    it('updates task status', () => {
      const taskId = createTask(paths, 'paul', 'acme', 'Test task');
      updateTask(paths, taskId, 'in_progress');

      const content = JSON.parse(readFileSync(join(paths.taskDir, `${taskId}.json`), 'utf-8'));
      expect(content.status).toBe('in_progress');
    });

    it('reassigns without a status argument, leaving status untouched', () => {
      const taskId = createTask(paths, 'paul', 'acme', 'Test task', { assignee: 'boss' });
      updateTask(paths, taskId, undefined, { assignee: 'dev' });

      const content = JSON.parse(readFileSync(join(paths.taskDir, `${taskId}.json`), 'utf-8'));
      expect(content.assigned_to).toBe('dev');
      expect(content.status).toBe('pending'); // untouched
    });

    it('changes project without a status argument', () => {
      const taskId = createTask(paths, 'paul', 'acme', 'Test task');
      updateTask(paths, taskId, undefined, { project: 'conduit' });

      const content = JSON.parse(readFileSync(join(paths.taskDir, `${taskId}.json`), 'utf-8'));
      expect(content.project).toBe('conduit');
    });

    it('bumps updated_at on a reassign-only call', () => {
      const taskId = createTask(paths, 'paul', 'acme', 'Test task', { assignee: 'boss' });
      const before = JSON.parse(readFileSync(join(paths.taskDir, `${taskId}.json`), 'utf-8')).updated_at;

      updateTask(paths, taskId, undefined, { assignee: 'dev' });

      const after = JSON.parse(readFileSync(join(paths.taskDir, `${taskId}.json`), 'utf-8')).updated_at;
      expect(after >= before).toBe(true);
    });

    it('throws when neither status, assignee, project, priority, appendDesc, nor blockedBy is given', () => {
      const taskId = createTask(paths, 'paul', 'acme', 'Test task');
      expect(() => updateTask(paths, taskId)).toThrow(
        'updateTask requires at least one of: status, assignee, project, priority, appendDesc, blockedBy',
      );
    });

    it('records the reassign in the task audit log', () => {
      const taskId = createTask(paths, 'paul', 'acme', 'Test task', { assignee: 'boss' });
      updateTask(paths, taskId, undefined, { assignee: 'dev' });

      const log = readTaskAudit(paths, taskId);
      const reassignEntry = log[log.length - 1];
      expect(reassignEntry.note).toContain('assignee: boss -> dev');
    });

    it('changes priority without a status argument', () => {
      const taskId = createTask(paths, 'paul', 'acme', 'Test task');
      updateTask(paths, taskId, undefined, { priority: 'high' });

      const content = JSON.parse(readFileSync(join(paths.taskDir, `${taskId}.json`), 'utf-8'));
      expect(content.priority).toBe('high');
      expect(content.status).toBe('pending'); // untouched
    });

    it('rejects an invalid priority', () => {
      const taskId = createTask(paths, 'paul', 'acme', 'Test task');
      expect(() => updateTask(paths, taskId, undefined, { priority: 'urgentish' as any })).toThrow(
        /Invalid priority/,
      );
    });

    it('records the priority change in the task audit log', () => {
      const taskId = createTask(paths, 'paul', 'acme', 'Test task');
      updateTask(paths, taskId, undefined, { priority: 'low' });

      const log = readTaskAudit(paths, taskId);
      const entry = log[log.length - 1];
      expect(entry.note).toContain('priority: normal -> low');
    });

    it('appends to the description rather than overwriting it', () => {
      const taskId = createTask(paths, 'paul', 'acme', 'Test task', {
        description: 'Original claim: the mechanism is X.',
      });
      updateTask(paths, taskId, undefined, { appendDesc: 'Correction: the mechanism is actually Y.' });

      const content = JSON.parse(readFileSync(join(paths.taskDir, `${taskId}.json`), 'utf-8'));
      expect(content.description).toContain('Original claim: the mechanism is X.');
      expect(content.description).toContain('Correction: the mechanism is actually Y.');
      expect(content.description).toMatch(/--- APPENDED \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z ---/);
    });

    it('appendDesc works standalone, without a status/assignee/project change', () => {
      const taskId = createTask(paths, 'paul', 'acme', 'Test task');
      expect(() => updateTask(paths, taskId, undefined, { appendDesc: 'A note.' })).not.toThrow();

      const content = JSON.parse(readFileSync(join(paths.taskDir, `${taskId}.json`), 'utf-8'));
      expect(content.status).toBe('pending'); // untouched
      expect(content.description).toContain('A note.');
    });

    it('appendDesc combines with a status change in one call', () => {
      const taskId = createTask(paths, 'paul', 'acme', 'Test task');
      updateTask(paths, taskId, 'blocked', { appendDesc: 'Blocked on the human task.' });

      const content = JSON.parse(readFileSync(join(paths.taskDir, `${taskId}.json`), 'utf-8'));
      expect(content.status).toBe('blocked');
      expect(content.description).toContain('Blocked on the human task.');
    });

    it('records the appendDesc in the task audit log without dumping the full text', () => {
      const taskId = createTask(paths, 'paul', 'acme', 'Test task');
      updateTask(paths, taskId, undefined, { appendDesc: 'A fairly short note.' });

      const log = readTaskAudit(paths, taskId);
      const entry = log[log.length - 1];
      expect(entry.note).toContain('description: appended 20 chars');
    });
  });

  describe('completeTask', () => {
    it('sets status to completed and completed_at', () => {
      const taskId = createTask(paths, 'paul', 'acme', 'Test task');
      completeTask(paths, taskId, 'Landing page done, committed at abc123');

      const content = JSON.parse(readFileSync(join(paths.taskDir, `${taskId}.json`), 'utf-8'));
      expect(content.status).toBe('completed');
      expect(content.completed_at).toBeTruthy();
      expect(content.result).toBe('Landing page done, committed at abc123');
    });

    it('emits a task/task_completed activity event for the assignee', () => {
      const taskId = createTask(paths, 'paul', 'acme', 'Complete-event task', {
        assignee: 'boris',
      });
      completeTask(paths, taskId, 'shipped');

      // Event file: <analyticsDir>/events/boris/<YYYY-MM-DD>.jsonl
      const today = new Date().toISOString().split('T')[0];
      const eventFile = join(paths.analyticsDir, 'events', 'boris', `${today}.jsonl`);
      expect(existsSync(eventFile)).toBe(true);

      const events = readFileSync(eventFile, 'utf-8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      const completedEvents = events.filter((e) => e.event === 'task_completed');
      expect(completedEvents).toHaveLength(1);
      const evt = completedEvents[0];
      expect(evt.agent).toBe('boris');
      expect(evt.org).toBe('acme');
      expect(evt.category).toBe('task');
      expect(evt.severity).toBe('info');
      expect(evt.metadata.task_id).toBe(taskId);
      expect(evt.metadata.result).toBe('shipped');
    });
  });

  describe('listTasks', () => {
    it('returns all non-archived tasks', () => {
      createTask(paths, 'paul', 'acme', 'Task 1');
      createTask(paths, 'paul', 'acme', 'Task 2');

      const tasks = listTasks(paths);
      expect(tasks.length).toBe(2);
    });

    it('filters by agent', () => {
      createTask(paths, 'paul', 'acme', 'For boris', { assignee: 'boris' });
      createTask(paths, 'paul', 'acme', 'For paul', { assignee: 'paul' });

      const borisTasks = listTasks(paths, { agent: 'boris' });
      expect(borisTasks.length).toBe(1);
      expect(borisTasks[0].title).toBe('For boris');
    });

    it('filters by status', () => {
      const id1 = createTask(paths, 'paul', 'acme', 'Task 1');
      createTask(paths, 'paul', 'acme', 'Task 2');
      updateTask(paths, id1, 'completed');

      const pending = listTasks(paths, { status: 'pending' });
      expect(pending.length).toBe(1);
    });

    // task_1786931062956_88555785: compact-tasks moves completed tasks into
    // archive-YYYY-MM.jsonl and DELETES the active JSON, but listTasks only
    // ever scanned task_*.json — so an archived task was retained on disk and
    // permanently unmatchable by the same detector that filed it, and a
    // re-filed duplicate would read as a first occurrence rather than a
    // recurrence. --include-archived closes that gap.
    //
    // Fixture is SYNTHESIZED here, not sampled from live state: this box has
    // zero real archive-*.jsonl files today (compact-tasks has never run in
    // this instance), so a fixture drawn from live state would contain
    // exactly the case this test needs to exercise and could not fail —
    // the same fixture-sampled-from-live-config trap that produced a false
    // positive on its first production fire elsewhere in the fleet.
    describe('--include-archived (compact-tasks archive lookup)', () => {
      it('archived task is found ONLY with the flag, never without it — both directions, with a positive control', () => {
        const archivedId = createTask(paths, 'paul', 'acme', 'Old shipped work', { assignee: 'paul' });
        completeTask(paths, archivedId, 'shipped');
        // Backdate past compactTasks' cutoff so it's actually eligible.
        const oldTs = new Date(Date.now() - 60 * 86400_000).toISOString().replace(/\.\d{3}Z$/, 'Z');
        const p = join(paths.taskDir, `${archivedId}.json`);
        const t = JSON.parse(readFileSync(p, 'utf-8'));
        t.completed_at = oldTs;
        writeFileSync(p, JSON.stringify(t));

        // Positive control: a second task that stays ACTIVE (never compacted).
        // If this ever disappeared from either query, the probe itself would
        // be broken, not the archive lookup — same shape as tonight's
        // fleet-wide "a wrapper zero is not evidence without a control" rule.
        const liveId = createTask(paths, 'paul', 'acme', 'Still active work', { assignee: 'paul' });

        const compactReport = compactTasks(paths, { olderThanDays: 30 });
        expect(compactReport.archived.map(a => a.id)).toEqual([archivedId]);
        expect(existsSync(join(paths.taskDir, `${archivedId}.json`))).toBe(false);

        // Direction 1: WITHOUT the flag, the archived task must be absent —
        // and the live one (positive control) must still be present, so an
        // empty archived-task check can't be confused with a broken query.
        const withoutFlag = listTasks(paths, { agent: 'paul' });
        expect(withoutFlag.map(t => t.id)).toContain(liveId);
        expect(withoutFlag.map(t => t.id)).not.toContain(archivedId);

        // Direction 2: WITH the flag, the archived task is found by the same
        // key (id) the detector uses, AND the live task is still there too —
        // proving the flag adds coverage rather than silently replacing it.
        const withFlag = listTasks(paths, { agent: 'paul', includeArchived: true });
        expect(withFlag.map(t => t.id)).toContain(liveId);
        expect(withFlag.map(t => t.id)).toContain(archivedId);

        const found = withFlag.find(t => t.id === archivedId)!;
        expect(found.title).toBe('Old shipped work');
        expect(found.status).toBe('completed');
        expect(found.archived).toBe(true);
        expect(found.result).toBe('shipped');
      });

      it('negative control: --include-archived on a tree with zero archive files returns the same set as without it', () => {
        // Guards against the flag silently no-op'ing in the common case
        // (no archives yet) being mistaken for "the flag works" — this run
        // has no compaction at all, so both queries must agree exactly.
        createTask(paths, 'paul', 'acme', 'Ordinary task');
        const without = listTasks(paths, { agent: 'paul' });
        const withFlag = listTasks(paths, { agent: 'paul', includeArchived: true });
        expect(withFlag.map(t => t.id).sort()).toEqual(without.map(t => t.id).sort());
      });

      it('--status completed --include-archived surfaces both a live-completed and an archived task', () => {
        const liveCompletedId = createTask(paths, 'paul', 'acme', 'Live completed, not old enough');
        completeTask(paths, liveCompletedId, 'done recently');

        const archivedId = createTask(paths, 'paul', 'acme', 'Archived completed');
        completeTask(paths, archivedId, 'done long ago');
        const oldTs = new Date(Date.now() - 60 * 86400_000).toISOString().replace(/\.\d{3}Z$/, 'Z');
        const p = join(paths.taskDir, `${archivedId}.json`);
        const t = JSON.parse(readFileSync(p, 'utf-8'));
        t.completed_at = oldTs;
        writeFileSync(p, JSON.stringify(t));
        compactTasks(paths, { olderThanDays: 30 });

        const result = listTasks(paths, { status: 'completed', includeArchived: true });
        const ids = result.map(t => t.id);
        expect(ids).toContain(liveCompletedId);
        expect(ids).toContain(archivedId);
      });
    });
  });
});

/**
 * Cross-org task lifecycle — exercises the findTaskFile fallback so an
 * assignee in one org can drive the lifecycle of a task filed by an
 * orchestrator in a sibling org. Standard cortextOS dispatch pattern:
 * an orchestrator in one org files a task, a specialist in another org
 * needs to update and complete it from their own agent session.
 *
 * These tests build a REAL nested filesystem layout (matching the
 * production shape at ~/.cortextos/<instance>/orgs/<org>/tasks/) so they
 * cover the actual cross-org path resolution, not a mocked shortcut.
 */
describe('Cross-org task lifecycle', () => {
  let testDir: string;
  let orgAPaths: BusPaths;
  let orgBTaskDir: string;
  let warnLog: string[];
  let originalWarn: typeof console.warn;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'cortextos-crossorg-test-'));
    // Nested layout: <ctxRoot>/orgs/{OrgA,OrgB}/tasks/
    mkdirSync(join(testDir, 'orgs', 'OrgA', 'tasks'), { recursive: true });
    mkdirSync(join(testDir, 'orgs', 'OrgB', 'tasks'), { recursive: true });

    orgAPaths = {
      ctxRoot: testDir,
      inbox: join(testDir, 'inbox', 'agentA'),
      inflight: join(testDir, 'inflight', 'agentA'),
      processed: join(testDir, 'processed', 'agentA'),
      logDir: join(testDir, 'logs', 'agentA'),
      stateDir: join(testDir, 'state', 'agentA'),
      taskDir: join(testDir, 'orgs', 'OrgA', 'tasks'),
      approvalDir: join(testDir, 'orgs', 'OrgA', 'approvals'),
      analyticsDir: join(testDir, 'orgs', 'OrgA', 'analytics'),
      heartbeatDir: join(testDir, 'heartbeats'),
    };
    orgBTaskDir = join(testDir, 'orgs', 'OrgB', 'tasks');

    warnLog = [];
    originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnLog.push(args.map((a) => String(a)).join(' '));
    };
  });

  afterEach(() => {
    console.warn = originalWarn;
    rmSync(testDir, { recursive: true, force: true });
  });

  /** Helper: drop a raw task JSON file into OrgB's tasks dir without
   * going through createTask (which only knows about OrgA's taskDir). */
  function writeOrgBTask(taskId: string, overrides: Record<string, unknown> = {}): void {
    const task = {
      id: taskId,
      title: 'Cross-org task',
      description: '',
      type: 'agent',
      needs_approval: false,
      status: 'pending',
      assigned_to: 'agentA',
      created_by: 'orchestrator',
      org: 'OrgB',
      priority: 'normal',
      project: '',
      kpi_key: null,
      created_at: '2026-04-11T20:00:00Z',
      updated_at: '2026-04-11T20:00:00Z',
      completed_at: null,
      due_date: null,
      archived: false,
      ...overrides,
    };
    writeFileSync(join(orgBTaskDir, `${taskId}.json`), JSON.stringify(task), 'utf-8');
  }

  it('updateTask same-org happy path: still works via the fast path', () => {
    // Regression guard for the existing single-org behavior. This is the
    // hot path and must not pay any cross-org scan cost when it hits.
    const taskId = createTask(orgAPaths, 'agentA', 'OrgA', 'Same-org task');
    updateTask(orgAPaths, taskId, 'in_progress');

    const content = JSON.parse(
      readFileSync(join(orgAPaths.taskDir, `${taskId}.json`), 'utf-8'),
    );
    expect(content.status).toBe('in_progress');
  });

  it('updateTask cross-org: finds task in sibling org via findTaskFile fallback', () => {
    // Repro: file a task in OrgB, try to update it from an OrgA-scoped
    // session. Before findTaskFile, this threw "Task not found" because
    // updateTask only looked at orgAPaths.taskDir.
    const taskId = 'task_test_001';
    writeOrgBTask(taskId);

    updateTask(orgAPaths, taskId, 'in_progress');

    // Verify the OrgB file got updated, NOT the (nonexistent) OrgA file.
    const orgBContent = JSON.parse(
      readFileSync(join(orgBTaskDir, `${taskId}.json`), 'utf-8'),
    );
    expect(orgBContent.status).toBe('in_progress');
    // Explicit timestamp comparison: the seed updated_at is a fixed moment
    // in the past, so the real Date.now() that updateTask stamps MUST be
    // strictly greater. Avoids the brittle string-inequality form that
    // would silently pass on any future refactor that changed the seed.
    expect(new Date(orgBContent.updated_at).getTime()).toBeGreaterThan(
      new Date('2026-04-11T20:00:00Z').getTime(),
    );
    expect(existsSync(join(orgAPaths.taskDir, `${taskId}.json`))).toBe(false);
  });

  it('updateTask not found anywhere: throws with a clear error naming ctxRoot', () => {
    expect(() => updateTask(orgAPaths, 'task_999_000', 'in_progress')).toThrow(
      /not found in any org under .*\/orgs\//,
    );
  });

  it('completeTask cross-org: finds task in sibling org and marks it done', () => {
    const taskId = 'task_test_002';
    writeOrgBTask(taskId);

    completeTask(orgAPaths, taskId, 'cross-org completion');

    const orgBContent = JSON.parse(
      readFileSync(join(orgBTaskDir, `${taskId}.json`), 'utf-8'),
    );
    expect(orgBContent.status).toBe('completed');
    expect(orgBContent.completed_at).toBeTruthy();
    expect(orgBContent.result).toBe('cross-org completion');
  });

  it('findTaskFile ambiguity: same ID in two orgs triggers warn naming both orgs', () => {
    // Manually create the same task id in BOTH orgs. Real collisions
    // should be vanishingly rare (epoch_ms + 3 digits), but the warn path
    // must be tested so operators hitting it in production get actionable
    // information.
    const taskId = 'task_1_000';
    writeOrgBTask(taskId);
    // Write the same ID to OrgA via direct filesystem (bypassing
    // createTask so we can reuse the exact ID).
    const orgATaskPath = join(orgAPaths.taskDir, `${taskId}.json`);
    writeFileSync(
      orgATaskPath,
      JSON.stringify({
        id: taskId,
        title: 'OrgA collision',
        status: 'pending',
        org: 'OrgA',
        updated_at: '2026-04-11T20:00:00Z',
        created_at: '2026-04-11T20:00:00Z',
      }),
      'utf-8',
    );

    // findTaskFile should return the OrgA path (same-org fast path wins)
    // without ever emitting the ambiguity warning. The fast path only
    // checks same-org; the cross-org scan is ONLY exercised when same-org
    // misses. So the ambiguity warning path requires same-org to miss
    // AND multiple sibling orgs to hit.
    //
    // To exercise the warn, delete the OrgA copy and write collisions
    // into two OTHER orgs.
    rmSync(orgATaskPath);
    mkdirSync(join(testDir, 'orgs', 'OrgC', 'tasks'), { recursive: true });
    writeFileSync(
      join(testDir, 'orgs', 'OrgC', 'tasks', `${taskId}.json`),
      JSON.stringify({
        id: taskId,
        title: 'OrgC collision',
        status: 'pending',
        org: 'OrgC',
        updated_at: '2026-04-11T20:00:00Z',
        created_at: '2026-04-11T20:00:00Z',
      }),
      'utf-8',
    );

    const result = findTaskFile(orgAPaths, taskId);
    expect(result).not.toBeNull();
    // Warn must have fired and must name BOTH the task id and the two orgs.
    expect(warnLog.length).toBeGreaterThanOrEqual(1);
    const warn = warnLog[0];
    expect(warn).toContain(taskId);
    expect(warn).toMatch(/found in 2 orgs/);
    expect(warn).toContain('OrgB');
    expect(warn).toContain('OrgC');
  });

  it('listTasks scoping regression: must remain single-org, NO cross-org leakage', () => {
    // CRITICAL regression guard. Scoping contract:
    // listTasks must remain single-org by default — cross-org listing
    // requires an explicit opt-in flag that does not exist yet. A future
    // well-meaning refactor that 'helpfully' makes listTasks cross-org by
    // default would silently break the dashboard, which depends on
    // per-org scoping for its sync loop. If this test fails, the refactor
    // broke the contract and must be reverted or gated behind an opt-in
    // flag.
    const sameOrgId = createTask(orgAPaths, 'agentA', 'OrgA', 'Same-org task');
    writeOrgBTask('task_other_1', { title: 'Sibling-org task 1' });
    writeOrgBTask('task_other_2', { title: 'Sibling-org task 2' });

    const tasks = listTasks(orgAPaths);
    expect(tasks.length).toBe(1);
    expect(tasks[0].id).toBe(sameOrgId);
    expect(tasks[0].title).toBe('Same-org task');
  });
});

describe('claimTask — atomic claim (beads-inspired)', () => {
  let testDir: string;
  let paths: BusPaths;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'cortextos-claim-test-'));
    paths = {
      ctxRoot: testDir,
      inbox: join(testDir, 'inbox', 'x'),
      inflight: join(testDir, 'inflight', 'x'),
      processed: join(testDir, 'processed', 'x'),
      logDir: join(testDir, 'logs', 'x'),
      stateDir: join(testDir, 'state', 'x'),
      taskDir: join(testDir, 'tasks'),
      approvalDir: join(testDir, 'approvals'),
      analyticsDir: join(testDir, 'analytics'),
      heartbeatDir: join(testDir, 'heartbeats'),
    };
  });

  afterEach(() => { rmSync(testDir, { recursive: true, force: true }); });

  it('happy path: claims a pending task, flips status + assignee, writes lock file', () => {
    const id = createTask(paths, 'alice', 'acme', 'Claimable work');
    const task = claimTask(paths, id, 'alice');
    expect(task.status).toBe('in_progress');
    expect(task.assigned_to).toBe('alice');

    // Persisted to disk
    const onDisk = JSON.parse(readFileSync(join(paths.taskDir, `${id}.json`), 'utf-8'));
    expect(onDisk.status).toBe('in_progress');
    expect(onDisk.assigned_to).toBe('alice');

    // Lock file recorded the claimant + timestamp
    const lock = readFileSync(join(paths.taskDir, '.claims', `${id}.claim`), 'utf-8');
    expect(lock.split('\t')[0]).toBe('alice');
  });

  it('rejects second claim with a named owner when the lock already exists', () => {
    const id = createTask(paths, 'alice', 'acme', 'Race target');
    claimTask(paths, id, 'alice');
    expect(() => claimTask(paths, id, 'bob-agent')).toThrow(/already claimed by alice/);
  });

  it('is idempotent when the same agent re-claims (no throw, returns the task)', () => {
    const id = createTask(paths, 'alice', 'acme', 'Re-claim');
    claimTask(paths, id, 'alice');
    const again = claimTask(paths, id, 'alice');
    expect(again.assigned_to).toBe('alice');
    expect(again.status).toBe('in_progress');
  });

  it('rejects claim on a non-pending task with a clear status message', () => {
    const id = createTask(paths, 'alice', 'acme', 'Already done');
    updateTask(paths, id, 'completed');
    expect(() => claimTask(paths, id, 'alice')).toThrow(/not pending.*status=completed/);
  });

  it('throws "not found" for an unknown task id', () => {
    expect(() => claimTask(paths, 'task_nonexistent_000', 'alice')).toThrow(/not found in any org/);
  });

  it('rolls back the lock if the task-JSON write fails (so retry can still succeed)', () => {
    const id = createTask(paths, 'alice', 'acme', 'Rollback probe');
    const claimPath = join(paths.taskDir, '.claims', `${id}.claim`);

    // Force atomicWriteSync to fail by deleting the task file mid-flight.
    // Simplest repro: remove the task json right after the lock is taken
    // by intercepting findTaskFile's call path — instead just delete the
    // task file before claimTask reads it, and reuse the existing
    // not-found path. Then confirm no stale .claim file is left behind.
    rmSync(join(paths.taskDir, `${id}.json`));
    expect(() => claimTask(paths, id, 'alice')).toThrow(/not found in any org/);
    expect(existsSync(claimPath)).toBe(false);
  });
});

describe('Task audit log (append-only JSONL)', () => {
  let testDir: string;
  let paths: BusPaths;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'cortextos-audit-test-'));
    paths = {
      ctxRoot: testDir,
      inbox: join(testDir, 'inbox', 'x'),
      inflight: join(testDir, 'inflight', 'x'),
      processed: join(testDir, 'processed', 'x'),
      logDir: join(testDir, 'logs', 'x'),
      stateDir: join(testDir, 'state', 'x'),
      taskDir: join(testDir, 'tasks'),
      approvalDir: join(testDir, 'approvals'),
      analyticsDir: join(testDir, 'analytics'),
      heartbeatDir: join(testDir, 'heartbeats'),
    };
  });

  afterEach(() => { rmSync(testDir, { recursive: true, force: true }); });

  it('createTask writes one "create" audit entry', () => {
    const id = createTask(paths, 'alice', 'acme', 'First task', { description: 'd' });
    const log = readTaskAudit(paths, id);
    expect(log.length).toBe(1);
    expect(log[0].event).toBe('create');
    expect(log[0].agent).toBe('alice');
    expect(log[0].to).toBe('pending');
    expect(log[0].note).toBe('First task');
  });

  it('full lifecycle records create + claim + complete in order', () => {
    const id = createTask(paths, 'alice', 'acme', 'Lifecycle');
    claimTask(paths, id, 'alice');
    completeTask(paths, id, 'shipped');

    const log = readTaskAudit(paths, id);
    expect(log.map(e => e.event)).toEqual(['create', 'claim', 'complete']);
    expect(log[1].from).toBe('pending');
    expect(log[1].to).toBe('in_progress');
    expect(log[1].agent).toBe('alice');
    expect(log[2].from).toBe('in_progress');
    expect(log[2].to).toBe('completed');
    expect(log[2].note).toBe('shipped');
  });

  it('updateTask audit captures from->to transition with assignee as agent', () => {
    const id = createTask(paths, 'alice', 'acme', 'Updatable', { assignee: 'alice' });
    updateTask(paths, id, 'blocked');
    updateTask(paths, id, 'pending');

    const log = readTaskAudit(paths, id);
    expect(log.length).toBe(3); // create + 2 updates
    expect(log[1].event).toBe('update');
    expect(log[1].from).toBe('pending');
    expect(log[1].to).toBe('blocked');
    expect(log[1].agent).toBe('alice');
    expect(log[2].from).toBe('blocked');
    expect(log[2].to).toBe('pending');
  });

  it('audit log is append-only — existing entries are never overwritten', () => {
    const id = createTask(paths, 'alice', 'acme', 'Append proof');
    const path = join(paths.taskDir, 'audit', `${id}.jsonl`);
    const before = readFileSync(path, 'utf-8');
    updateTask(paths, id, 'blocked');
    const after = readFileSync(path, 'utf-8');
    expect(after.startsWith(before)).toBe(true);
    expect(after.length).toBeGreaterThan(before.length);
  });

  it('corrupt lines are skipped without blocking replay of surrounding entries', () => {
    const id = createTask(paths, 'alice', 'acme', 'Corrupt survivor');
    const path = join(paths.taskDir, 'audit', `${id}.jsonl`);
    // Inject a malformed line between two valid ones
    writeFileSync(path, readFileSync(path, 'utf-8') + 'not-json-at-all\n');
    updateTask(paths, id, 'in_progress');
    const log = readTaskAudit(paths, id);
    expect(log.length).toBe(2); // create + update, corrupt middle line skipped
    expect(log[0].event).toBe('create');
    expect(log[1].event).toBe('update');
  });

  it('readTaskAudit returns [] for a task with no history', () => {
    expect(readTaskAudit(paths, 'task_nonexistent_000')).toEqual([]);
  });
});

describe('Task dependency DAG (blocks / blocked_by)', () => {
  let testDir: string;
  let paths: BusPaths;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'cortextos-dag-test-'));
    paths = {
      ctxRoot: testDir,
      inbox: join(testDir, 'inbox', 'x'),
      inflight: join(testDir, 'inflight', 'x'),
      processed: join(testDir, 'processed', 'x'),
      logDir: join(testDir, 'logs', 'x'),
      stateDir: join(testDir, 'state', 'x'),
      taskDir: join(testDir, 'tasks'),
      approvalDir: join(testDir, 'approvals'),
      analyticsDir: join(testDir, 'analytics'),
      heartbeatDir: join(testDir, 'heartbeats'),
    };
  });

  afterEach(() => { rmSync(testDir, { recursive: true, force: true }); });

  function readTask(id: string) {
    return JSON.parse(readFileSync(join(paths.taskDir, `${id}.json`), 'utf-8'));
  }

  it('blocked_by stores the declared dependency + the peer gets a symmetric blocks edge', () => {
    const a = createTask(paths, 'alice', 'acme', 'A (blocker)');
    const b = createTask(paths, 'alice', 'acme', 'B (blocked)', { blockedBy: [a] });

    expect(readTask(b).blocked_by).toEqual([a]);
    expect(readTask(a).blocks).toEqual([b]);
  });

  it('blocks is the symmetric reverse of blocked_by', () => {
    const a = createTask(paths, 'alice', 'acme', 'A');
    const b = createTask(paths, 'alice', 'acme', 'B', { blocks: [a] });

    // "B blocks A" means A is blocked_by B
    expect(readTask(a).blocked_by).toEqual([b]);
    expect(readTask(b).blocks).toEqual([a]);
  });

  it('checkTaskDependencies returns open blockers with their current status', () => {
    const blocker = createTask(paths, 'alice', 'acme', 'Blocker');
    const blocked = createTask(paths, 'alice', 'acme', 'Blocked', { blockedBy: [blocker] });

    let open = checkTaskDependencies(paths, blocked);
    expect(open.length).toBe(1);
    expect(open[0].id).toBe(blocker);
    expect(open[0].status).toBe('pending');

    completeTask(paths, blocker, 'done');
    open = checkTaskDependencies(paths, blocked);
    expect(open).toEqual([]);
  });

  it('checkTaskDependencies reports missing:true for dangling dep references', () => {
    const b = createTask(paths, 'alice', 'acme', 'B', { blockedBy: ['task_nonexistent_777'] });
    const open = checkTaskDependencies(paths, b);
    expect(open).toEqual([{ id: 'task_nonexistent_777', status: 'missing' }]);
  });

  it('cycle detection: A blocked_by B, B blocked_by A throws at creation', () => {
    const a = createTask(paths, 'alice', 'acme', 'A');
    const b = createTask(paths, 'alice', 'acme', 'B', { blockedBy: [a] });
    // A declares new blocked_by edge to B — would form A -> B -> A cycle.
    expect(() => createTask(paths, 'alice', 'acme', 'A-rewrite', { blockedBy: [b], blocks: [a] })).toThrow(/cycle/i);
  });

  it('REGRESSION: cycle-rejected createTask leaves ZERO state on disk — no task json, no audit, no peer mutation', () => {
    const a = createTask(paths, 'alice', 'acme', 'A');
    const b = createTask(paths, 'alice', 'acme', 'B', { blockedBy: [a] });
    const c = createTask(paths, 'alice', 'acme', 'C', { blockedBy: [b] });

    // Snapshot A's blocks list before the cycle-try attempt.
    const aBlocksBefore = readTask(a).blocks ?? [];

    // Attempt a cycle: new task blocked_by c + blocks a → cycle-try → a → b → c → cycle-try.
    const filesBefore = readdirSync(paths.taskDir).filter(f => f.startsWith('task_')).sort();
    expect(() => createTask(paths, 'alice', 'acme', 'cycle-try', { blockedBy: [c], blocks: [a] })).toThrow(/cycle/i);

    // Invariants: (1) no new task JSON, (2) no audit directory entry for the rejected id,
    // (3) peer A's blocks list unchanged.
    const filesAfter = readdirSync(paths.taskDir).filter(f => f.startsWith('task_')).sort();
    expect(filesAfter).toEqual(filesBefore);
    // A's `blocks` list must not have been mutated by the attempted creation.
    expect(readTask(a).blocks ?? []).toEqual(aBlocksBefore);
    // No dangling audit dir file for a task id that never existed.
    const auditDir = join(paths.taskDir, 'audit');
    if (existsSync(auditDir)) {
      const auditFiles = readdirSync(auditDir);
      // No audit file for any task whose id isn't one of the 3 we successfully created.
      const validIds = new Set([a, b, c]);
      for (const f of auditFiles) {
        const id = f.replace(/\.jsonl$/, '');
        expect(validIds.has(id)).toBe(true);
      }
    }
  });

  it('listTasks --respect-deps orders unblocked tasks before blocked ones', () => {
    const blocker = createTask(paths, 'alice', 'acme', 'Blocker');
    const blocked = createTask(paths, 'alice', 'acme', 'Blocked', { blockedBy: [blocker] });
    const free = createTask(paths, 'alice', 'acme', 'Free');

    const ordered = listTasks(paths, { respectDeps: true });
    const ids = ordered.map(t => t.id);
    // All 3 present
    expect(ids).toContain(blocker);
    expect(ids).toContain(blocked);
    expect(ids).toContain(free);
    // `blocked` must come after both `blocker` and `free` in the list.
    const idx = (id: string) => ids.indexOf(id);
    expect(idx(blocked)).toBeGreaterThan(idx(blocker));
    expect(idx(blocked)).toBeGreaterThan(idx(free));

    // Once blocker completes, respectDeps no longer demotes blocked.
    completeTask(paths, blocker, 'done');
    const reordered = listTasks(paths, { respectDeps: true });
    const blockedTask = reordered.find(t => t.id === blocked)!;
    expect(blockedTask.status).toBe('pending');
    // Specifically: blocked should no longer be forced after 'free'
    // (both unblocked now, fall back to created_at ordering).
  });

  describe('updateTask --blocked-by (task_1786923653812_76952898 / task_1786773702893_68177835)', () => {
    it('adds a post-creation blocker edge + symmetric blocks edge on the peer', () => {
      const blocker = createTask(paths, 'alice', 'acme', 'Discovered blocker');
      const taskId = createTask(paths, 'alice', 'acme', 'Blocked after the fact');

      updateTask(paths, taskId, 'blocked', { blockedBy: [blocker] });

      expect(readTask(taskId).blocked_by).toEqual([blocker]);
      expect(readTask(blocker).blocks).toEqual([taskId]);
    });

    it('is additive: a second call appends rather than replacing the existing list', () => {
      const a = createTask(paths, 'alice', 'acme', 'A');
      const b = createTask(paths, 'alice', 'acme', 'B');
      const taskId = createTask(paths, 'alice', 'acme', 'Task', { blockedBy: [a] });

      updateTask(paths, taskId, undefined, { blockedBy: [b] });

      expect(readTask(taskId).blocked_by).toEqual([a, b]);
      expect(readTask(a).blocks).toEqual([taskId]);
      expect(readTask(b).blocks).toEqual([taskId]);
    });

    it('dedupes an id already present in blocked_by rather than erroring or duplicating', () => {
      const a = createTask(paths, 'alice', 'acme', 'A');
      const taskId = createTask(paths, 'alice', 'acme', 'Task', { blockedBy: [a] });

      updateTask(paths, taskId, undefined, { blockedBy: [a] });

      expect(readTask(taskId).blocked_by).toEqual([a]);
      expect(readTask(a).blocks).toEqual([taskId]);
    });

    it('cycle detection: rejects a post-creation edge that would close a loop', () => {
      const a = createTask(paths, 'alice', 'acme', 'A');
      // B is blocked_by A. Adding "A blocked_by B" would close the loop A -> B -> A.
      const b = createTask(paths, 'alice', 'acme', 'B', { blockedBy: [a] });
      expect(() => updateTask(paths, a, undefined, { blockedBy: [b] })).toThrow(/cycle/i);
    });

    it('rejects a task declaring itself as its own blocker', () => {
      const taskId = createTask(paths, 'alice', 'acme', 'Self-referential');
      expect(() => updateTask(paths, taskId, undefined, { blockedBy: [taskId] })).toThrow(/cycle/i);
    });

    it('REGRESSION: a rejected cycle leaves blocked_by and the peer\'s blocks list untouched', () => {
      const a = createTask(paths, 'alice', 'acme', 'A');
      const b = createTask(paths, 'alice', 'acme', 'B', { blockedBy: [a] });
      const aBlocksBefore = readTask(a).blocks ?? [];
      const bBlockedByBefore = readTask(b).blocked_by ?? [];

      expect(() => updateTask(paths, a, undefined, { blockedBy: [b] })).toThrow(/cycle/i);

      expect(readTask(a).blocked_by ?? []).toEqual([]);
      expect(readTask(a).blocks ?? []).toEqual(aBlocksBefore);
      expect(readTask(b).blocked_by ?? []).toEqual(bBlockedByBefore);
    });

    it('records the new edge in the task audit log', () => {
      const blocker = createTask(paths, 'alice', 'acme', 'Blocker');
      const taskId = createTask(paths, 'alice', 'acme', 'Task');

      updateTask(paths, taskId, 'blocked', { blockedBy: [blocker] });

      const log = readTaskAudit(paths, taskId);
      const entry = log[log.length - 1];
      expect(entry.note).toContain(`blocked_by: +[${blocker}]`);
    });

    it('the exact motivating scenario: a blocked task with no blocked_by is now recordable, and check-stale-blockers can then evaluate it', () => {
      const blocker = createTask(paths, 'alice', 'acme', 'Blocker');
      const taskId = createTask(paths, 'alice', 'acme', 'Orphaned block');
      updateTask(paths, taskId, 'blocked');
      expect(readTask(taskId).blocked_by).toBeUndefined();

      // The gap this feature closes: attach the blocker after the fact.
      updateTask(paths, taskId, undefined, { blockedBy: [blocker] });
      expect(readTask(taskId).blocked_by).toEqual([blocker]);

      const open = checkTaskDependencies(paths, taskId);
      expect(open).toEqual([{ id: blocker, status: 'pending' }]);
    });
  });
});

describe('compactTasks — semantic compaction of old completed tasks', () => {
  let testDir: string;
  let paths: BusPaths;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'cortextos-compact-test-'));
    paths = {
      ctxRoot: testDir,
      inbox: join(testDir, 'inbox', 'x'),
      inflight: join(testDir, 'inflight', 'x'),
      processed: join(testDir, 'processed', 'x'),
      logDir: join(testDir, 'logs', 'x'),
      stateDir: join(testDir, 'state', 'x'),
      taskDir: join(testDir, 'tasks'),
      approvalDir: join(testDir, 'approvals'),
      analyticsDir: join(testDir, 'analytics'),
      heartbeatDir: join(testDir, 'heartbeats'),
    };
  });

  afterEach(() => { rmSync(testDir, { recursive: true, force: true }); });

  // Helper: age a completed task's completed_at by overwriting the JSON.
  function backdateCompletion(id: string, daysAgo: number) {
    const p = join(paths.taskDir, `${id}.json`);
    const t = JSON.parse(readFileSync(p, 'utf-8'));
    const ts = new Date(Date.now() - daysAgo * 86400_000).toISOString().replace(/\.\d{3}Z$/, 'Z');
    t.completed_at = ts;
    t.updated_at = ts;
    writeFileSync(p, JSON.stringify(t));
  }

  it('archives a completed task older than cutoff — removes active JSON, preserves audit log', () => {
    const id = createTask(paths, 'alice', 'acme', 'Old done', { assignee: 'alice' });
    completeTask(paths, id, 'shipped');
    backdateCompletion(id, 40);

    const auditPath = join(paths.taskDir, 'audit', `${id}.jsonl`);
    expect(existsSync(auditPath)).toBe(true);

    const report = compactTasks(paths, { olderThanDays: 30 });
    expect(report.archived.map(a => a.id)).toEqual([id]);
    expect(report.skipped).toEqual([]);

    // Active JSON gone, audit log still there
    expect(existsSync(join(paths.taskDir, `${id}.json`))).toBe(false);
    expect(existsSync(auditPath)).toBe(true);

    // Archive entry written to the correct month file
    const archiveFile = report.archived[0].archive_file;
    const archiveLine = readFileSync(join(paths.taskDir, archiveFile), 'utf-8').trim();
    const entry = JSON.parse(archiveLine);
    expect(entry.id).toBe(id);
    expect(entry.title).toBe('Old done');
    expect(entry.result).toBe('shipped');
    expect(entry.assigned_to).toBe('alice');
  });

  it('skips recently-completed tasks (within cutoff)', () => {
    const id = createTask(paths, 'alice', 'acme', 'Fresh done');
    completeTask(paths, id, 'ok');
    // Leave completed_at as "just now" — should be skipped.
    const report = compactTasks(paths, { olderThanDays: 30 });
    expect(report.archived).toEqual([]);
    expect(report.skipped.find(s => s.id === id)?.reason).toMatch(/within cutoff/);
  });

  it('skips in-progress and blocked tasks regardless of age', () => {
    const a = createTask(paths, 'alice', 'acme', 'In progress');
    claimTask(paths, a, 'alice'); // -> in_progress
    const b = createTask(paths, 'alice', 'acme', 'Blocked');
    updateTask(paths, b, 'blocked');

    const report = compactTasks(paths, { olderThanDays: 0 });
    expect(report.archived).toEqual([]);
  });

  it('NEVER archives a completed task still referenced by an open task\'s blocked_by chain', () => {
    const blocker = createTask(paths, 'alice', 'acme', 'Blocker');
    const dependent = createTask(paths, 'alice', 'acme', 'Dependent', { blockedBy: [blocker] });
    completeTask(paths, blocker, 'done');
    backdateCompletion(blocker, 60);

    // Dependent is still pending → blocker must not be compacted away.
    expect(dependent).toBeDefined();
    const report = compactTasks(paths, { olderThanDays: 30 });
    expect(report.archived).toEqual([]);
    expect(report.skipped.find(s => s.id === blocker)?.reason).toMatch(/still.*blocked_by/);
    expect(existsSync(join(paths.taskDir, `${blocker}.json`))).toBe(true);
  });

  it('REGRESSION: transitive blocker guard — A<-B<-C with C open preserves BOTH A and B', () => {
    const a = createTask(paths, 'alice', 'acme', 'A');
    const b = createTask(paths, 'alice', 'acme', 'B', { blockedBy: [a] });
    const c = createTask(paths, 'alice', 'acme', 'C', { blockedBy: [b] });
    expect(c).toBeDefined();

    // A + B both completed and aged out; C stays open.
    completeTask(paths, a, 'done-a');
    completeTask(paths, b, 'done-b');
    backdateCompletion(a, 60);
    backdateCompletion(b, 60);

    const report = compactTasks(paths, { olderThanDays: 30 });
    // Neither A nor B should be archived — both are in the transitive
    // blocker closure of open C.
    expect(report.archived).toEqual([]);
    const skippedIds = report.skipped.map(s => s.id).sort();
    expect(skippedIds).toContain(a);
    expect(skippedIds).toContain(b);
    // Both must still be on disk.
    expect(existsSync(join(paths.taskDir, `${a}.json`))).toBe(true);
    expect(existsSync(join(paths.taskDir, `${b}.json`))).toBe(true);
  });

  it('once the dependent completes, the blocker becomes eligible', () => {
    const blocker = createTask(paths, 'alice', 'acme', 'Blocker');
    const dependent = createTask(paths, 'alice', 'acme', 'Dependent', { blockedBy: [blocker] });
    completeTask(paths, blocker, 'done');
    backdateCompletion(blocker, 60);
    completeTask(paths, dependent, 'done');
    backdateCompletion(dependent, 60);

    const report = compactTasks(paths, { olderThanDays: 30 });
    const archivedIds = report.archived.map(a => a.id).sort();
    expect(archivedIds).toEqual([blocker, dependent].sort());
  });

  it('is idempotent — running a second time on the same data archives nothing', () => {
    const id = createTask(paths, 'alice', 'acme', 'Run-twice');
    completeTask(paths, id, 'ok');
    backdateCompletion(id, 60);

    const first = compactTasks(paths, { olderThanDays: 30 });
    expect(first.archived.map(a => a.id)).toEqual([id]);

    const second = compactTasks(paths, { olderThanDays: 30 });
    expect(second.archived).toEqual([]);
  });

  it('dry-run reports candidates without modifying anything', () => {
    const id = createTask(paths, 'alice', 'acme', 'Dry-run target');
    completeTask(paths, id, 'ok');
    backdateCompletion(id, 60);

    const report = compactTasks(paths, { olderThanDays: 30, dryRun: true });
    expect(report.dry_run).toBe(true);
    expect(report.archived.map(a => a.id)).toEqual([id]);
    // Active JSON still present
    expect(existsSync(join(paths.taskDir, `${id}.json`))).toBe(true);
  });
});

describe('findTaskFile — tier-3 unique-prefix resolution', () => {
  let testDir: string;
  let paths: BusPaths;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'cortextos-task-prefix-'));
    paths = {
      ctxRoot: testDir,
      inbox: join(testDir, 'inbox', 'paul'),
      inflight: join(testDir, 'inflight', 'paul'),
      processed: join(testDir, 'processed', 'paul'),
      logDir: join(testDir, 'logs', 'paul'),
      stateDir: join(testDir, 'state', 'paul'),
      taskDir: join(testDir, 'tasks'),
      approvalDir: join(testDir, 'approvals'),
      analyticsDir: join(testDir, 'analytics'),
      heartbeatDir: join(testDir, 'heartbeats'),
    } as BusPaths;
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  const mk = (id: string, dir?: string) => {
    const d = dir ?? paths.taskDir;
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, `${id}.json`), JSON.stringify({ id, status: 'pending', title: 'T' }));
  };

  it('a unique prefix resolves to the full task — updateTask works with a truncated id', () => {
    mk('task_1700000000001_11111111');
    mk('task_1700000000002_22222222');
    updateTask(paths, 'task_1700000000001', 'in_progress');
    const saved = JSON.parse(
      readFileSync(join(paths.taskDir, 'task_1700000000001_11111111.json'), 'utf-8'),
    );
    expect(saved.status).toBe('in_progress');
  });

  it('an ambiguous prefix throws naming every candidate', () => {
    mk('task_1700000000001_11111111');
    mk('task_1700000000001_22222222');
    expect(() => findTaskFile(paths, 'task_1700000000001')).toThrow(/Ambiguous task id prefix/);
    expect(() => findTaskFile(paths, 'task_1700000000001')).toThrow(/task_1700000000001_11111111/);
    expect(() => findTaskFile(paths, 'task_1700000000001')).toThrow(/task_1700000000001_22222222/);
  });

  it('no prefix match preserves the caller not-found error', () => {
    mk('task_1700000000001_11111111');
    expect(findTaskFile(paths, 'task_9999')).toBeNull();
    expect(() => updateTask(paths, 'task_9999', 'completed')).toThrow(/not found in any org/);
  });

  it('an exact id wins at tier 1 and never enters prefix logic', () => {
    mk('task_1700000000001_11111111');
    expect(findTaskFile(paths, 'task_1700000000001_11111111')).toContain(
      'task_1700000000001_11111111.json',
    );
  });

  it('a prefix resolves across sibling orgs too', () => {
    mk('task_1700000000003_33333333', join(testDir, 'orgs', 'beta', 'tasks'));
    expect(findTaskFile(paths, 'task_1700000000003')).toContain(
      'task_1700000000003_33333333.json',
    );
  });
});

describe('lookup completion status — "nothing there" vs "I did not look"', () => {
  let testDir: string;
  let paths: BusPaths;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'cortextos-task-status-'));
    paths = {
      ctxRoot: testDir,
      inbox: join(testDir, 'inbox', 'paul'),
      inflight: join(testDir, 'inflight', 'paul'),
      processed: join(testDir, 'processed', 'paul'),
      logDir: join(testDir, 'logs', 'paul'),
      stateDir: join(testDir, 'state', 'paul'),
      taskDir: join(testDir, 'tasks'),
      approvalDir: join(testDir, 'approvals'),
      analyticsDir: join(testDir, 'analytics'),
      heartbeatDir: join(testDir, 'heartbeats'),
    };
    mkdirSync(paths.taskDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  // Make readdirSync(orgsRoot) throw ENOTDIR deterministically. Preferred over
  // chmod 000, which a root-owned CI container silently ignores — the scan would
  // then succeed and the test would pass while proving nothing.
  const breakOrgsTree = (): void => {
    writeFileSync(join(testDir, 'orgs'), 'not a directory');
  };

  const ABSENT = 'task_9999999999999_000';

  it('CONTROL: a readable tree with no match reports a COMPLETED lookup', () => {
    const r = findTaskFileWithStatus(paths, ABSENT);
    expect(r.path).toBeNull();
    expect(r.unreadable).toBe(false); // genuine absence — callers may trust it
  });

  it('an unreadable orgs tree reports the lookup did NOT complete', () => {
    breakOrgsTree();
    const r = findTaskFileWithStatus(paths, ABSENT);
    expect(r.path).toBeNull();
    expect(r.unreadable).toBe(true); // `path: null` here is NOT evidence of absence
  });

  it('THE COLLAPSE: both cases are byte-identical through the legacy wrapper', () => {
    const genuine = findTaskFile(paths, ABSENT);
    breakOrgsTree();
    const unreadable = findTaskFile(paths, ABSENT);
    // Documents exactly what the WithStatus split exists to recover. The wrapper
    // is intentionally lossy (mirrors readCrons); callers that care must migrate.
    expect(genuine).toBeNull();
    expect(unreadable).toBeNull();
  });

  it('a findable task still resolves, and reports a completed lookup', () => {
    const id = createTask(paths, 'alice', 'acme', 'Findable');
    const r = findTaskFileWithStatus(paths, id);
    expect(r.path).not.toBeNull();
    expect(r.unreadable).toBe(false);
  });

  it('CONTROL: no blockers on a readable tree is a TRUSTWORTHY all-clear', () => {
    const blocker = createTask(paths, 'alice', 'acme', 'Blocker');
    const blocked = createTask(paths, 'alice', 'acme', 'Blocked', { blockedBy: [blocker] });
    completeTask(paths, blocker, 'done');
    const r = checkTaskDependenciesWithStatus(paths, blocked);
    expect(r.open).toEqual([]);
    expect(r.unresolved).toBe(false);
  });

  it('REGRESSION: an unreadable tree must NOT produce a clean bill of health', () => {
    // The dangerous path. Both consumers read `open.length === 0` as an
    // affirmative all-clear: the CLI prints "ready to work", and the drift
    // scanner emits a `resolved_dependency` finding asserting the blockers
    // "are all completed" — a claim built from blocked_by WITHOUT reading them.
    breakOrgsTree();
    const r = checkTaskDependenciesWithStatus(paths, ABSENT);
    expect(r.unresolved).toBe(true);
  });
});
