import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { FastChecker, handoffGraceMs } from '../../../src/daemon/fast-checker.js';
import type { BusPaths } from '../../../src/types/index.js';

// Post-boot handoff grace window (ported additively from upstream grandamenium/cortextos,
// see deliverables/2026-07-28-daemon-circuit-breaker-upstream-reconciliation.md). Verifies
// the ported feature suppresses Tier 1/2 (soft, cooperative actions) on a freshly-started
// session while leaving Tier 3 (deadline force-restart) and the hard overflow-banner check
// untouched — those must still act regardless of session age, since they are safety
// backstops, not cooperative prompts.
describe('handoffGraceMs (pure function)', () => {
  it('codex-app-server gets the 10min window', () => {
    expect(handoffGraceMs('codex-app-server')).toBe(600_000);
  });

  it('opencode gets the 10min window (upstream-only runtime, kept for parity)', () => {
    expect(handoffGraceMs('opencode')).toBe(600_000);
  });

  it('claude-code, hermes, and undefined all get the 2min default', () => {
    expect(handoffGraceMs('claude-code')).toBe(120_000);
    expect(handoffGraceMs('hermes')).toBe(120_000);
    expect(handoffGraceMs(undefined)).toBe(120_000);
  });
});

describe('post-boot handoff grace window (checkContextStatus)', () => {
  let testDir: string;
  let paths: BusPaths;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'ctx-grace-'));
    paths = {
      ctxRoot: testDir,
      inbox: join(testDir, 'inbox'),
      inflight: join(testDir, 'inflight'),
      processed: join(testDir, 'processed'),
      logDir: join(testDir, 'logs'),
      stateDir: join(testDir, 'state'),
      taskDir: join(testDir, 'tasks'),
      approvalDir: join(testDir, 'approvals'),
      analyticsDir: join(testDir, 'analytics'),
      deliverablesDir: join(testDir, 'deliverables'),
    };
    for (const dir of Object.values(paths)) mkdirSync(dir, { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  function makeCtxAgent(name = 'ctx-agent', runtime?: string) {
    const config: Record<string, unknown> = runtime ? { runtime } : {};
    return {
      name,
      isBootstrapped: vi.fn().mockReturnValue(true),
      injectMessage: vi.fn().mockReturnValue(true),
      write: vi.fn(),
      getAgentDir: () => testDir,
      getConfig: () => config,
      getOutputBuffer: () => ({ getRecent: () => '' }),
      sessionRefresh: vi.fn().mockResolvedValue(undefined),
    } as any;
  }

  function writeConfig(cfg: Record<string, unknown>) {
    writeFileSync(join(testDir, 'config.json'), JSON.stringify(cfg), 'utf-8');
  }

  function writeCtxStatus(pct: number, sessionId?: string) {
    writeFileSync(
      join(paths.stateDir, 'context_status.json'),
      JSON.stringify({
        used_percentage: pct,
        exceeds_200k_tokens: false,
        written_at: new Date().toISOString(),
        session_id: sessionId,
      }),
      'utf-8',
    );
  }

  function injected(agent: any): string[] {
    return agent.injectMessage.mock.calls.map((c: any[]) => c[0] as string);
  }

  it('a new session_id anchors ctxSessionStartedAt', async () => {
    const agent = makeCtxAgent();
    const checker = new FastChecker(agent, paths, '/tmp/framework');
    writeConfig({});
    writeCtxStatus(10, 'sess-1');
    await (checker as any).checkContextStatus();
    expect((checker as any).ctxSessionStartedAt).toBeGreaterThan(0);
  });

  it('within grace: a high reading right after a fresh session start fires NEITHER warning nor handoff', async () => {
    const agent = makeCtxAgent();
    const checker = new FastChecker(agent, paths, '/tmp/framework');
    writeConfig({});
    // First tick anchors the session at "now".
    writeCtxStatus(10, 'sess-1');
    await (checker as any).checkContextStatus();
    // Second tick, same session, high reading — still well inside the 2min default grace.
    writeCtxStatus(70, 'sess-1');
    await (checker as any).checkContextStatus();
    expect(agent.injectMessage).not.toHaveBeenCalled();
    expect((checker as any).ctxHandoffFiredAt).toBe(0);
  });

  it('after grace expires: the same high reading on the same session DOES fire the handoff', async () => {
    const agent = makeCtxAgent();
    const checker = new FastChecker(agent, paths, '/tmp/framework');
    writeConfig({});
    writeCtxStatus(10, 'sess-1');
    await (checker as any).checkContextStatus();
    // Backdate the anchor past the 2min default grace instead of waiting in real time.
    (checker as any).ctxSessionStartedAt = Date.now() - 121_000;
    writeCtxStatus(70, 'sess-1');
    await (checker as any).checkContextStatus();
    expect(injected(agent).some(m => m.includes('CONTEXT HANDOFF REQUIRED'))).toBe(true);
    expect((checker as any).ctxHandoffFiredAt).toBeGreaterThan(0);
  });

  it('runtime-aware: codex-app-server stays suppressed at 3min (inside its 10min grace) where claude-code would already have fired', async () => {
    const agent = makeCtxAgent('codex-agent', 'codex-app-server');
    const checker = new FastChecker(agent, paths, '/tmp/framework');
    writeConfig({});
    writeCtxStatus(10, 'sess-1');
    await (checker as any).checkContextStatus();
    (checker as any).ctxSessionStartedAt = Date.now() - 3 * 60_000; // 3min old
    writeCtxStatus(70, 'sess-1');
    await (checker as any).checkContextStatus();
    expect(agent.injectMessage).not.toHaveBeenCalled();
    expect((checker as any).ctxHandoffFiredAt).toBe(0);
  });

  it('Tier 3 (deadline-exceeded force-restart) still fires even while within grace — grace only suppresses Tier 1/2', async () => {
    const agent = makeCtxAgent();
    const checker = new FastChecker(agent, paths, '/tmp/framework');
    writeConfig({});
    // Simulate a session that just started (within grace) but already has a blown Tier-2
    // deadline carried over — e.g. state surviving a fast reload. Grace must not mask this.
    (checker as any).ctxSessionStartedAt = Date.now();
    (checker as any).ctxHandoffDeadlineAt = Date.now() - 1000;
    const spy = vi.spyOn(checker as any, 'forceContextRestart').mockImplementation(() => {});
    writeCtxStatus(70);
    await (checker as any).checkContextStatus();
    expect(spy).toHaveBeenCalled();
  });

  it('the hard API-overflow banner check still force-restarts even within grace', async () => {
    const BANNER = 'conversation too long, please start compaction';
    const agent = makeCtxAgent();
    agent.getOutputBuffer = () => ({ getRecent: () => BANNER });
    const checker = new FastChecker(agent, paths, '/tmp/framework');
    (checker as any).ctxSessionStartedAt = Date.now(); // freshly anchored, well within grace
    const spy = vi.spyOn(checker as any, 'forceContextRestart').mockImplementation(() => {});
    writeConfig({});
    writeCtxStatus(90);
    await (checker as any).checkContextStatus();
    expect(spy).toHaveBeenCalled();
  });

  it('is independent of the consecutive Tier-3 circuit breaker: grace suppresses Tier 1/2 without touching consecutiveCtxRestartsWithoutRecovery', async () => {
    const agent = makeCtxAgent();
    const checker = new FastChecker(agent, paths, '/tmp/framework');
    writeConfig({});
    (checker as any).forceContextRestart('reason 1');
    expect((checker as any).consecutiveCtxRestartsWithoutRecovery).toBe(1);
    // Above warn (30) so the separate confirmed-recovery reset (a real, distinct feature —
    // see the "Confirmed recovery" block in checkContextStatus) does not fire here; this
    // isolates grace-window anchoring itself from that unrelated reset path.
    writeCtxStatus(50, 'sess-1');
    await (checker as any).checkContextStatus(); // anchors grace, suppresses Tier 1/2 — no interaction
    expect((checker as any).consecutiveCtxRestartsWithoutRecovery).toBe(1); // untouched by grace anchoring
  });
});

describe('loadCtxCircuit — defensive logging on upstream-shaped state (belt-and-suspenders)', () => {
  let testDir: string;
  let paths: BusPaths;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'ctx-circuit-shape-'));
    paths = {
      ctxRoot: testDir,
      inbox: join(testDir, 'inbox'),
      inflight: join(testDir, 'inflight'),
      processed: join(testDir, 'processed'),
      logDir: join(testDir, 'logs'),
      stateDir: join(testDir, 'state'),
      taskDir: join(testDir, 'tasks'),
      approvalDir: join(testDir, 'approvals'),
      analyticsDir: join(testDir, 'analytics'),
      deliverablesDir: join(testDir, 'deliverables'),
    };
    for (const dir of Object.values(paths)) mkdirSync(dir, { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  function makeCtxAgent(name = 'ctx-agent') {
    return {
      name,
      isBootstrapped: vi.fn().mockReturnValue(true),
      injectMessage: vi.fn().mockReturnValue(true),
      write: vi.fn(),
      getAgentDir: () => testDir,
      getConfig: () => ({}),
      getOutputBuffer: () => ({ getRecent: () => '' }),
      sessionRefresh: vi.fn().mockResolvedValue(undefined),
    } as any;
  }

  it('logs (does not crash) when .ctx-circuit.json is in upstream shape ({ restarts: number[] }) and resets to wyre defaults', () => {
    writeFileSync(join(paths.stateDir, '.ctx-circuit.json'), JSON.stringify({ restarts: [Date.now(), Date.now()] }), 'utf-8');
    const logs: string[] = [];
    const agent = makeCtxAgent();
    const checker = new FastChecker(agent, paths, '/tmp/framework', { log: (m: string) => logs.push(m) });
    expect((checker as any).consecutiveCtxRestartsWithoutRecovery).toBe(0);
    expect((checker as any).ctxCircuitBrokenAt).toBeNull();
    expect(logs.some(m => m.includes('upstream-shaped format'))).toBe(true);
  });

  it('does NOT log for wyre-shaped state (no false positive on the normal on-disk shape)', () => {
    writeFileSync(
      join(paths.stateDir, '.ctx-circuit.json'),
      JSON.stringify({ consecutiveWithoutRecovery: 2, handoffFires: [], brokenAt: null }),
      'utf-8',
    );
    const logs: string[] = [];
    const agent = makeCtxAgent();
    const checker = new FastChecker(agent, paths, '/tmp/framework', { log: (m: string) => logs.push(m) });
    expect((checker as any).consecutiveCtxRestartsWithoutRecovery).toBe(2);
    expect(logs.some(m => m.includes('upstream-shaped format'))).toBe(false);
  });
});
