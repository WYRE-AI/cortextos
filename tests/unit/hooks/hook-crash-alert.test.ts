import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const execFileMock = vi.fn();
vi.mock('child_process', () => ({
  execFile: (...args: unknown[]) => execFileMock(...args),
}));

import { notifyAgents, classifyFromMarkers, detectRateLimitWithRetry } from '../../../src/hooks/hook-crash-alert';
import { clearEndMarkers } from '../../../src/bus/heartbeat';

describe('notifyAgents', () => {
  // notifyAgents branches on process.env.CTX_FRAMEWORK_ROOT (execPath+cliPath
  // vs a bare 'cortextos' PATH lookup — see the function's own comment), which
  // shifts where `body` lands in the execFile args array. Pin it unset here
  // so these tests are deterministic regardless of the shell they run in —
  // running from a live agent's own shell (which DOES have CTX_FRAMEWORK_ROOT
  // set) previously made these tests silently environment-dependent.
  let originalFrameworkRoot: string | undefined;

  beforeEach(() => {
    execFileMock.mockReset();
    originalFrameworkRoot = process.env.CTX_FRAMEWORK_ROOT;
    delete process.env.CTX_FRAMEWORK_ROOT;
  });

  afterEach(() => {
    if (originalFrameworkRoot === undefined) {
      delete process.env.CTX_FRAMEWORK_ROOT;
    } else {
      process.env.CTX_FRAMEWORK_ROOT = originalFrameworkRoot;
    }
  });

  it('sends one bus send-message per recipient', () => {
    notifyAgents({
      agentName: 'dev',
      endType: 'crash',
      reason: 'uncaught exception',
      lastTask: 'building hooks',
      crashCount: 2,
      recipients: ['chief', 'analyst'],
    });
    expect(execFileMock).toHaveBeenCalledTimes(2);
  });

  it('uses cortextos bus send-message with priority high', () => {
    notifyAgents({
      agentName: 'dev',
      endType: 'crash',
      reason: 'r',
      lastTask: 't',
      crashCount: 1,
      recipients: ['chief'],
    });
    const [cmd, args] = execFileMock.mock.calls[0];
    expect(cmd).toBe('cortextos');
    expect(args.slice(0, 4)).toEqual(['bus', 'send-message', 'chief', 'high']);
  });

  it('body includes all required fields, and does NOT assert a restart-attempted claim', () => {
    // task_1785077810721 (S1): this hook has zero visibility into the real
    // halt-gate decision (agent-process.ts) — it must never claim whether a
    // restart was attempted or blocked. Body should surface the hook's own
    // counter honestly labeled, not as an authoritative restart-gate signal.
    notifyAgents({
      agentName: 'dev',
      endType: 'daemon-crashed',
      reason: 'PTY null write',
      lastTask: 'idle',
      crashCount: 3,
      recipients: ['analyst'],
    });
    const body: string = execFileMock.mock.calls[0][1][4];
    expect(body).toContain('agent=dev');
    expect(body).toContain('type=daemon-crashed');
    expect(body).toContain('reason: PTY null write');
    expect(body).toContain('last status: idle');
    expect(body).toContain('crashes today (hook-observed, not the restart-gate count): 3');
    expect(body).not.toContain('restart attempted');
    expect(body).not.toContain('max_crashes_per_day');
  });

  it('uses fallback strings when reason and lastTask are empty', () => {
    notifyAgents({
      agentName: 'dev',
      endType: 'crash',
      reason: '',
      lastTask: '',
      crashCount: 1,
      recipients: ['chief'],
    });
    const body: string = execFileMock.mock.calls[0][1][4];
    expect(body).toContain('reason: none');
    expect(body).toContain('last status: unknown');
  });

  it('does not throw when execFile throws synchronously', () => {
    execFileMock.mockImplementationOnce(() => { throw new Error('exec failed'); });
    expect(() => notifyAgents({
      agentName: 'dev',
      endType: 'crash',
      reason: '',
      lastTask: '',
      crashCount: 1,
      recipients: ['chief', 'analyst'],
    })).not.toThrow();
    // Second recipient still attempted
    expect(execFileMock).toHaveBeenCalledTimes(2);
  });
});

describe('detectRateLimitWithRetry', () => {
  // task_1785077810721 (S1, part b, defect 1): detectRateLimitInLog reads
  // ONLY the current tail of stdout.log — a process that dies immediately
  // after hitting a rate limit can exit before the banner is flushed to
  // disk. These tests prove the RETRY actually catches that race, not just
  // that the final state happens to match.
  let tmp: string;
  let stdoutPath: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'crashalert-ratelimit-'));
    stdoutPath = join(tmp, 'stdout.log');
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('returns true immediately, no retry needed, when the signature is already present', async () => {
    // Spy on setTimeout (rather than asserting a wall-clock elapsed-time
    // ceiling — flaky under CI load per Codex review) to prove the retry
    // interval was never entered: the first read hit, zero sleeps scheduled.
    const timeoutSpy = vi.spyOn(global, 'setTimeout');
    writeFileSync(stdoutPath, 'some output\nrate limit exceeded\n', 'utf-8');
    expect(await detectRateLimitWithRetry(stdoutPath, 3, 50)).toBe(true);
    expect(timeoutSpy).not.toHaveBeenCalled();
    timeoutSpy.mockRestore();
  });

  it('catches a LATE-appearing banner — absent on the first read, written before a later retry', async () => {
    // Simulates the exact repro from crashes.log (task_1785077810721): the
    // process died before flushing the rate-limit banner, so the file has
    // no signature at hook-fire time. The banner lands moments later.
    writeFileSync(stdoutPath, 'starting up...\n', 'utf-8');
    const resultPromise = detectRateLimitWithRetry(stdoutPath, 3, 30);
    // Write the banner between the 1st and 2nd read, before the retry loop
    // gives up — proves a RETRY caught it, not the initial read.
    await new Promise((resolve) => setTimeout(resolve, 12));
    writeFileSync(stdoutPath, 'starting up...\nAPI Error: rate_limit_error: usage limit reached\n', 'utf-8');
    expect(await resultPromise).toBe(true);
  });

  it('returns false (real crash, not rate-limited) when the signature never appears — no false positive', async () => {
    // Guards the false-positive direction boss flagged: a genuine crash
    // must still classify as crash, not get swept into rate-limited by an
    // overly generous retry.
    writeFileSync(stdoutPath, 'Uncaught TypeError: x is not a function\n', 'utf-8');
    expect(await detectRateLimitWithRetry(stdoutPath, 3, 15)).toBe(false);
  });

  it('gives up after the bounded attempt count — does not retry indefinitely', async () => {
    // Spy on setTimeout instead of a wall-clock ceiling (flaky under CI
    // load per Codex review) — proves the EXACT bound deterministically:
    // 3 attempts means exactly 2 intervals waited, then it gives up.
    const timeoutSpy = vi.spyOn(global, 'setTimeout');
    writeFileSync(stdoutPath, 'no signature here, ever\n', 'utf-8');
    const result = await detectRateLimitWithRetry(stdoutPath, 3, 20);
    expect(result).toBe(false);
    expect(timeoutSpy).toHaveBeenCalledTimes(2);
    timeoutSpy.mockRestore();
  });
});

describe('classifyFromMarkers', () => {
  let tmp: string;
  const MARKERS = [
    { file: '.restart-planned', type: 'planned-restart' },
    { file: '.session-refresh', type: 'session-refresh' },
    { file: '.user-restart', type: 'user-restart' },
    { file: '.user-stop', type: 'user-stop' },
  ];

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'crashalert-markers-'));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('no marker present → endType crash', () => {
    expect(classifyFromMarkers(tmp, MARKERS).endType).toBe('crash');
  });

  it('fresh marker → classified by type, with its reason', () => {
    writeFileSync(join(tmp, '.restart-planned'), 'planned reboot', 'utf-8');
    const r = classifyFromMarkers(tmp, MARKERS);
    expect(r.endType).toBe('planned-restart');
    expect(r.reason).toBe('planned reboot');
  });

  it('does NOT consume the marker — both firings of a restart see it', () => {
    writeFileSync(join(tmp, '.session-refresh'), 'rollover', 'utf-8');
    // Firing #1 — the dying PTY's SessionEnd.
    expect(classifyFromMarkers(tmp, MARKERS).endType).toBe('session-refresh');
    // Firing #2 — the next PTY's fresh-launch cleanup. Marker must still be
    // there: this is the FP that the old unlink-on-read code produced.
    expect(classifyFromMarkers(tmp, MARKERS).endType).toBe('session-refresh');
    expect(existsSync(join(tmp, '.session-refresh'))).toBe(true);
  });

  it('marker older than the TTL → treated as stale: ignored AND lazy-unlinked', () => {
    const markerPath = join(tmp, '.restart-planned');
    writeFileSync(markerPath, 'stale planned restart', 'utf-8');
    // Simulate a marker whose first-heartbeat clear never fired (failed
    // start): classify with a "now" well past the 5-minute TTL.
    const farFuture = Date.now() + 10 * 60 * 1000;
    const r = classifyFromMarkers(tmp, MARKERS, farFuture);
    expect(r.endType).toBe('crash'); // stale marker must NOT mask a real crash
    expect(existsSync(markerPath)).toBe(false); // lazy-unlinked
  });

  it('first matching marker wins (precedence order preserved)', () => {
    writeFileSync(join(tmp, '.restart-planned'), 'planned', 'utf-8');
    writeFileSync(join(tmp, '.user-stop'), 'stopped', 'utf-8');
    expect(classifyFromMarkers(tmp, MARKERS).endType).toBe('planned-restart');
  });
});

describe('clearEndMarkers (via heartbeat)', () => {
  let tmp: string;
  const ALL = ['.restart-planned', '.session-refresh', '.user-restart', '.user-stop', '.daemon-stop'];

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'crashalert-clear-'));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('a post-grace heartbeat removes every pending end-type marker', () => {
    for (const f of ALL) writeFileSync(join(tmp, f), 'x', 'utf-8');
    // nowMs well past the grace window — the markers are no longer in-flight.
    clearEndMarkers(tmp, Date.now() + 10 * 60 * 1000);
    for (const f of ALL) expect(existsSync(join(tmp, f))).toBe(false);
  });

  it('leaves a fresh (within-grace) marker in place — an in-flight restart', () => {
    for (const f of ALL) writeFileSync(join(tmp, f), 'x', 'utf-8');
    // nowMs ≈ marker mtime → every marker is within the grace window.
    clearEndMarkers(tmp);
    for (const f of ALL) expect(existsSync(join(tmp, f))).toBe(true);
  });

  it('is a no-op when no markers are present', () => {
    expect(() => clearEndMarkers(tmp)).not.toThrow();
  });
});

describe('marker lifecycle (classify → clearEndMarkers → classify)', () => {
  let tmp: string;
  const MARKERS = [
    { file: '.restart-planned', type: 'planned-restart' },
    { file: '.session-refresh', type: 'session-refresh' },
    { file: '.user-restart', type: 'user-restart' },
    { file: '.user-stop', type: 'user-stop' },
  ];

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'crashalert-lifecycle-'));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('both restart firings classify, a post-grace heartbeat clears, then a real crash classifies as crash', () => {
    writeFileSync(join(tmp, '.restart-planned'), 'planned reboot', 'utf-8');
    // Firing #1 and #2 of the dying restart — both must see the marker.
    expect(classifyFromMarkers(tmp, MARKERS).endType).toBe('planned-restart');
    expect(classifyFromMarkers(tmp, MARKERS).endType).toBe('planned-restart');
    // Post-restart session heartbeats past the grace window → marker cleared.
    clearEndMarkers(tmp, Date.now() + 10 * 60 * 1000);
    expect(existsSync(join(tmp, '.restart-planned'))).toBe(false);
    // A genuine crash AFTER the clear must classify as crash — not be masked.
    expect(classifyFromMarkers(tmp, MARKERS).endType).toBe('crash');
  });

  it('a heartbeat DURING the in-flight restart (within grace) does NOT wipe the marker — firing#2 still classifies', () => {
    // This is the Finding-1 race: a fast-booting successor heartbeats before
    // the dying restart's second SessionEnd firing lands.
    writeFileSync(join(tmp, '.session-refresh'), 'rollover', 'utf-8');
    expect(classifyFromMarkers(tmp, MARKERS).endType).toBe('session-refresh'); // firing #1
    clearEndMarkers(tmp); // successor's first heartbeat — marker still within grace
    expect(existsSync(join(tmp, '.session-refresh'))).toBe(true);
    expect(classifyFromMarkers(tmp, MARKERS).endType).toBe('session-refresh'); // firing #2 — no false crash
  });
});
