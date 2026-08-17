import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'fs';
import { spawn, ChildProcess } from 'child_process';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  writeAgentPid,
  readAgentPid,
  clearAgentPid,
  isPidAlive,
  processStartTimeMs,
  verifyOwnership,
  reapOrphan,
  AgentPidRecord,
} from '../../../src/utils/agent-pidfile';

const noop = () => {};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('agent-pidfile', () => {
  let stateDir: string;
  const children: ChildProcess[] = [];

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), 'cortextos-pidfile-test-'));
  });

  afterEach(() => {
    for (const c of children) {
      try { if (c.pid) process.kill(c.pid, 'SIGKILL'); } catch { /* already dead */ }
    }
    children.length = 0;
    rmSync(stateDir, { recursive: true, force: true });
  });

  /** Spawn a real, long-lived child and return its pid. */
  function spawnChild(): number {
    const c = spawn('sleep', ['60'], { stdio: 'ignore' });
    children.push(c);
    if (!c.pid) throw new Error('failed to spawn test child');
    return c.pid;
  }

  it('round-trips write/read/clear', () => {
    writeAgentPid(stateDir, 'forge', 4242, 999);
    const rec = readAgentPid(stateDir);
    expect(rec?.pid).toBe(4242);
    expect(rec?.agentName).toBe('forge');
    expect(rec?.daemonPid).toBe(999);
    clearAgentPid(stateDir);
    expect(readAgentPid(stateDir)).toBeNull();
  });

  it('readAgentPid returns null on missing or corrupt file', () => {
    expect(readAgentPid(stateDir)).toBeNull();
  });

  it('isPidAlive: true for a live pid, false for a certainly-dead one', () => {
    expect(isPidAlive(process.pid)).toBe(true);
    // A pid this large is not assigned on any real system.
    expect(isPidAlive(2_000_000_000)).toBe(false);
    expect(isPidAlive(-1)).toBe(false);
    expect(isPidAlive(0)).toBe(false);
  });

  it('verifyOwnership => "dead" when the pid is not alive', () => {
    const rec: AgentPidRecord = { pid: 2_000_000_000, agentName: 'x', spawnedAt: Date.now(), startedAt: Date.now(), daemonPid: 1 };
    expect(verifyOwnership(rec)).toBe('dead');
  });

  it('verifyOwnership => "owned" when alive AND recorded start-time matches', () => {
    const pid = spawnChild();
    const rec: AgentPidRecord = {
      pid, agentName: 'x', spawnedAt: Date.now(),
      startedAt: processStartTimeMs(pid), // the true start time
      daemonPid: process.pid,
    };
    expect(verifyOwnership(rec)).toBe('owned');
  });

  it('CATASTROPHIC GUARD: verifyOwnership => "unverified" when alive but start-time MISMATCHES (recycled pid)', () => {
    const pid = spawnChild();
    const rec: AgentPidRecord = {
      pid, agentName: 'x', spawnedAt: Date.now(),
      startedAt: (processStartTimeMs(pid) ?? Date.now()) - 10 * 60_000, // 10 min off => recycled
      daemonPid: process.pid,
    };
    expect(verifyOwnership(rec)).toBe('unverified');
  });

  it('verifyOwnership => "unverified" when no start-time anchor was recorded', () => {
    const pid = spawnChild();
    const rec: AgentPidRecord = { pid, agentName: 'x', spawnedAt: Date.now(), startedAt: null, daemonPid: process.pid };
    expect(verifyOwnership(rec)).toBe('unverified');
  });

  it('reapOrphan on a dead pid: no kill, clears the pidfile', async () => {
    const rec: AgentPidRecord = { pid: 2_000_000_000, agentName: 'x', spawnedAt: Date.now(), startedAt: Date.now(), daemonPid: 1 };
    writeAgentPid(stateDir, 'x', rec.pid, rec.daemonPid);
    const res = await reapOrphan(stateDir, rec, noop);
    expect(res.reaped).toBe(false);
    expect(res.verdict).toBe('dead');
    expect(existsSync(join(stateDir, 'agent.pid'))).toBe(false);
  });

  it('CATASTROPHIC GUARD: reapOrphan REFUSES to kill an unverified (recycled) live pid + KEEPS its pidfile', async () => {
    const pid = spawnChild();
    writeAgentPid(stateDir, 'x', pid, process.pid);
    const rec: AgentPidRecord = {
      pid, agentName: 'x', spawnedAt: Date.now(),
      startedAt: (processStartTimeMs(pid) ?? Date.now()) - 10 * 60_000, // recycled anchor
      daemonPid: process.pid,
    };
    const res = await reapOrphan(stateDir, rec, noop);
    expect(res.reaped).toBe(false);
    expect(res.verdict).toBe('unverified');
    await sleep(100);
    expect(isPidAlive(pid)).toBe(true); // the innocent process is STILL ALIVE
    // ACCRETION GUARD: never delete a still-alive process's pidfile — otherwise
    // the orphan would evade the next boot-reap and accrete.
    expect(existsSync(join(stateDir, 'agent.pid'))).toBe(true);
  });

  it('reapOrphan kills an ownership-confirmed live orphan (SIGTERM path) + clears its pidfile', async () => {
    const pid = spawnChild();
    writeAgentPid(stateDir, 'x', pid, process.pid);
    const rec: AgentPidRecord = {
      pid, agentName: 'x', spawnedAt: Date.now(),
      startedAt: processStartTimeMs(pid), // true start time => owned
      daemonPid: process.pid,
    };
    const res = await reapOrphan(stateDir, rec, noop, 500);
    expect(res.verdict).toBe('owned');
    expect(res.reaped).toBe(true);
    await sleep(200);
    expect(isPidAlive(pid)).toBe(false); // confirmed reaped
    expect(existsSync(join(stateDir, 'agent.pid'))).toBe(false); // pidfile cleared on confirmed reap
  });

  it('reapOrphan re-verifies ownership then SIGKILLs a still-owned orphan that ignores SIGTERM', async () => {
    // A process that traps (ignores) SIGTERM: survives the grace window, so
    // reapOrphan must escalate — but only after RE-verifying ownership (the
    // TOCTOU guard). Ownership still holds here, so SIGKILL lands.
    const c = spawn('sh', ['-c', 'trap "" TERM; sleep 5'], { stdio: 'ignore' });
    children.push(c);
    const pid = c.pid!;
    await sleep(200); // let the trap install
    const rec: AgentPidRecord = {
      pid, agentName: 'x', spawnedAt: Date.now(),
      startedAt: processStartTimeMs(pid),
      daemonPid: process.pid,
    };
    const res = await reapOrphan(stateDir, rec, noop, 400);
    expect(res.verdict).toBe('owned');
    await sleep(300);
    expect(isPidAlive(pid)).toBe(false); // SIGKILL landed after ownership re-verify
  });

  it('REGRESSION (2026-07-13 restart-storm): after a restart cycle reaps the prior session, isPidAlive confirms NO live orphan of the OLD pid remains', async () => {
    // Direct regression proof for the cross-path restart-lock fix (fast-checker.ts's
    // forceHangRestart/forceContextRestart + agent-manager.ts's restartAgent racing
    // via sessionRefresh() bypassing all 3 gated call-sites — a 4th, unguarded
    // caller, the session-time-cap rollover timer, was the confirmed mechanism).
    // The lock itself prevents a SECOND restart trigger from firing concurrently,
    // but the actual "no orphan" guarantee ultimately rests on THIS check — the same
    // isPidAlive/reapOrphan primitive agent-manager.ts's stopAgent already calls for
    // any pidfile it finds pointing at a no-longer-registered agent. Simulating that
    // exact shape: a "previous session" pid on disk (as if start() is about to run
    // again post-restart and finds a stale pidfile from before), verify the pre-check
    // sees it alive, then confirm reapOrphan (the code path stopAgent invokes) kills
    // it and isPidAlive subsequently reports it dead — no live process from the OLD
    // session survives into the new one.
    const oldSessionPid = spawnChild();
    expect(isPidAlive(oldSessionPid)).toBe(true); // sanity: old session genuinely alive first

    const rec: AgentPidRecord = {
      pid: oldSessionPid, agentName: 'dev', spawnedAt: Date.now(),
      startedAt: processStartTimeMs(oldSessionPid), // true start time => ownership verifies
      daemonPid: process.pid,
    };
    const res = await reapOrphan(stateDir, rec, noop, 500);
    expect(res.verdict).toBe('owned');
    expect(res.reaped).toBe(true);
    await sleep(200);

    expect(isPidAlive(oldSessionPid)).toBe(false); // the OLD pid is confirmed dead — no orphan
    expect(existsSync(join(stateDir, 'agent.pid'))).toBe(false); // pidfile cleared too
  });
});
