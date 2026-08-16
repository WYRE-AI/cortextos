import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// initWatcher() cached its FSWatcher on globalThis only when
// NODE_ENV !== 'production'. `next start` sets NODE_ENV=production, so the
// singleton was never stored: the early-return guard never fired, every call
// built a NEW watcher, and nothing retained it — the watcher lived and died
// with the HTTP request that created it.
//
// Its only caller is the SSE route (src/app/api/events/stream/route.ts), so in
// production the dashboard ingested ONLY while a browser held an open SSE
// connection. Measured consequence: the DB sat frozen for 37 hours while the
// process was online, serving, and green.
//
// The tests below run with NODE_ENV=production ON PURPOSE. Under 'test' or
// 'development' the old code passes, so a fixture that used the default env
// would have been green over the live bug.

const chokidarWatch = vi.fn(() => ({
  on: vi.fn().mockReturnThis(),
  close: vi.fn(),
}));
vi.mock('chokidar', () => ({ default: { watch: chokidarWatch }, watch: chokidarWatch }));

const syncAll = vi.fn();
vi.mock('../sync', () => ({ syncAll, syncFile: vi.fn() }));
vi.mock('../config', () => ({
  CTX_ROOT: '/tmp/ctx-root-watcher-test',
  getOrgs: () => ['testorg'],
}));

const g = globalThis as unknown as { __cortextos_watcher?: unknown };

describe('initWatcher singleton — must be retained in production', () => {
  beforeEach(() => {
    vi.resetModules();
    chokidarWatch.mockClear();
    syncAll.mockClear();
    delete g.__cortextos_watcher;
    vi.stubEnv('NODE_ENV', 'production');
  });

  afterEach(() => {
    delete g.__cortextos_watcher;
    vi.unstubAllEnvs(); // restores NODE_ENV; never assign to it directly (readonly)
  });

  it('stores the watcher on globalThis in production', async () => {
    const { initWatcher } = await import('../watcher');
    initWatcher();
    expect(g.__cortextos_watcher).toBeDefined();
  });

  it('returns the SAME watcher on a second call and does not re-watch', async () => {
    const { initWatcher } = await import('../watcher');
    const first = initWatcher();
    const second = initWatcher();
    expect(second).toBe(first);
    expect(chokidarWatch).toHaveBeenCalledTimes(1);
  });

  // The expensive half: a full sync per SSE connection, on every reconnect.
  it('runs the initial full sync ONCE, not per caller', async () => {
    const { initWatcher } = await import('../watcher');
    initWatcher();
    initWatcher();
    initWatcher();
    expect(syncAll).toHaveBeenCalledTimes(1);
  });

  it('still behaves as a singleton in development (no regression)', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    const { initWatcher } = await import('../watcher');
    expect(initWatcher()).toBe(initWatcher());
    expect(chokidarWatch).toHaveBeenCalledTimes(1);
  });
});
