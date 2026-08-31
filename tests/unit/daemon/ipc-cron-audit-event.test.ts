/**
 * tests/unit/daemon/ipc-cron-audit-event.test.ts
 *
 * Regression test for task_1788142055347_87999645: add-cron/remove-cron
 * mutated crons.json with no corresponding event-log entry, so a cron's
 * disappearance was unattributable from crons.json alone (had to be
 * reconstructed from bus-message archaeology). Verifies both mutations now
 * emit a `cron_added` / `cron_removed` event (category=action) with the
 * agent, cron name, and schedule.
 *
 * Drives IPCServer.handleRequest directly (private method, accessed via
 * bracket notation — no established public entry point for this in the
 * existing test suite, see ipc-list-executions.test.ts for the same
 * fake-AgentManager pattern). No real socket/daemon process.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type { IPCRequest, IPCResponse } from '../../../src/types/index';

let tmpRoot: string;
const originalCtxRoot = process.env.CTX_ROOT;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'ipc-cron-audit-'));
  process.env.CTX_ROOT = tmpRoot;
  vi.resetModules();
});

afterEach(() => {
  if (originalCtxRoot !== undefined) {
    process.env.CTX_ROOT = originalCtxRoot;
  } else {
    delete process.env.CTX_ROOT;
  }
  try { rmSync(tmpRoot, { recursive: true }); } catch { /* ignore */ }
});

function writeEnabledAgents(agents: Record<string, { enabled?: boolean; org?: string }>): void {
  const configDir = join(tmpRoot, 'config');
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, 'enabled-agents.json'), JSON.stringify(agents), 'utf-8');
}

// Minimal fake AgentManager — same shape as ipc-list-executions.test.ts's
// fakeAgentManager(), plus resolveAgentOrg + ctxRoot (both now public,
// used by the new audit-log call site to build a CTX_ROOT-aware BusPaths —
// resolvePaths() silently falls back to the real homedir without an
// explicit ctxRootOverride, see utils/paths.ts).
function fakeAgentManager(org: string) {
  return {
    getAllStatuses: () => [],
    getAgentNames: () => [],
    startAgent: async () => {},
    stopAgent: async () => {},
    restartAgent: async () => {},
    getFastChecker: () => null,
    spawnWorker: async () => {},
    terminateWorker: async () => {},
    listWorkers: () => [],
    injectWorker: () => false,
    injectAgent: () => true,
    reloadCrons: () => {},
    resolveAgentOrg: () => org,
    ctxRoot: tmpRoot,
  };
}

// handleRequest writes JSON responses to the socket it's given — a fake with
// just a no-op write() is enough since these tests assert on the on-disk
// event log, not the IPC response itself.
function fakeSocket() {
  const chunks: string[] = [];
  return { write: (s: string) => { chunks.push(s); }, _chunks: chunks };
}

function readEvents(agent: string): Array<Record<string, unknown>> {
  const eventsFile = join(tmpRoot, 'orgs', 'testorg', 'analytics', 'events', agent, new Date().toISOString().split('T')[0] + '.jsonl');
  if (!existsSync(eventsFile)) return [];
  return readFileSync(eventsFile, 'utf-8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map(l => JSON.parse(l));
}

describe('add-cron/remove-cron audit events', () => {
  it('add-cron emits a cron_added event with agent, cron name, and schedule', async () => {
    writeEnabledAgents({ testagent: { enabled: true, org: 'testorg' } });
    const { IPCServer } = await import('../../../src/daemon/ipc-server.js');
    const server = new IPCServer(fakeAgentManager('testorg') as never);

    const request: IPCRequest = {
      type: 'add-cron',
      agent: 'testagent',
      data: { definition: { name: 'my-new-cron', schedule: '4h', prompt: 'do the thing' } },
    };
    (server as unknown as { handleRequest: (r: IPCRequest, s: unknown) => void })
      .handleRequest(request, fakeSocket());

    const events = readEvents('testagent');
    const added = events.filter(e => e.event === 'cron_added');
    expect(added).toHaveLength(1);
    expect(added[0].category).toBe('action');
    expect(added[0].agent).toBe('testagent');
    const meta = added[0].metadata as Record<string, unknown>;
    expect(meta.cron).toBe('my-new-cron');
    expect(meta.schedule).toBe('4h');
  });

  it('remove-cron emits a cron_removed event carrying the OLD schedule', async () => {
    writeEnabledAgents({ testagent: { enabled: true, org: 'testorg' } });
    const { IPCServer } = await import('../../../src/daemon/ipc-server.js');
    const server = new IPCServer(fakeAgentManager('testorg') as never);
    const handle = (server as unknown as { handleRequest: (r: IPCRequest, s: unknown) => void })
      .handleRequest.bind(server);

    // Seed a real cron first, via the same IPC path, so remove-cron has
    // something real to look up and remove (not hand-written crons.json).
    handle(
      { type: 'add-cron', agent: 'testagent', data: { definition: { name: 'doomed', schedule: '6h', prompt: 'x' } } },
      fakeSocket(),
    );

    handle({ type: 'remove-cron', agent: 'testagent', data: { name: 'doomed' } }, fakeSocket());

    const events = readEvents('testagent');
    const removed = events.filter(e => e.event === 'cron_removed');
    expect(removed).toHaveLength(1);
    expect(removed[0].category).toBe('action');
    const meta = removed[0].metadata as Record<string, unknown>;
    expect(meta.cron).toBe('doomed');
    expect(meta.old_schedule).toBe('6h');
  });

  it('remove-cron on a nonexistent cron does NOT emit an audit event', async () => {
    writeEnabledAgents({ testagent: { enabled: true, org: 'testorg' } });
    const { IPCServer } = await import('../../../src/daemon/ipc-server.js');
    const server = new IPCServer(fakeAgentManager('testorg') as never);

    (server as unknown as { handleRequest: (r: IPCRequest, s: unknown) => void })
      .handleRequest({ type: 'remove-cron', agent: 'testagent', data: { name: 'never-existed' } }, fakeSocket());

    expect(readEvents('testagent')).toHaveLength(0);
  });
});
