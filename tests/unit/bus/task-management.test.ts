import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createTask, updateTask, completeTask, checkStaleTasks, checkBatchStaleness, archiveTasks, checkHumanTasks } from '../../../src/bus/task';
import { atomicWriteSync } from '../../../src/utils/atomic';
import type { BusPaths, Task } from '../../../src/types';

/**
 * Helper to create a task with a backdated timestamp.
 * Writes a task JSON directly with manipulated dates.
 */
function createBackdatedTask(
  paths: BusPaths,
  overrides: Partial<Task> & { id: string },
): void {
  const now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  const task: Task = {
    id: overrides.id,
    title: overrides.title ?? 'Test task',
    description: overrides.description ?? '',
    type: overrides.type ?? 'agent',
    needs_approval: overrides.needs_approval ?? false,
    status: overrides.status ?? 'pending',
    assigned_to: overrides.assigned_to ?? 'agent1',
    created_by: overrides.created_by ?? 'agent1',
    org: overrides.org ?? 'testorg',
    priority: overrides.priority ?? 'normal',
    project: overrides.project ?? '',
    kpi_key: overrides.kpi_key ?? null,
    created_at: overrides.created_at ?? now,
    updated_at: overrides.updated_at ?? now,
    completed_at: overrides.completed_at ?? null,
    due_date: overrides.due_date ?? null,
    archived: overrides.archived ?? false,
  };
  atomicWriteSync(join(paths.taskDir, `${task.id}.json`), JSON.stringify(task));
}

function hoursAgo(hours: number): string {
  const d = new Date(Date.now() - hours * 3600 * 1000);
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function daysAgo(days: number): string {
  return hoursAgo(days * 24);
}

describe('Advanced Task Management', () => {
  let testDir: string;
  let paths: BusPaths;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'cortextos-taskmgmt-test-'));
    paths = {
      ctxRoot: testDir,
      inbox: join(testDir, 'inbox', 'agent1'),
      inflight: join(testDir, 'inflight', 'agent1'),
      processed: join(testDir, 'processed', 'agent1'),
      logDir: join(testDir, 'logs', 'agent1'),
      stateDir: join(testDir, 'state', 'agent1'),
      taskDir: join(testDir, 'tasks'),
      approvalDir: join(testDir, 'approvals'),
      analyticsDir: join(testDir, 'analytics'),
      heartbeatDir: join(testDir, 'heartbeats'),
    };
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  describe('checkStaleTasks', () => {
    it('identifies stale in_progress tasks (>2h)', () => {
      createBackdatedTask(paths, {
        id: 'task_001_001',
        title: 'Stale in progress',
        status: 'in_progress',
        updated_at: hoursAgo(3), // 3 hours ago
        created_at: hoursAgo(5),
      });
      createBackdatedTask(paths, {
        id: 'task_002_002',
        title: 'Fresh in progress',
        status: 'in_progress',
        updated_at: hoursAgo(1), // 1 hour ago
        created_at: hoursAgo(1),
      });

      const report = checkStaleTasks(paths);
      expect(report.stale_in_progress.length).toBe(1);
      expect(report.stale_in_progress[0].id).toBe('task_001_001');
    });

    it('identifies stale pending tasks (>24h)', () => {
      createBackdatedTask(paths, {
        id: 'task_003_003',
        title: 'Stale pending',
        status: 'pending',
        created_at: hoursAgo(25), // 25 hours ago
        updated_at: hoursAgo(25),
      });
      createBackdatedTask(paths, {
        id: 'task_004_004',
        title: 'Fresh pending',
        status: 'pending',
        created_at: hoursAgo(1),
        updated_at: hoursAgo(1),
      });

      const report = checkStaleTasks(paths);
      expect(report.stale_pending.length).toBe(1);
      expect(report.stale_pending[0].id).toBe('task_003_003');
    });

    it('identifies overdue tasks', () => {
      createBackdatedTask(paths, {
        id: 'task_005_005',
        title: 'Overdue task',
        status: 'pending',
        created_at: hoursAgo(1),
        updated_at: hoursAgo(1),
        due_date: daysAgo(1), // due yesterday
      });
      createBackdatedTask(paths, {
        id: 'task_006_006',
        title: 'Future task',
        status: 'pending',
        created_at: hoursAgo(1),
        updated_at: hoursAgo(1),
        due_date: new Date(Date.now() + 86400000).toISOString().replace(/\.\d{3}Z$/, 'Z'), // due tomorrow
      });

      const report = checkStaleTasks(paths);
      expect(report.overdue.length).toBe(1);
      expect(report.overdue[0].id).toBe('task_005_005');
    });

    it('skips completed tasks', () => {
      createBackdatedTask(paths, {
        id: 'task_007_007',
        title: 'Done task',
        status: 'completed',
        created_at: hoursAgo(48),
        updated_at: hoursAgo(48),
        completed_at: hoursAgo(48),
        due_date: daysAgo(1), // overdue but completed
      });

      const report = checkStaleTasks(paths);
      expect(report.stale_in_progress.length).toBe(0);
      expect(report.stale_pending.length).toBe(0);
      expect(report.stale_human.length).toBe(0);
      expect(report.overdue.length).toBe(0);
    });
  });

  describe('checkBatchStaleness', () => {
    it('flags an in_progress item past the default 2h threshold as orphaned, leaves a fresher one active', () => {
      createBackdatedTask(paths, {
        id: 'task_020_020',
        title: 'Orphaned item',
        status: 'in_progress',
        project: 'batch-1',
        updated_at: hoursAgo(3),
      });
      createBackdatedTask(paths, {
        id: 'task_021_021',
        title: 'Still being worked',
        status: 'in_progress',
        project: 'batch-1',
        updated_at: hoursAgo(1),
      });

      const report = checkBatchStaleness(paths, 'batch-1');
      expect(report.project).toBe('batch-1');
      expect(report.stale_after_ms).toBe(7_200_000); // 2h default
      expect(report.total).toBe(2);
      expect(report.orphaned.map(t => t.id)).toEqual(['task_020_020']);
      expect(report.active.map(t => t.id)).toEqual(['task_021_021']);
    });

    it('buckets pending/completed/blocked/cancelled separately from the orphaned/active view', () => {
      createBackdatedTask(paths, { id: 'task_022_022', status: 'pending', project: 'batch-2' });
      createBackdatedTask(paths, { id: 'task_023_023', status: 'completed', project: 'batch-2' });
      createBackdatedTask(paths, { id: 'task_024_024', status: 'blocked', project: 'batch-2' });
      createBackdatedTask(paths, { id: 'task_025_025', status: 'cancelled', project: 'batch-2' });

      const report = checkBatchStaleness(paths, 'batch-2');
      expect(report.total).toBe(4);
      expect(report.pending.map(t => t.id)).toEqual(['task_022_022']);
      expect(report.completed).toBe(1);
      expect(report.blocked).toBe(1);
      expect(report.cancelled).toBe(1);
      expect(report.orphaned).toEqual([]);
      expect(report.active).toEqual([]);
    });

    it('scopes strictly to the given project id — a task under a different batch is invisible', () => {
      createBackdatedTask(paths, {
        id: 'task_026_026',
        status: 'in_progress',
        project: 'batch-3',
        updated_at: hoursAgo(5),
      });
      createBackdatedTask(paths, {
        id: 'task_027_027',
        status: 'in_progress',
        project: 'batch-other',
        updated_at: hoursAgo(5),
      });

      const report = checkBatchStaleness(paths, 'batch-3');
      expect(report.total).toBe(1);
      expect(report.orphaned.map(t => t.id)).toEqual(['task_026_026']);
    });

    it('respects a custom --stale-after threshold instead of the 2h default', () => {
      createBackdatedTask(paths, {
        id: 'task_028_028',
        status: 'in_progress',
        project: 'batch-4',
        updated_at: hoursAgo(0.75), // 45 min ago
      });

      // Under the 2h default this item is still "active".
      const defaultReport = checkBatchStaleness(paths, 'batch-4');
      expect(defaultReport.orphaned).toEqual([]);
      expect(defaultReport.active.map(t => t.id)).toEqual(['task_028_028']);

      // A tighter 30-minute threshold flags the same item as orphaned.
      const tightReport = checkBatchStaleness(paths, 'batch-4', 30 * 60 * 1000);
      expect(tightReport.stale_after_ms).toBe(1_800_000);
      expect(tightReport.orphaned.map(t => t.id)).toEqual(['task_028_028']);
      expect(tightReport.active).toEqual([]);
    });

    it('returns a well-shaped empty report for a batch id with no matching tasks', () => {
      const report = checkBatchStaleness(paths, 'batch-does-not-exist');
      expect(report).toEqual({
        project: 'batch-does-not-exist',
        stale_after_ms: 7_200_000,
        total: 0,
        orphaned: [],
        active: [],
        pending: [],
        completed: 0,
        blocked: 0,
        cancelled: 0,
      });
    });
  });

  describe('archiveTasks', () => {
    it('moves old completed tasks to archive/', () => {
      createBackdatedTask(paths, {
        id: 'task_010_010',
        title: 'Old done task',
        status: 'completed',
        created_at: daysAgo(10),
        updated_at: daysAgo(8),
        completed_at: daysAgo(8), // completed 8 days ago, > 7 day threshold
      });

      const report = archiveTasks(paths);
      expect(report.archived).toBe(1);
      expect(report.dry_run).toBe(false);

      // File should be moved to archive/
      expect(existsSync(join(paths.taskDir, 'task_010_010.json'))).toBe(false);
      expect(existsSync(join(paths.taskDir, 'archive', 'task_010_010.json'))).toBe(true);
    });

    it('dry-run does not modify files', () => {
      createBackdatedTask(paths, {
        id: 'task_011_011',
        title: 'Old done task',
        status: 'completed',
        created_at: daysAgo(10),
        updated_at: daysAgo(8),
        completed_at: daysAgo(8),
      });

      const report = archiveTasks(paths, true);
      expect(report.archived).toBe(1);
      expect(report.dry_run).toBe(true);

      // File should still be in original location
      expect(existsSync(join(paths.taskDir, 'task_011_011.json'))).toBe(true);
      expect(existsSync(join(paths.taskDir, 'archive'))).toBe(false);
    });

    it('adds archived:true field', () => {
      createBackdatedTask(paths, {
        id: 'task_012_012',
        title: 'Old done task',
        status: 'completed',
        created_at: daysAgo(10),
        updated_at: daysAgo(8),
        completed_at: daysAgo(8),
      });

      archiveTasks(paths);

      const archivedContent = readFileSync(
        join(paths.taskDir, 'archive', 'task_012_012.json'),
        'utf-8',
      );
      const task = JSON.parse(archivedContent);
      expect(task.archived).toBe(true);
    });
  });

  describe('checkHumanTasks', () => {
    it('finds human-assigned stale tasks', () => {
      createBackdatedTask(paths, {
        id: 'task_020_020',
        title: 'Human task old',
        status: 'pending',
        assigned_to: 'human',
        created_at: hoursAgo(25),
        updated_at: hoursAgo(25),
      });
      createBackdatedTask(paths, {
        id: 'task_021_021',
        title: 'User task old',
        status: 'in_progress',
        assigned_to: 'user',
        created_at: hoursAgo(30),
        updated_at: hoursAgo(30),
      });
      createBackdatedTask(paths, {
        id: 'task_022_022',
        title: 'Human task fresh',
        status: 'pending',
        assigned_to: 'human',
        created_at: hoursAgo(1), // only 1 hour old
        updated_at: hoursAgo(1),
      });
      createBackdatedTask(paths, {
        id: 'task_023_023',
        title: 'Agent task old',
        status: 'pending',
        assigned_to: 'agent1',
        created_at: hoursAgo(25),
        updated_at: hoursAgo(25),
      });

      const humanTasks = checkHumanTasks(paths);
      expect(humanTasks.length).toBe(2);
      const ids = humanTasks.map(t => t.id).sort();
      expect(ids).toEqual(['task_020_020', 'task_021_021']);
    });

    it('finds project:human-tasks tasks assigned to the filing agent (not just assigned_to human/user) — matches checkStaleTasks OR-logic', () => {
      // AGENTS.md's documented create-task pattern for human tasks
      // (`create-task "[HUMAN] ..." --project human-tasks`) defaults assigned_to
      // to the filing agent unless --assignee is explicitly overridden. A stale
      // human task filed this way must still surface here, the same as it
      // already does in checkStaleTasks' stale_human bucket.
      createBackdatedTask(paths, {
        id: 'task_024_024',
        title: '[HUMAN] rotate compromised API key',
        status: 'pending',
        assigned_to: 'agent1', // filed by the agent itself, not "human"/"user"
        project: 'human-tasks',
        created_at: hoursAgo(25),
        updated_at: hoursAgo(25),
      });

      const humanTasks = checkHumanTasks(paths);
      const ids = humanTasks.map(t => t.id);
      expect(ids).toContain('task_024_024');
    });
  });
});
