import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';

// Chokidar removed glob support in v4 and we are on v5. watcher.ts used to hand
// it patterns like '.../analytics/events/**/*.jsonl'; chokidar took each as a
// LITERAL path, matched nothing, raised no error, reached 'ready', and logged
// "Watching 8 patterns" while ingesting nothing, permanently.
//
// Every cheap test passed over that bug. A mocked-chokidar test asserts we
// CALLED watch() with some argument; the argument was the defect. So this file
// runs the REAL chokidar against a real temp tree and asserts a real append
// produces a real event.
//
// This test is only worth its runtime if it FAILS on the old code. Verified by
// reverting getWatchRoots() to the glob form and re-running: times out, 0 events.

const h = vi.hoisted(() => ({
  root:
    (process.env.TMPDIR || '/tmp').replace(/\/$/, '') +
    '/ctx-watcher-int-' +
    Math.random().toString(36).slice(2),
}));

const syncFile = vi.fn();
vi.mock('../sync', () => ({ syncAll: vi.fn(), syncFile }));
vi.mock('../config', () => ({ CTX_ROOT: h.root, getOrgs: () => ['testorg'] }));

const g = globalThis as unknown as { __cortextos_watcher?: { close: () => void } };

const eventsDir = path.join(h.root, 'orgs', 'testorg', 'analytics', 'events', 'agent-a');
const tasksDir = path.join(h.root, 'orgs', 'testorg', 'tasks');
const stateDir = path.join(h.root, 'state', 'agent-a');
const eventsFile = path.join(eventsDir, '2026-08-16.jsonl');

beforeAll(() => {
  for (const d of [
    eventsDir,
    tasksDir,
    path.join(h.root, 'orgs', 'testorg', 'approvals'),
    stateDir,
    path.join(h.root, 'inbox'),
    // The tree we must NOT watch: 22372 of state/'s 22765 real entries.
    path.join(stateDir, 'claude-config', 'projects', 'deep'),
  ]) {
    fs.mkdirSync(d, { recursive: true });
  }
  fs.writeFileSync(eventsFile, '{"seed":true}\n');
  fs.writeFileSync(path.join(stateDir, 'heartbeat.json'), '{"status":"online"}');
});

afterAll(() => {
  fs.rmSync(h.root, { recursive: true, force: true });
});

afterEach(async () => {
  const { stopWatcher } = await import('../watcher');
  stopWatcher();
  delete g.__cortextos_watcher;
  vi.resetModules();
  syncFile.mockClear();
});

async function startAndWaitForReady() {
  const mod = await import('../watcher');
  const watcher = mod.initWatcher();
  const ready = await Promise.race([
    new Promise<boolean>((res) => watcher.on('ready', () => res(true))),
    new Promise<boolean>((res) => setTimeout(() => res(false), 8000)),
  ]);
  // Precondition. Without this, a watcher that never starts looks exactly like
  // a watcher that started and saw nothing — and the assertion below would
  // report the wrong failure.
  expect(ready, 'chokidar never reached ready — the probe is broken').toBe(true);
  return { mod, watcher };
}

function waitForEvents(mod: typeof import('../watcher'), ms = 5000) {
  const seen: Array<{ type: string; filePath: string }> = [];
  const unsub = mod.onSSEEvent((e) =>
    seen.push({ type: e.type, filePath: (e.data as { filePath: string }).filePath }),
  );
  return {
    seen,
    settle: () => new Promise<void>((res) => setTimeout(() => { unsub(); res(); }, ms)),
  };
}

describe('watcher ingests real filesystem events (real chokidar)', () => {
  it('watches a non-zero set of entries — not zero, which is what globs produced', async () => {
    const { watcher } = await startAndWaitForReady();
    const watched = watcher.getWatched();
    const entries = Object.values(watched).reduce((n, v) => n + v.length, 0);
    // The old glob form resolved to exactly 0 here while reporting healthy.
    expect(entries).toBeGreaterThan(0);
  });

  it('fires an event when an analytics jsonl is appended to', async () => {
    const { mod } = await startAndWaitForReady();
    const probe = waitForEvents(mod);

    fs.appendFileSync(eventsFile, '{"probe":"append"}\n');
    await probe.settle();

    expect(probe.seen.map((e) => e.filePath)).toContain(eventsFile);
    expect(probe.seen.find((e) => e.filePath === eventsFile)?.type).toBe('event');
    expect(syncFile).toHaveBeenCalledWith(eventsFile);
  });

  it('fires an event when a task json is created', async () => {
    const { mod } = await startAndWaitForReady();
    const probe = waitForEvents(mod);

    const taskFile = path.join(tasksDir, 'task_probe.json');
    fs.writeFileSync(taskFile, '{"id":"task_probe"}');
    await probe.settle();

    expect(probe.seen.map((e) => e.filePath)).toContain(taskFile);
    expect(probe.seen.find((e) => e.filePath === taskFile)?.type).toBe('task');
  });

  it('does NOT fire for pruned or irrelevant files (negative control)', async () => {
    const { mod } = await startAndWaitForReady();
    const probe = waitForEvents(mod);

    // Pruned tree: a Claude session write must not wake the dashboard.
    fs.writeFileSync(
      path.join(stateDir, 'claude-config', 'projects', 'deep', 'session.json'),
      '{"noise":true}',
    );
    // Under a watched root but not a file we ingest.
    fs.writeFileSync(path.join(tasksDir, 'README.md'), 'not json');
    // Control: a file that MUST fire, proving the probe is live for this run.
    fs.appendFileSync(eventsFile, '{"probe":"control"}\n');
    await probe.settle();

    expect(probe.seen.map((e) => e.filePath)).toContain(eventsFile);
    expect(probe.seen.some((e) => e.filePath.includes('claude-config'))).toBe(false);
    expect(probe.seen.some((e) => e.filePath.endsWith('README.md'))).toBe(false);
  });
});
