// cortextOS Dashboard - Chokidar file watcher singleton
// Monitors CTX_ROOT for JSON/JSONL changes, syncs to SQLite, emits SSE events.

import { EventEmitter } from 'events';
import { watch, type FSWatcher } from 'chokidar';
import fs from 'fs';
import path from 'path';
import { CTX_ROOT, getOrgs } from './config';
import { syncFile, syncAll } from './sync';
import type { SSEEvent } from './types';

// ---------------------------------------------------------------------------
// globalThis singleton pattern (survives Next.js hot reloads)
// ---------------------------------------------------------------------------

const globalForWatcher = globalThis as unknown as {
  __cortextos_emitter: EventEmitter | undefined;
  __cortextos_watcher: FSWatcher | undefined;
};

export const emitter: EventEmitter =
  globalForWatcher.__cortextos_emitter ?? new EventEmitter();
emitter.setMaxListeners(100); // support many concurrent SSE clients

if (process.env.NODE_ENV !== 'production') {
  globalForWatcher.__cortextos_emitter = emitter;
}

// ---------------------------------------------------------------------------
// Watch roots
//
// These are LITERAL DIRECTORIES, never globs.
//
// This file previously passed glob patterns ('.../analytics/events/**/*.jsonl'
// and four more). Chokidar removed glob support in v4; we are on v5. It treated
// each pattern as a literal path, matched nothing, raised no error, reached
// 'ready', and logged "Watching 8 patterns" — while watching ZERO entries and
// emitting zero add/change events, permanently. Measured with the installed
// chokidar 5.0.0: glob arm -> 0 watched entries / 0 events; literal-directory
// arm on the identical tree -> 3 entries / change event fired.
//
// Do not reintroduce '*' or '**' here. getWatchRoots() is asserted glob-free by
// the unit test, and the integration test drives the real chokidar end to end.
// ---------------------------------------------------------------------------

export function getWatchRoots(): string[] {
  const roots: string[] = [];

  for (const org of getOrgs()) {
    const orgBase = path.join(CTX_ROOT, 'orgs', org);
    roots.push(path.join(orgBase, 'tasks'));
    roots.push(path.join(orgBase, 'approvals'));
    roots.push(path.join(orgBase, 'analytics', 'events'));
  }

  // Flat roots (not org-scoped)
  roots.push(path.join(CTX_ROOT, 'state'));
  roots.push(path.join(CTX_ROOT, 'inbox'));

  return roots;
}

// Directories that sit under a watch root, churn constantly, and hold nothing
// we ingest. state/<agent>/claude-config alone is 22372 of the 22765 entries
// under state/ — watching it would cost a recursive watch on the whole agent
// config tree and fire handleFileChange on every Claude session write.
const PRUNED_DIRS = new Set(['claude-config', 'node_modules', '.git']);

export function isPruned(filePath: string): boolean {
  return filePath.split(path.sep).some((seg) => PRUNED_DIRS.has(seg));
}

// Which files under a watch root are worth acting on. Mirrors the branches in
// syncFile(), plus inbox/*.json, which is SSE-only (syncFile has no inbox case).
export function isRelevant(filePath: string): boolean {
  if (filePath.includes('/analytics/events/')) return filePath.endsWith('.jsonl');
  if (filePath.includes('/state/')) return filePath.endsWith('heartbeat.json');
  return filePath.endsWith('.json');
}

// ---------------------------------------------------------------------------
// File change handler
// ---------------------------------------------------------------------------

function categorizeFilePath(filePath: string): SSEEvent['type'] {
  if (filePath.includes('/tasks/')) return 'task';
  if (filePath.includes('/approvals/')) return 'approval';
  if (filePath.includes('/heartbeat.json')) return 'heartbeat';
  if (filePath.includes('/analytics/events/')) return 'event';
  return 'sync';
}

function handleFileChange(
  filePath: string,
  changeType: 'change' | 'add' | 'remove',
): void {
  if (!isRelevant(filePath)) return;

  console.log(`[watcher] ${changeType}: ${filePath}`);

  // Sync the changed file to SQLite (skip for deletions)
  if (changeType !== 'remove') {
    try {
      syncFile(filePath);
    } catch (err) {
      console.error(`[watcher] Sync failed for ${filePath}:`, err);
    }
  }

  // Emit SSE event
  const sseEvent: SSEEvent = {
    type: categorizeFilePath(filePath),
    data: { filePath, changeType },
    timestamp: new Date().toISOString(),
  };

  emitter.emit('sse', sseEvent);
}

// ---------------------------------------------------------------------------
// Watcher factory
// ---------------------------------------------------------------------------

function createWatcher(): FSWatcher {
  const roots = getWatchRoots();

  // A watch root that does not exist is accepted silently by chokidar and
  // ingests nothing forever. That silence is the whole bug this file had, so
  // report it — but do not throw: a fresh install legitimately has no inbox/
  // yet, and taking the dashboard down over one absent directory is worse than
  // running degraded and saying so.
  const present: string[] = [];
  for (const root of roots) {
    if (fs.existsSync(root)) {
      present.push(root);
    } else {
      console.error(
        `[watcher] watch root does not exist, nothing will be ingested from it: ${root}`,
      );
    }
  }

  if (present.length === 0) {
    console.error(
      `[watcher] NO watch roots exist under ${CTX_ROOT} — ingestion is dead on arrival`,
    );
  }

  const watcher = watch(present, {
    ignoreInitial: true,
    persistent: true,
    ignored: (p: string) => isPruned(p),
    awaitWriteFinish: {
      stabilityThreshold: 300,
      pollInterval: 100,
    },
  });

  watcher.on('add', (fp) => handleFileChange(fp, 'add'));
  watcher.on('change', (fp) => handleFileChange(fp, 'change'));
  watcher.on('unlink', (fp) => handleFileChange(fp, 'remove'));
  watcher.on('error', (error) => console.error('[watcher] Error:', error));

  // Report what chokidar RESOLVED, not what we handed it.
  //
  // The old line logged "Watching 8 patterns" — a count of its own argument. It
  // read healthy while chokidar had resolved those 8 patterns to nothing at
  // all. A health signal derived from your own input can only tell you what you
  // asked for, so count the watched set instead and shout when it is empty.
  watcher.on('ready', () => {
    const watched = watcher.getWatched();
    const dirs = Object.keys(watched).length;
    const entries = Object.values(watched).reduce((n, v) => n + v.length, 0);

    if (entries === 0) {
      console.error(
        `[watcher] ready but watching ZERO entries under ${CTX_ROOT} — ingestion is dead`,
      );
    } else {
      console.log(
        `[watcher] ready — watching ${entries} entries across ${dirs} directories (${present.length} roots)`,
      );
    }
  });

  return watcher;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Initialize the file watcher singleton.
 * Runs a full sync on first call, then starts watching for incremental changes.
 */
export function initWatcher(): FSWatcher {
  if (globalForWatcher.__cortextos_watcher) {
    return globalForWatcher.__cortextos_watcher;
  }

  console.log('[watcher] Running initial full sync...');
  syncAll();

  const watcher = createWatcher();

  // Store the singleton UNCONDITIONALLY, production included.
  //
  // This was previously guarded by `NODE_ENV !== 'production'`, copying the
  // hot-reload pattern used for the emitter above. That guard is correct for
  // module-level state (the emitter is a module const, so production retains it
  // anyway) but WRONG here: the watcher is function-local, so with nothing
  // storing it the early-return guard never fired, every call built a new
  // watcher and ran another full sync, and no reference outlived the request.
  //
  // initWatcher's only caller was the SSE route, so in production the dashboard
  // ingested ONLY while a browser held an open SSE connection — it was not a
  // monitoring system, it was a live view that recorded only while watched.
  // Measured: the DB sat frozen for 37 hours while the process was online,
  // serving, and green.
  globalForWatcher.__cortextos_watcher = watcher;

  return watcher;
}

/**
 * Gracefully close the watcher.
 */
export function stopWatcher(): void {
  if (globalForWatcher.__cortextos_watcher) {
    globalForWatcher.__cortextos_watcher.close();
    globalForWatcher.__cortextos_watcher = undefined;
  }
}

/**
 * Subscribe to SSE events. Returns an unsubscribe function.
 */
export function onSSEEvent(
  handler: (event: SSEEvent) => void,
): () => void {
  emitter.on('sse', handler);
  return () => emitter.off('sse', handler);
}

// Graceful shutdown on process exit
if (typeof process !== 'undefined') {
  const shutdown = () => {
    stopWatcher();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
