import { describe, it, expect, vi } from 'vitest';

// Cheap structural guard on the shape of the watch roots. This is the fast test;
// watcher-ingests-real-events.test.ts is the one that proves ingestion actually
// works. Keep both: this one names the defect, that one catches the class.

vi.mock('../config', () => ({
  CTX_ROOT: '/ctx',
  getOrgs: () => ['orgone', 'orgtwo'],
}));
vi.mock('../sync', () => ({ syncAll: vi.fn(), syncFile: vi.fn() }));

describe('getWatchRoots', () => {
  it('contains no glob metacharacters — chokidar v4+ does not expand them', async () => {
    const { getWatchRoots } = await import('../watcher');
    for (const root of getWatchRoots()) {
      expect(root, `glob pattern in watch root: ${root}`).not.toMatch(/[*?[\]{}]/);
    }
  });

  it('covers every ingested surface, per org and flat', async () => {
    const { getWatchRoots } = await import('../watcher');
    expect(getWatchRoots()).toEqual([
      '/ctx/orgs/orgone/tasks',
      '/ctx/orgs/orgone/approvals',
      '/ctx/orgs/orgone/analytics/events',
      '/ctx/orgs/orgtwo/tasks',
      '/ctx/orgs/orgtwo/approvals',
      '/ctx/orgs/orgtwo/analytics/events',
      '/ctx/state',
      '/ctx/inbox',
    ]);
  });
});

describe('isPruned', () => {
  it('prunes the heavy trees that sit under a watch root', async () => {
    const { isPruned } = await import('../watcher');
    expect(isPruned('/ctx/state/agent-a/claude-config/projects/x/session.json')).toBe(true);
    expect(isPruned('/ctx/state/agent-a/node_modules/p/index.js')).toBe(true);
  });

  it('does not prune the files we ingest (negative control)', async () => {
    const { isPruned } = await import('../watcher');
    expect(isPruned('/ctx/state/agent-a/heartbeat.json')).toBe(false);
    expect(isPruned('/ctx/orgs/orgone/analytics/events/agent-a/2026-08-16.jsonl')).toBe(false);
  });
});

describe('isRelevant', () => {
  it('accepts exactly what syncFile can act on', async () => {
    const { isRelevant } = await import('../watcher');
    expect(isRelevant('/ctx/orgs/o/analytics/events/a/2026-08-16.jsonl')).toBe(true);
    expect(isRelevant('/ctx/state/a/heartbeat.json')).toBe(true);
    expect(isRelevant('/ctx/orgs/o/tasks/t.json')).toBe(true);
    expect(isRelevant('/ctx/orgs/o/approvals/a.json')).toBe(true);
    expect(isRelevant('/ctx/inbox/m.json')).toBe(true);
  });

  it('rejects near-misses under the same roots', async () => {
    const { isRelevant } = await import('../watcher');
    // events dir but wrong extension — syncFile would ignore it anyway
    expect(isRelevant('/ctx/orgs/o/analytics/events/a/notes.json')).toBe(false);
    // state dir but not a heartbeat
    expect(isRelevant('/ctx/state/a/pid.txt')).toBe(false);
    expect(isRelevant('/ctx/orgs/o/tasks/README.md')).toBe(false);
  });
});
