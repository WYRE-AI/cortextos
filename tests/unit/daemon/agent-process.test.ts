import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Capture the PTY exit handler so tests can simulate exits at controlled times
let capturedOnExit: ((exitCode: number, signal?: number) => void) | null = null;

const mockPty = {
  spawn: vi.fn().mockResolvedValue(undefined),
  kill: vi.fn(),
  write: vi.fn(),
  getPid: vi.fn().mockReturnValue(12345),
  isAlive: vi.fn().mockReturnValue(true),
  onExit: vi.fn().mockImplementation((cb: (exitCode: number, signal?: number) => void) => {
    capturedOnExit = cb;
  }),
};

// Getter defers the lookup until call time, so the hoisted vi.mock factory can
// reference ptyMocks (declared below) — same idiom as the fs mock further down.
vi.mock('../../../src/pty/agent-pty.js', () => ({
  AgentPTY: function AgentPTY() { return mockPty; },
  get isBinaryAvailable() { return ptyMocks.isBinaryAvailable; },
}));

const ptyMocks = {
  // Default true: the runtime is present, so every pre-existing test keeps
  // taking the ordinary crash path.
  isBinaryAvailable: vi.fn().mockReturnValue(true),
};

const mockInjectMessage = vi.fn();
vi.mock('../../../src/pty/inject.js', () => ({
  injectMessage: mockInjectMessage,
  MessageDedup: class { isDuplicate() { return false; } },
}));

vi.mock('../../../src/utils/atomic.js', () => ({
  ensureDir: vi.fn(),
  atomicWriteSync: vi.fn(),
}));

vi.mock('../../../src/utils/env.js', () => ({
  writeCortextosEnv: vi.fn(),
  resolveEnv: vi.fn().mockReturnValue({ instanceId: 'test', ctxRoot: '/tmp/test' }),
}));

vi.mock('../../../src/bus/reminders.js', () => ({
  getOverdueReminders: vi.fn().mockReturnValue([]),
}));

const pidfileMocks = {
  writeAgentPid: vi.fn(),
};

vi.mock('../../../src/utils/agent-pidfile.js', async () => {
  const actual = await vi.importActual<typeof import('../../../src/utils/agent-pidfile')>(
    '../../../src/utils/agent-pidfile',
  );
  return { ...actual, writeAgentPid: (...args: unknown[]) => pidfileMocks.writeAgentPid(...args) };
});

vi.mock('../../../src/utils/paths.js', () => ({
  resolvePaths: vi.fn().mockReturnValue({ stateDir: '/tmp/test-ctx/state/alice' }),
}));

const fsMocks = {
  existsSync: vi.fn().mockReturnValue(false),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  appendFileSync: vi.fn(),
  statSync: vi.fn(),
  unlinkSync: vi.fn(),
};

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  // Getter-based exposure of the fsMocks vi.fn()s. Two consumer patterns
  // need to coexist on this file:
  //   (1) `fsMocks.X.mockReset()` — used by the BUG-040 / restarts.log
  //       tests added by this patch
  //   (2) `vi.mocked(fs.X).mockImplementation(...)` — used by the
  //       verifyCronsAfterIdle tests + BUG-048 reschedule tests
  // For (2) to work, `fs.X` MUST resolve to the same vi.fn() instance as
  // `fsMocks.X`. Naive direct reference (`existsSync: fsMocks.existsSync`)
  // breaks because vi.mock factories are hoisted + executed BEFORE the
  // `const fsMocks = {...}` initializer — so the lookup captures
  // `undefined`. Arrow wrappers (`(...args) => fsMocks.X(...args)`) keep
  // (1) working but break (2) because `fs.X` is no longer a vi.fn — it's
  // a plain arrow function, and `vi.mocked()` does not recognize it as
  // mockable. Getters thread the needle: the lookup is deferred until
  // call time (after fsMocks is initialized), and the value returned IS
  // the underlying vi.fn so `vi.mocked()` recognizes it.
  return {
    ...actual,
    mkdirSync: vi.fn(),
    get existsSync() { return fsMocks.existsSync; },
    get readFileSync() { return fsMocks.readFileSync; },
    get writeFileSync() { return fsMocks.writeFileSync; },
    get appendFileSync() { return fsMocks.appendFileSync; },
    get statSync() { return fsMocks.statSync; },
    get unlinkSync() { return fsMocks.unlinkSync; },
  };
});

const { AgentProcess } = await import('../../../src/daemon/agent-process.js');

const mockEnv = {
  instanceId: 'test',
  ctxRoot: '/tmp/test-ctx',
  frameworkRoot: '/tmp/fw',
  agentName: 'alice',
  agentDir: '/tmp/fw/orgs/acme/agents/alice',
  org: 'acme',
  projectRoot: '/tmp/fw',
};

beforeEach(() => {
  capturedOnExit = null;
  mockPty.spawn.mockClear();
  mockPty.kill.mockClear();
  mockPty.write.mockClear();
  mockPty.isAlive.mockClear();
  mockPty.isAlive.mockReturnValue(true);
  mockPty.onExit.mockClear();
  mockInjectMessage.mockClear();
  fsMocks.existsSync.mockReset().mockReturnValue(false);
  fsMocks.readFileSync.mockReset();
  fsMocks.writeFileSync.mockReset();
  fsMocks.appendFileSync.mockReset();
  fsMocks.statSync.mockReset();
  fsMocks.unlinkSync.mockReset();
  ptyMocks.isBinaryAvailable.mockReset().mockReturnValue(true);
});

describe('AgentProcess — binary-unavailable exemption (2026-08-04 shared-binary incident)', () => {
  // Nine agents, nine private auto-updaters, ONE shared binary. Two updaters
  // raced and left ~/.local/bin/claude dangling at a deleted version for
  // ~12 minutes. node-pty returns a pid for a dangling symlink, then the child
  // exits 1 having written nothing — verified against the real thing:
  //   pid assigned: 69035 / exitCode: 1 signal: 0 / output bytes: 0
  // The daemon read that as an agent crash: boss burned 8 of its 10-crash
  // budget, analyst hit the cap and HALTED. A missing runtime is an
  // environmental condition and must never charge the agent's budget.

  it('does NOT count a crash when the binary is missing from PATH', async () => {
    ptyMocks.isBinaryAvailable.mockReturnValue(false);
    const ap = new AgentProcess('alice', mockEnv, {});
    await ap.start();

    // exit 1 with zero bytes written — the dangling-symlink signature.
    capturedOnExit!(1, 0);

    const [logPath, logLine] = fsMocks.appendFileSync.mock.calls[0];
    expect(String(logPath)).toContain('/logs/alice/restarts.log');
    expect(String(logLine)).toContain('BINARY_UNAVAILABLE_RECOVERY');
    expect(String(logLine)).toContain('(not counted toward max_crashes)');
    // The decisive assertion: .crash_count_today must be untouched. Writing it
    // is what marched boss to 8 and analyst into a HALT.
    const crashCountWrites = fsMocks.writeFileSync.mock.calls
      .filter(c => String(c[0]).endsWith('.crash_count_today'));
    expect(crashCountWrites).toHaveLength(0);
  });

  it('still counts an ordinary crash when the binary IS present (regression guard)', async () => {
    ptyMocks.isBinaryAvailable.mockReturnValue(true);
    const ap = new AgentProcess('alice', mockEnv, {});
    await ap.start();

    capturedOnExit!(1, 0);

    const [, logLine] = fsMocks.appendFileSync.mock.calls[0];
    expect(String(logLine)).toMatch(/\] CRASH: exit_code=1 crash_count=1/);
    expect(String(logLine)).not.toContain('BINARY_UNAVAILABLE_RECOVERY');
  });

  it('polls fast during a fresh outage, then backs off once it is clearly not an install', async () => {
    const ap = new AgentProcess('alice', mockEnv, {});
    const delayFor = () =>
      (ap as unknown as { binaryUnavailableRetryDelayMs(): number }).binaryUnavailableRetryDelayMs();
    const nowSpy = vi.spyOn(Date, 'now');

    // t=0 — outage begins. Fast tier: a real install window is minutes, and
    // 30s keeps downtime within a minute of the binary reappearing.
    nowSpy.mockReturnValue(1_000_000);
    expect(delayFor()).toBe(30_000);

    // t=+10min — still inside the fast window (the real outage was ~12min).
    nowSpy.mockReturnValue(1_000_000 + 10 * 60_000);
    expect(delayFor()).toBe(30_000);

    // t=+20min — past the fast window. No longer an in-flight install, so
    // slow down to bound restarts.log growth without ever giving up.
    nowSpy.mockReturnValue(1_000_000 + 20 * 60_000);
    expect(delayFor()).toBe(5 * 60_000);

    // A gap longer than the slow tier means the previous outage ended and the
    // agent recovered — a later failure is a NEW outage and starts fast again,
    // rather than inheriting the old one's backoff.
    nowSpy.mockReturnValue(1_000_000 + 20 * 60_000 + 60 * 60_000);
    expect(delayFor()).toBe(30_000);

    nowSpy.mockRestore();
  });

  it('does not exempt a clean exit(0) even while the binary is missing (narrowness guard)', async () => {
    // A missing binary explains exit 1 (exec failure), not a graceful exit 0.
    // Without the exit-code condition this branch would swallow unrelated
    // failures that merely coincide with an install window.
    ptyMocks.isBinaryAvailable.mockReturnValue(false);
    const ap = new AgentProcess('alice', mockEnv, {});
    await ap.start();

    capturedOnExit!(0, 0);

    const [, logLine] = fsMocks.appendFileSync.mock.calls[0];
    expect(String(logLine)).not.toContain('BINARY_UNAVAILABLE_RECOVERY');
  });
});

describe('AgentProcess — #19b restart-time marker (bootstrap-hang expected-beat anchor)', () => {
  it('writes .restart-time on every start() — fresh mode', async () => {
    const ap = new AgentProcess('alice', mockEnv, {});
    await ap.start();

    const call = fsMocks.writeFileSync.mock.calls.find(c => String(c[0]).endsWith('.restart-time'));
    expect(call).toBeDefined();
    expect(String(call![0])).toBe('/tmp/test-ctx/state/alice/.restart-time');
    // Content is a parseable ISO timestamp
    expect(Number.isNaN(new Date(String(call![1]).trim()).getTime())).toBe(false);
  });

  it('writes .restart-time on every start() — continue mode too (a --continue restart is still a restart)', async () => {
    fsMocks.existsSync.mockImplementation((p: string) => String(p).includes('.claude') || String(p).includes('projects'));
    const ap = new AgentProcess('alice', mockEnv, {});
    await ap.start();

    const call = fsMocks.writeFileSync.mock.calls.find(c => String(c[0]).endsWith('.restart-time'));
    expect(call).toBeDefined();
  });
});

describe('AgentProcess - BUG-011 fix (stop awaits PTY exit)', () => {
  it('stop() awaits the PTY exit handler before resolving', async () => {
    const ap = new AgentProcess('alice', mockEnv, {});
    await ap.start();
    expect(capturedOnExit).not.toBeNull();
    expect(ap.getStatus().status).toBe('running');

    let stopResolved = false;
    const stopPromise = ap.stop().then(() => { stopResolved = true; });

    // Give stop() a moment to enter its kill phase. The 4s of internal sleeps
    // (1s after Ctrl-C + 3s after /exit) plus the awaitExit will keep stop()
    // in flight. After 100ms, it should NOT have resolved.
    await new Promise(r => setTimeout(r, 100));
    expect(stopResolved).toBe(false);

    // Now simulate the PTY exit firing
    capturedOnExit!(0, 0);

    // After the exit fires, stop() should be able to resolve
    // (after its internal sleeps finish — wait long enough)
    await stopPromise;
    expect(stopResolved).toBe(true);
    expect(ap.getStatus().status).toBe('stopped');
  }, 10000);

  it('stop() does NOT trigger crash recovery on intentional stop (the BUG-011 regression)', async () => {
    const ap = new AgentProcess('alice', mockEnv, {});
    await ap.start();

    // Stop and have the exit fire DURING the await window
    const stopPromise = ap.stop();
    await new Promise(r => setTimeout(r, 100));
    capturedOnExit!(0, 0);
    await stopPromise;

    // The agent should be 'stopped', NOT 'crashed'.
    // Before the fix, the exit handler could fire after stopping=false and
    // call into the crash recovery branch, leaving status='crashed'.
    expect(ap.getStatus().status).toBe('stopped');
  }, 10000);

  it('handleExit DOES trigger crash recovery on UNINTENTIONAL exit (regression check)', async () => {
    // Make sure we didn't accidentally break the real crash recovery path
    const ap = new AgentProcess('alice', mockEnv, {});
    await ap.start();
    expect(ap.getStatus().status).toBe('running');

    // Fire the exit handler WITHOUT calling stop() first — simulates a real crash
    capturedOnExit!(1, 0);

    // The agent should be in 'crashed' state (crash recovery scheduled)
    expect(ap.getStatus().status).toBe('crashed');
  });

  it('unexpected PTY exit persists a CRASH line to restarts.log', async () => {
    // Default fs mocks: no .daemon-stop marker, no .crash_count_today file.
    const ap = new AgentProcess('alice', mockEnv, {});
    await ap.start();
    expect(ap.getStatus().status).toBe('running');

    // Fire exit handler WITHOUT calling stop() first — simulates a real crash.
    capturedOnExit!(1, 0);

    expect(ap.getStatus().status).toBe('crashed');
    // restarts.log must have received a CRASH entry with the exit code and
    // crash counter. Before the fix, daemon-classified crashes only wrote
    // to stdout and left restarts.log empty.
    expect(fsMocks.appendFileSync).toHaveBeenCalledTimes(1);
    const [logPath, logLine] = fsMocks.appendFileSync.mock.calls[0];
    expect(String(logPath)).toContain('/logs/alice/restarts.log');
    expect(String(logLine)).toMatch(/\] CRASH: exit_code=1 crash_count=1 backoff_s=5\b/);
    expect(String(logLine).endsWith('\n')).toBe(true);
  });

  it('PTY exit during daemon shutdown is NOT classified as a crash', async () => {
    // Simulate agent-manager.ts:stopAll() having written a fresh .daemon-stop
    // marker moments ago. handleExit should recognize the shutdown-in-progress
    // signal and bail out before touching the crash counter or restarts.log.
    fsMocks.existsSync.mockImplementation((p: any) => {
      const path = String(p);
      return path.endsWith('/state/alice/.daemon-stop');
    });
    fsMocks.statSync.mockImplementation((p: any) => ({ mtimeMs: Date.now() - 2_000 }));

    const ap = new AgentProcess('alice', mockEnv, {});
    await ap.start();
    expect(ap.getStatus().status).toBe('running');

    // PM2 SIGTERM propagated to the PTY's Claude Code child: it exits
    // cleanly with code 0 before its own stopAgent() call has a chance to
    // set stopRequested. Before the fix, this produced a phantom crash
    // and incremented .crash_count_today.
    capturedOnExit!(0, 0);

    // Agent state is 'running' still — handleExit returned early without
    // toggling status. No crash write, no log append, no restart scheduled.
    expect(ap.getStatus().status).toBe('running');
    expect(fsMocks.appendFileSync).not.toHaveBeenCalled();
    expect(fsMocks.writeFileSync).not.toHaveBeenCalledWith(
      expect.stringContaining('.crash_count_today'),
      expect.anything(),
      expect.anything(),
    );
  });

  it('stale .daemon-stop marker (>60s old) does NOT mask a real crash', async () => {
    // Regression guard: if a prior shutdown failed to clean up its marker,
    // we do NOT want it to silently swallow genuine crashes hours later.
    // The 60s window in isDaemonShuttingDown() is the load-bearing check.
    fsMocks.existsSync.mockImplementation((p: any) =>
      String(p).endsWith('/state/alice/.daemon-stop'),
    );
    fsMocks.statSync.mockImplementation((p: any) => ({ mtimeMs: Date.now() - 3_600_000 })); // 1h old

    const ap = new AgentProcess('alice', mockEnv, {});
    await ap.start();
    capturedOnExit!(1, 0);

    expect(ap.getStatus().status).toBe('crashed');
    expect(fsMocks.appendFileSync).toHaveBeenCalledTimes(1);
    expect(String(fsMocks.appendFileSync.mock.calls[0][1])).toMatch(/\] CRASH: /);
  });

  it('sessionRefresh() delegates to stop() then start() (in order)', async () => {
    const ap = new AgentProcess('alice', mockEnv, {});
    await ap.start();

    // Spy on stop and start so we can verify the delegation
    const stopSpy = vi.spyOn(ap, 'stop').mockResolvedValue();
    const startSpy = vi.spyOn(ap, 'start').mockResolvedValue();

    await ap.sessionRefresh();

    expect(stopSpy).toHaveBeenCalled();
    expect(startSpy).toHaveBeenCalled();
    // Verify call order: stop must complete before start
    const stopOrder = stopSpy.mock.invocationCallOrder[0];
    const startOrder = startSpy.mock.invocationCallOrder[0];
    expect(stopOrder).toBeLessThan(startOrder);
  });

  it('sessionRefresh() writes .session-refresh marker before stop (false-crash FP fix)', async () => {
    const ap = new AgentProcess('alice', mockEnv, {});
    await ap.start();

    const stopSpy = vi.spyOn(ap, 'stop').mockResolvedValue();
    vi.spyOn(ap, 'start').mockResolvedValue();
    fsMocks.writeFileSync.mockReset();

    await ap.sessionRefresh();

    const writeIdx = fsMocks.writeFileSync.mock.calls.findIndex(
      (call) => String(call[0]).endsWith('.session-refresh'),
    );
    expect(writeIdx).toBeGreaterThanOrEqual(0);
    expect(String(fsMocks.writeFileSync.mock.calls[writeIdx][0])).toBe('/tmp/test-ctx/state/alice/.session-refresh');
    // The marker must be written BEFORE stop() — a SessionEnd hook firing as
    // the PTY dies must already see the marker, or it classifies a false crash.
    const markerWriteOrder = fsMocks.writeFileSync.mock.invocationCallOrder[writeIdx];
    expect(markerWriteOrder).toBeLessThan(stopSpy.mock.invocationCallOrder[0]);
  });
});

describe('AgentProcess — organic rate-limit exit exemption (task_1785180731919)', () => {
  // tailStdoutLog()'s byte-level read uses require('fs').openSync/readSync,
  // which are NOT among the functions this file's `vi.mock('fs', ...)`
  // factory overrides — they pass through to the real fs. So exercising the
  // rate-limit-signature branch needs an actual file on disk at the exact
  // path tailStdoutLog computes. existsSync/statSync are mocked (per this
  // file's convention) but delegate to the REAL file's current state, so
  // they reflect growth as content is appended between start() and exit —
  // load-bearing for the lifecycle-offset tests below, which depend on
  // stdoutLogSizeAtStart being captured correctly at start() time and the
  // size growing afterward as the (simulated) session produces output.
  const logDir = '/tmp/test-ctx/logs/alice';
  const logPath = `${logDir}/stdout.log`;
  let realFs: typeof import('fs');

  beforeEach(async () => {
    realFs = await vi.importActual<typeof import('fs')>('fs');
    fsMocks.existsSync.mockImplementation((p: any) => String(p) === logPath && realFs.existsSync(logPath));
    fsMocks.statSync.mockImplementation((p: any) => {
      if (String(p) === logPath) return { size: realFs.statSync(logPath).size } as any;
      throw new Error('ENOENT');
    });
  });

  afterEach(() => {
    try {
      realFs.rmSync(logDir, { recursive: true, force: true });
    } catch { /* ignore */ }
  });

  // Content already on disk BEFORE this test's AgentProcess.start() runs —
  // simulates leftover output from a PREVIOUS lifecycle.
  function seedPreExistingLog(content: string) {
    realFs.mkdirSync(logDir, { recursive: true });
    if (content) realFs.writeFileSync(logPath, content, 'utf-8');
  }

  // Content appended AFTER start() — simulates output THIS lifecycle
  // actually produced, which is what stdoutLogSizeAtStart bounds against.
  function appendDuringLifecycle(content: string) {
    realFs.mkdirSync(logDir, { recursive: true });
    realFs.appendFileSync(logPath, content, 'utf-8');
  }

  it("an organic exit with a rate-limit error banner in this lifecycle's output is exempted from the crash counter and restarts", async () => {
    seedPreExistingLog('');
    const ap = new AgentProcess('alice', mockEnv, {});
    await ap.start();
    expect(ap.getStatus().status).toBe('running');

    appendDuringLifecycle('some prior turn output\nAPI Error: rate_limit_error: Number of request tokens has exceeded your per-minute rate limit\n');

    // No stop() call first — simulates Claude Code dying on its own.
    capturedOnExit!(1, 0);

    expect(ap.getStatus().status).toBe('crashed');
    expect(fsMocks.appendFileSync).toHaveBeenCalledTimes(1);
    const [restartsLogPath, logLine] = fsMocks.appendFileSync.mock.calls[0];
    expect(String(restartsLogPath)).toContain('/logs/alice/restarts.log');
    expect(String(logLine)).toMatch(
      /] RATE_LIMIT_RECOVERY: exit_code=1 backoff_s=5 \(not counted toward max_crashes\)/,
    );

    // The daily crash counter file must never have been touched.
    expect(fsMocks.writeFileSync).not.toHaveBeenCalledWith(
      expect.stringContaining('.crash_count_today'),
      expect.anything(),
      expect.anything(),
    );
  });

  it('does not arm .force-fresh — a rate limit does not poison the conversation', async () => {
    seedPreExistingLog('');
    const ap = new AgentProcess('alice', mockEnv, {});
    await ap.start();
    appendDuringLifecycle('API Error: overloaded_error: Overloaded\n');
    capturedOnExit!(1, 0);

    expect(fsMocks.writeFileSync).not.toHaveBeenCalledWith(
      expect.stringContaining('.force-fresh'),
      expect.anything(),
      expect.anything(),
    );
  });

  it('a genuine crash with no rate-limit signature in stdout still counts normally (no false exemption)', async () => {
    seedPreExistingLog('');
    const ap = new AgentProcess('alice', mockEnv, {});
    await ap.start();
    appendDuringLifecycle('TypeError: cannot read property of undefined\n    at somewhere.js:12\n');
    capturedOnExit!(1, 0);

    expect(ap.getStatus().status).toBe('crashed');
    expect(fsMocks.appendFileSync).toHaveBeenCalledTimes(1);
    const [, logLine] = fsMocks.appendFileSync.mock.calls[0];
    expect(String(logLine)).toMatch(/] CRASH: exit_code=1 crash_count=1 backoff_s=5\b/);
  });

  it('a STALE rate-limit banner (recovered earlier THIS lifecycle, then crashed for an unrelated reason) does NOT exempt the later crash', async () => {
    // Boss's first boundary concern: a rate-limit signature that appears
    // earlier in the captured tail — because Claude Code hit the limit,
    // retried, and recovered — must not blanket-exempt an unrelated crash
    // that happens afterward. Construct content where the banner is
    // present, but pushed outside the narrower RATE_LIMIT_EXIT_TAIL_BYTES
    // slice by enough intervening "normal" output, all still produced
    // within THIS lifecycle (after start()).
    seedPreExistingLog('');
    const ap = new AgentProcess('alice', mockEnv, {});
    await ap.start();

    const banner = 'API Error: rate_limit_error: Number of request tokens has exceeded your per-minute rate limit\n';
    const recoveredWorkOutput = 'x'.repeat(5000) + '\n'; // > RATE_LIMIT_EXIT_TAIL_BYTES (4096)
    const unrelatedCrashTail = 'TypeError: cannot read property of undefined\n    at somewhere.js:12\n';
    const content = banner + recoveredWorkOutput + unrelatedCrashTail;
    expect(content.length).toBeLessThan(16384); // still fully within tailStdoutLog's outer capture
    expect(content.length - banner.length).toBeGreaterThan(4096); // banner sits outside the inner slice
    appendDuringLifecycle(content);

    capturedOnExit!(1, 0);

    expect(ap.getStatus().status).toBe('crashed');
    expect(fsMocks.appendFileSync).toHaveBeenCalledTimes(1);
    const [, logLine] = fsMocks.appendFileSync.mock.calls[0];
    expect(String(logLine)).toMatch(/] CRASH: exit_code=1 crash_count=1 backoff_s=5\b/);
  });

  it('a rate-limit banner left over from a PREVIOUS lifecycle does NOT exempt a fast repeat crash in the new lifecycle (Codex P1)', async () => {
    // Codex's finding: stdout.log is append-only across restarts. Without
    // the lifecycle-offset bound, a fast repeat crash-loop (dies again
    // before writing much new output) would keep matching the SAME stale
    // banner from a PRIOR lifecycle indefinitely, evading max_crashes_per_day.
    seedPreExistingLog('API Error: rate_limit_error: hit the wall last lifecycle\n');

    const ap = new AgentProcess('alice', mockEnv, {});
    await ap.start(); // stdoutLogSizeAtStart now captures the pre-existing banner's byte offset

    // This lifecycle crashes again almost immediately, writing only a small
    // amount of genuinely-new, unrelated output — the stale banner from
    // before start() must not count.
    appendDuringLifecycle('segfault or similar unrelated failure\n');
    capturedOnExit!(1, 0);

    expect(ap.getStatus().status).toBe('crashed');
    expect(fsMocks.appendFileSync).toHaveBeenCalledTimes(1);
    const [, logLine] = fsMocks.appendFileSync.mock.calls[0];
    expect(String(logLine)).toMatch(/] CRASH: exit_code=1 crash_count=1 backoff_s=5\b/);
  });

  it('prose merely mentioning rate limits does NOT exempt an unrelated crash (Codex P1 — requires an actual API-error banner)', async () => {
    // Codex's second finding: the shared hasRateLimitSignature() predicate
    // matches plain phrases ("rate limit", "usage limit") that ordinary
    // task output — including this very codebase's own source/docs — can
    // legitimately contain. This call site requires a structured
    // API-error-shaped token instead, so ordinary prose must NOT exempt.
    seedPreExistingLog('');
    const ap = new AgentProcess('alice', mockEnv, {});
    await ap.start();
    appendDuringLifecycle(
      'Updated rate-limit-detector.ts to also match the weekly usage limit banner and quota exceeded errors.\n' +
      'TypeError: cannot read property of undefined\n    at somewhere.js:12\n',
    );
    capturedOnExit!(1, 0);

    expect(ap.getStatus().status).toBe('crashed');
    expect(fsMocks.appendFileSync).toHaveBeenCalledTimes(1);
    const [, logLine] = fsMocks.appendFileSync.mock.calls[0];
    expect(String(logLine)).toMatch(/] CRASH: exit_code=1 crash_count=1 backoff_s=5\b/);
  });

  it('a bare error-type token with no "API Error" context does NOT exempt an unrelated crash (Codex P2 round 5)', async () => {
    // Codex's round-5 finding: this codebase's OWN source and test files
    // legitimately contain the literal strings "overloaded_error" and
    // "rate_limit_error" (rate-limit-detector.ts, this very method's source,
    // hook-crash-alert tests). An agent that crashes for an unrelated
    // reason shortly after printing any of that — e.g. a grep/cat/diff of
    // those files — must not get misclassified as a rate-limit exemption
    // just because the bare token is present. Requires the same "API Error"
    // context marker detectImagePoisonCrash() already relies on.
    seedPreExistingLog('');
    const ap = new AgentProcess('alice', mockEnv, {});
    await ap.start();
    appendDuringLifecycle(
      "$ grep -n 'rate_limit_error' src/pty/rate-limit-detector.ts\n" +
      "19:    normalized.includes('rate_limit_error') ||\n" +
      'TypeError: cannot read property of undefined\n    at somewhere.js:12\n',
    );
    capturedOnExit!(1, 0);

    expect(ap.getStatus().status).toBe('crashed');
    expect(fsMocks.appendFileSync).toHaveBeenCalledTimes(1);
    const [, logLine] = fsMocks.appendFileSync.mock.calls[0];
    expect(String(logLine)).toMatch(/] CRASH: exit_code=1 crash_count=1 backoff_s=5\b/);
  });

  it("recognizes Claude Code's confirmed weekly-limit exit banner (Codex P1 round 2)", async () => {
    // Codex's round-2 finding: the narrowed predicate missed the PRIMARY
    // real-world organic-exit case — Claude Code's own confirmed CLI
    // banner, "You've hit your weekly limit for Claude." — verified
    // against tests/unit/pty/rate-limit-detector.test.ts and
    // tests/unit/daemon/fast-checker.test.ts (not a guess). Requiring only
    // raw API-error tokens would have made this exemption nearly useless
    // for the exact scenario that originally motivated rate-limit-detector.ts
    // (freeze#4: weekly-limit exhaustion).
    seedPreExistingLog('');
    const ap = new AgentProcess('alice', mockEnv, {});
    await ap.start();
    appendDuringLifecycle("You've hit your weekly limit for Claude.\n");
    capturedOnExit!(1, 0);

    expect(ap.getStatus().status).toBe('crashed');
    expect(fsMocks.appendFileSync).toHaveBeenCalledTimes(1);
    const [, logLine] = fsMocks.appendFileSync.mock.calls[0];
    expect(String(logLine)).toMatch(
      /] RATE_LIMIT_RECOVERY: exit_code=1 backoff_s=5 \(not counted toward max_crashes\)/,
    );
  });

  it('recognizes the percentage-warning variant ("You\'ve used N% of your ... limit")', async () => {
    seedPreExistingLog('');
    const ap = new AgentProcess('alice', mockEnv, {});
    await ap.start();
    appendDuringLifecycle("You've used 95% of your weekly limit.\n");
    capturedOnExit!(1, 0);

    expect(ap.getStatus().status).toBe('crashed');
    const [, logLine] = fsMocks.appendFileSync.mock.calls[0];
    expect(String(logLine)).toMatch(/] RATE_LIMIT_RECOVERY:/);
  });

  it('a stale PREVIOUS-lifecycle banner is excluded even when this lifecycle emits multibyte UTF-8 output (Codex P1 round 3)', async () => {
    // Codex's round-3 finding: an earlier version of this fix computed the
    // lifecycle-bound byte window separately, then did
    // `recentOutput.slice(-window)` on the already-UTF8-decoded string. JS
    // string indices are UTF-16 code units, not bytes — for multibyte
    // output (astral-plane emoji here: 4 bytes UTF-8, a 2-unit surrogate
    // pair in JS), a byte-count slice on the decoded string covers FEWER
    // bytes than intended, so `slice(-window)` can read all the way back
    // past this lifecycle's start and re-include a stale banner. This test
    // is sized to trigger that exact failure mode under the old logic (the
    // combined string's UTF-16 length is well under the 4096-byte window,
    // so the old `slice(-4096)` would return the ENTIRE string, banner
    // included) and proves the byte-precise tailStdoutLog() read doesn't.
    seedPreExistingLog('API Error: rate_limit_error: from a previous lifecycle\n');

    const ap = new AgentProcess('alice', mockEnv, {});
    await ap.start(); // stdoutLogSizeAtStart = the banner's exact byte length

    const multibyteOutput = '😀'.repeat(2000); // 8000 bytes UTF-8, 4000 UTF-16 units
    appendDuringLifecycle(multibyteOutput + '\nTypeError: unrelated failure\n');
    capturedOnExit!(1, 0);

    expect(ap.getStatus().status).toBe('crashed');
    expect(fsMocks.appendFileSync).toHaveBeenCalledTimes(1);
    const [, logLine] = fsMocks.appendFileSync.mock.calls[0];
    expect(String(logLine)).toMatch(/] CRASH: exit_code=1 crash_count=1 backoff_s=5\b/);
  });

  it('after stdout.log rotation, the new (smaller) file is read from byte 0 instead of being wrongly excluded (Codex P2)', async () => {
    // Codex's P2 finding: OutputBuffer.push() rotates stdout.log (renames
    // to .1, starts a fresh smaller file) once it crosses 50MB. If that
    // happens mid-lifecycle, the current file size can drop BELOW
    // stdoutLogSizeAtStart — treating that stale offset as a valid lower
    // bound would wrongly read nothing at all, missing a genuine rate-limit
    // banner written after rotation (safe-direction error: a real
    // exemption gets miscounted as an ordinary crash, not a bypass — but
    // still a real functional gap worth closing).
    seedPreExistingLog('x'.repeat(5000)); // pre-rotation content, sets stdoutLogSizeAtStart=5000
    const ap = new AgentProcess('alice', mockEnv, {});
    await ap.start();

    // Simulate rotation: the log is REPLACED by a fresh, much smaller file
    // (not appended to) — new size (42ish bytes) < stdoutLogSizeAtStart (5000).
    realFs.writeFileSync(logPath, "You've hit your weekly limit for Claude.\n", 'utf-8');
    capturedOnExit!(1, 0);

    expect(ap.getStatus().status).toBe('crashed');
    expect(fsMocks.appendFileSync).toHaveBeenCalledTimes(1);
    const [, logLine] = fsMocks.appendFileSync.mock.calls[0];
    expect(String(logLine)).toMatch(
      /] RATE_LIMIT_RECOVERY: exit_code=1 backoff_s=5 \(not counted toward max_crashes\)/,
    );
  });
});

describe('AgentProcess.sessionRefresh — cross-path restart-in-flight lock (2026-07-13, revised scope)', () => {
  // Analyst review found a 4th caller of sessionRefresh() that the original
  // per-actuator lock checks (fast-checker.ts's forceHangRestart/forceContextRestart,
  // agent-manager.ts's restartAgent) all missed: this class's OWN session-time-cap
  // rollover timer (scheduleCheck) calls this.sessionRefresh() directly. Confirmed
  // via the actual incident markers as the race that hit boss+forge. Gating HERE
  // instead is the single choke point that covers every caller by construction.

  it('acquires the restart-in-flight lock before stop()/start(), and releases it after both complete', async () => {
    const ap = new AgentProcess('alice', mockEnv, {});
    await ap.start();
    fsMocks.writeFileSync.mockClear();
    fsMocks.unlinkSync.mockClear();

    const stopSpy = vi.spyOn(ap, 'stop').mockResolvedValue();
    const startSpy = vi.spyOn(ap, 'start').mockResolvedValue();

    await ap.sessionRefresh();

    // Lock acquired: a wx-flagged write to .restart-in-flight, BEFORE stop().
    const lockWriteIdx = fsMocks.writeFileSync.mock.calls.findIndex(
      (call) => String(call[0]).endsWith('.restart-in-flight'),
    );
    expect(lockWriteIdx).toBeGreaterThanOrEqual(0);
    expect(String(fsMocks.writeFileSync.mock.calls[lockWriteIdx][0])).toBe('/tmp/test-ctx/state/alice/.restart-in-flight');
    expect(fsMocks.writeFileSync.mock.invocationCallOrder[lockWriteIdx]).toBeLessThan(stopSpy.mock.invocationCallOrder[0]);

    // Lock released: unlinkSync on the same path, AFTER start() completes.
    const unlinkCall = fsMocks.unlinkSync.mock.calls.find(c => String(c[0]).endsWith('.restart-in-flight'));
    expect(unlinkCall).toBeDefined();
    expect(fsMocks.unlinkSync.mock.invocationCallOrder[0]).toBeGreaterThan(startSpy.mock.invocationCallOrder[0]);
  });

  it('is a clean no-op (does NOT call stop()/start()) when the restart-in-flight lock is already held by another caller — the confirmed missed-4th-caller race', async () => {
    const ap = new AgentProcess('alice', mockEnv, {});
    await ap.start();

    const stopSpy = vi.spyOn(ap, 'stop').mockResolvedValue();
    const startSpy = vi.spyOn(ap, 'start').mockResolvedValue();

    // Simulate: some OTHER caller (fast-checker.ts's actuator, or another instance's
    // rollover timer) already holds the lock, fresh. writeFileSync's wx-flagged
    // acquire attempt must fail with EEXIST for the LOCK PATH specifically — other
    // paths (.restart-time, .session-refresh marker) must keep working normally.
    fsMocks.writeFileSync.mockImplementation((path: unknown) => {
      if (String(path).endsWith('.restart-in-flight')) {
        const err: NodeJS.ErrnoException = new Error('EEXIST: file already exists');
        err.code = 'EEXIST';
        throw err;
      }
      return undefined;
    });
    fsMocks.readFileSync.mockImplementation((path: unknown) => {
      if (String(path).endsWith('.restart-in-flight')) {
        return JSON.stringify({ source: 'hang-detector', at: Date.now() - 5_000 }); // fresh, 5s ago
      }
      return '';
    });

    await ap.sessionRefresh();

    expect(stopSpy).not.toHaveBeenCalled();
    expect(startSpy).not.toHaveBeenCalled();
  });

  it('proceeds normally (stop()+start() called) once a previously-held lock is stale (>2min, holder presumably crashed)', async () => {
    const ap = new AgentProcess('alice', mockEnv, {});
    await ap.start();

    const stopSpy = vi.spyOn(ap, 'stop').mockResolvedValue();
    const startSpy = vi.spyOn(ap, 'start').mockResolvedValue();

    fsMocks.writeFileSync.mockImplementationOnce((path: unknown) => {
      // First call (the wx-flagged acquire attempt for the lock) fails EEXIST once;
      // subsequent calls (the reclaim-write, the marker writes) succeed normally.
      if (String(path).endsWith('.restart-in-flight')) {
        const err: NodeJS.ErrnoException = new Error('EEXIST: file already exists');
        err.code = 'EEXIST';
        throw err;
      }
      return undefined;
    });
    fsMocks.readFileSync.mockImplementation((path: unknown) => {
      if (String(path).endsWith('.restart-in-flight')) {
        return JSON.stringify({ source: 'hang-detector', at: Date.now() - 5 * 60_000 }); // 5min ago — stale
      }
      return '';
    });

    await ap.sessionRefresh();

    expect(stopSpy).toHaveBeenCalled();
    expect(startSpy).toHaveBeenCalled();
  });
});

describe('AgentProcess - BUG-048 fix (session timer re-reads config)', () => {
  it('fires sessionRefresh when config on disk still matches original short duration', async () => {
    const refreshSpy = vi.fn().mockResolvedValue(undefined);

    vi.useFakeTimers();
    try {
      const ap = new AgentProcess('alice', mockEnv, { max_session_seconds: 1 });
      vi.spyOn(ap, 'sessionRefresh').mockImplementation(refreshSpy);
      await ap.start();
      await vi.advanceTimersByTimeAsync(2000);
    } finally {
      vi.useRealTimers();
    }

    expect(refreshSpy).toHaveBeenCalledOnce();
  });

  it('reschedules when config.json on disk has a longer max_session_seconds', async () => {
    const fs = await import('fs');
    const mockExistsSync = vi.mocked(fs.existsSync);
    const mockReadFileSync = vi.mocked(fs.readFileSync);

    const refreshSpy = vi.fn().mockResolvedValue(undefined);

    // Config on disk says 1 hour — much longer than initial 1s
    mockExistsSync.mockImplementation((p: unknown) =>
      typeof p === 'string' && p.endsWith('config.json'),
    );
    mockReadFileSync.mockImplementation((p: unknown) => {
      if (typeof p === 'string' && p.endsWith('config.json')) {
        return JSON.stringify({ max_session_seconds: 3600 });
      }
      return '';
    });

    vi.useFakeTimers();
    try {
      const ap = new AgentProcess('alice', mockEnv, { max_session_seconds: 1 });
      vi.spyOn(ap, 'sessionRefresh').mockImplementation(refreshSpy);
      await ap.start();
      // Advance past the initial 1s timer — should reschedule, not fire refresh
      await vi.advanceTimersByTimeAsync(2000);
    } finally {
      vi.useRealTimers();
      mockExistsSync.mockReturnValue(false);
      mockReadFileSync.mockReset();
    }

    // sessionRefresh must NOT have been called — config said 1h, not 1s
    expect(refreshSpy).not.toHaveBeenCalled();
  });

  it('does not loop when max_session_seconds overflows int32 setTimeout (regression)', async () => {
    // Without the clamp, max_session_seconds: 3600000 (1000h = 3.6T ms) would
    // exceed Node's int32 setTimeout max (~2.147B ms), get coerced to 1ms,
    // fire immediately, re-read the same overflow value, reschedule, and loop
    // tightly — locking the daemon. Clamp at the call site prevents this.
    const fs = await import('fs');
    const mockExistsSync = vi.mocked(fs.existsSync);
    const mockReadFileSync = vi.mocked(fs.readFileSync);

    const refreshSpy = vi.fn().mockResolvedValue(undefined);
    const logSpy = vi.fn();

    mockExistsSync.mockImplementation((p: unknown) =>
      typeof p === 'string' && p.endsWith('config.json'),
    );
    mockReadFileSync.mockImplementation((p: unknown) => {
      if (typeof p === 'string' && p.endsWith('config.json')) {
        return JSON.stringify({ max_session_seconds: 3_600_000 });
      }
      return '';
    });

    vi.useFakeTimers();
    try {
      const ap = new AgentProcess('alice', mockEnv, { max_session_seconds: 3_600_000 });
      vi.spyOn(ap, 'sessionRefresh').mockImplementation(refreshSpy);
      vi.spyOn(ap as unknown as { log: (m: string) => void }, 'log').mockImplementation(logSpy);
      await ap.start();
      // Advance past the int32 setTimeout cap. Without clamp this would log
      // thousands of "rescheduling" lines as the 1ms-coerced timer keeps firing.
      await vi.advanceTimersByTimeAsync(5000);
    } finally {
      vi.useRealTimers();
      mockExistsSync.mockReturnValue(false);
      mockReadFileSync.mockReset();
    }

    const rescheduleCount = logSpy.mock.calls.filter(
      ([msg]) => typeof msg === 'string' && msg.includes('rescheduling'),
    ).length;
    expect(rescheduleCount).toBeLessThan(5);
    expect(refreshSpy).not.toHaveBeenCalled();
  });
});

describe('AgentProcess — CrashLoopPauser (instar-inspired sliding window)', () => {
  it('triggers CRASH_LOOP halt when crash_window fills', async () => {
    const ap = new AgentProcess('alice', mockEnv, {
      crash_window: { seconds: 60, max_crashes: 3 },
    });
    await ap.start();

    // Fire 3 crashes in rapid succession (well within the 60s window).
    capturedOnExit!(1, 0);
    expect(ap.getStatus().status).toBe('crashed'); // first crash — normal recovery

    // Reset mocks and simulate the restart + second crash
    mockPty.spawn.mockClear();
    mockPty.onExit.mockClear();
    capturedOnExit = null;
    await ap.start();
    capturedOnExit!(1, 0);
    expect(ap.getStatus().status).toBe('crashed'); // second crash — still normal

    mockPty.spawn.mockClear();
    mockPty.onExit.mockClear();
    capturedOnExit = null;
    await ap.start();
    capturedOnExit!(1, 0);
    // Third crash in window → CRASH_LOOP → halted
    expect(ap.getStatus().status).toBe('halted');
  });

  it('does not trigger CRASH_LOOP when no crash_window is configured (backward compat)', async () => {
    const ap = new AgentProcess('alice', mockEnv, {
      max_crashes_per_day: 5,
    });
    await ap.start();

    // 3 crashes — without crash_window, these are just normal crash recovery
    for (let i = 0; i < 3; i++) {
      capturedOnExit!(1, 0);
      if (ap.getStatus().status !== 'halted') {
        mockPty.spawn.mockClear();
        mockPty.onExit.mockClear();
        capturedOnExit = null;
        await ap.start();
      }
    }
    // Should be 'crashed' (recovering), NOT 'halted', because daily max is 5
    expect(ap.getStatus().status).not.toBe('halted');
  });
});

describe('AgentProcess - onboarding marker (do not auto-write .onboarded on heartbeat)', () => {
  // Regression: buildStartupPrompt used to auto-write the .onboarded marker
  // whenever a heartbeat.json existed, on the assumption the agent had
  // onboarded and just forgot the marker. That silently suppressed FIRST BOOT
  // for agents that were manually scaffolded (heartbeat present) but never
  // actually ran onboarding. The marker must be explicit: a heartbeat alone
  // must NOT mark an agent onboarded. This is general daemon behavior (it was
  // surfaced via a manually-scaffolded opencode agent, but applies to any
  // runtime).
  it('does not auto-mark a heartbeat-only agent as onboarded (still routes to FIRST BOOT)', async () => {
    fsMocks.existsSync.mockImplementation((path: string) => {
      if (path.endsWith('/.force-fresh')) return false;
      if (path.endsWith('/.onboarded')) return false;
      if (path.endsWith('/heartbeat.json')) return true;
      if (path.endsWith('/ONBOARDING.md')) return true;
      return false;
    });

    const ap = new AgentProcess('alice', mockEnv, {});
    await ap.start();

    const prompt = mockPty.spawn.mock.calls[0]?.[1] ?? '';
    expect(prompt).toContain('FIRST BOOT');
    expect(prompt).toContain('read ONBOARDING.md and complete the onboarding protocol');
    // The buggy auto-write must be gone: no .onboarded written from heartbeat presence.
    expect(fsMocks.writeFileSync).not.toHaveBeenCalledWith(
      expect.stringContaining('/.onboarded'),
      expect.anything(),
      expect.anything(),
    );
  });

  it('respects an existing .onboarded marker (suppresses FIRST BOOT)', async () => {
    fsMocks.existsSync.mockImplementation((path: string) => {
      if (path.endsWith('/.force-fresh')) return false;
      if (path.endsWith('/.onboarded')) return true;
      if (path.endsWith('/heartbeat.json')) return true;
      if (path.endsWith('/ONBOARDING.md')) return true;
      return false;
    });

    const ap = new AgentProcess('alice', mockEnv, {});
    await ap.start();

    const prompt = mockPty.spawn.mock.calls[0]?.[1] ?? '';
    expect(prompt).not.toContain('FIRST BOOT');
    expect(prompt).not.toContain('complete the onboarding protocol');
  });
});

describe('AgentProcess.injectMessageDetailed — RESTARTING code (bus-message silent-drop race fix)', () => {
  it('returns RESTARTING (not NOT_RUNNING, and does not write to the PTY) when a restart lock is held for this agent, even though status is still "running"', async () => {
    const ap = new AgentProcess('alice', mockEnv, {});
    await ap.start();
    expect(ap.getStatus().status).toBe('running');

    // Simulate the exact race this fix closes: sessionRefresh() has acquired the
    // restart-in-flight lock but stop()'s PTY teardown hasn't run yet — status is
    // still 'running' and this.pty is still set, so the pre-existing NOT_RUNNING
    // check alone would not catch this window.
    fsMocks.readFileSync.mockImplementation((path: unknown) => {
      if (String(path).endsWith('.restart-in-flight')) {
        return JSON.stringify({ source: 'hang-detector', at: Date.now() - 5_000 }); // fresh
      }
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });

    const result = ap.injectMessageDetailed('hello');

    expect(result).toEqual({
      ok: false,
      code: 'RESTARTING',
      message: expect.stringContaining('restart in flight'),
    });
    expect(mockPty.write).not.toHaveBeenCalled();
  });

  it('returns ok:true and writes to the PTY when no restart lock is held', async () => {
    const ap = new AgentProcess('alice', mockEnv, {});
    await ap.start();

    fsMocks.readFileSync.mockImplementation(() => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); // no lock file
    });

    const result = ap.injectMessageDetailed('hello');

    expect(result).toEqual({ ok: true });
  });

  it('still returns NOT_RUNNING when the agent is not running, regardless of lock state', async () => {
    const ap = new AgentProcess('alice', mockEnv, {});
    // Never started — this.pty is unset, this.status is not 'running'.

    const result = ap.injectMessageDetailed('hello');

    expect(result.ok).toBe(false);
    expect((result as { code: string }).code).toBe('NOT_RUNNING');
  });
});

describe('AgentProcess — pid record written at the start() choke point', () => {
  beforeEach(() => {
    pidfileMocks.writeAgentPid.mockClear();
  });

  it('start() records the live PTY pid', async () => {
    const ap = new AgentProcess('alice', mockEnv, {});
    await ap.start();

    expect(pidfileMocks.writeAgentPid).toHaveBeenCalledTimes(1);
    const [stateDir, agentName, pid, daemonPid] = pidfileMocks.writeAgentPid.mock.calls[0];
    expect(stateDir).toBe('/tmp/test-ctx/state/alice');
    expect(agentName).toBe('alice');
    expect(pid).toBe(12345);          // mockPty.getPid()
    expect(daemonPid).toBe(process.pid);
  });

  it('REGRESSION: a SELF-RESTART re-records the pid, so the record cannot go stale', async () => {
    // The defect this fixes. writeAgentPid used to live in AgentManager, at
    // the ONE caller that spawns an agent from outside. The four restart
    // paths inside AgentProcess (image-poison, rate-limit, generic, and the
    // session-refresh at :380) all call this.start() directly and wrote no
    // pid — so after any self-restart the record still named the pid of a
    // process that no longer exists. Notably :881 is the RATE-LIMIT restart,
    // so records went stale during exactly the incidents where liveness
    // matters most.
    const ap = new AgentProcess('alice', mockEnv, {});
    await ap.start();
    expect(pidfileMocks.writeAgentPid).toHaveBeenCalledTimes(1);
    expect(pidfileMocks.writeAgentPid.mock.calls[0][2]).toBe(12345);

    // Drive the real restart shape: start() early-returns while status is
    // 'running', so a self-restart necessarily goes through a PTY exit first.
    capturedOnExit!(1);
    // The PTY comes back with a different pid, as a real respawn would.
    mockPty.getPid.mockReturnValue(67890);
    await ap.start();

    const calls = pidfileMocks.writeAgentPid.mock.calls;
    expect(calls.length).toBeGreaterThanOrEqual(2);
    // Pre-fix the record would still name 12345 — a process that is gone.
    expect(calls[calls.length - 1][2]).toBe(67890);
    mockPty.getPid.mockReturnValue(12345);
  });

  it('a failed spawn records NO pid — an absent record beats one naming a process that never ran', async () => {
    mockPty.spawn.mockRejectedValueOnce(new Error('boom'));
    const ap = new AgentProcess('alice', mockEnv, {});
    await ap.start();

    expect(ap.getStatus().status).toBe('crashed');
    expect(pidfileMocks.writeAgentPid).not.toHaveBeenCalled();
  });

  it('a pidfile write failure never breaks the spawn', async () => {
    pidfileMocks.writeAgentPid.mockImplementationOnce(() => { throw new Error('disk full'); });
    const ap = new AgentProcess('alice', mockEnv, {});
    await expect(ap.start()).resolves.toBeUndefined();
    expect(ap.getStatus().status).toBe('running');
  });
});
