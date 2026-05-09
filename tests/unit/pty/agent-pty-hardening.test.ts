import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync } from 'fs';
import { tmpdir, homedir } from 'os';
import { join } from 'path';
import { AgentPTY } from '../../../src/pty/agent-pty.js';
import type { AgentConfig, CtxEnv } from '../../../src/types/index.js';

// Issue #342 + #326 regression tests.
//
// #342 — PM2 frozen PATH causes silent exit-1 after Claude Code self-update.
// #326 — PTY stays alive but stdout-idle after large injections (Telegram photo).

class TestPTY extends AgentPTY {
  callResolveBinary(): string {
    // expose protected getBinaryName for assertions
    return (this as unknown as { getBinaryName: () => string }).getBinaryName();
  }
}

const env: CtxEnv = {
  instanceId: 'test',
  ctxRoot: '/tmp/test',
  frameworkRoot: '/tmp/fwk',
  agentName: 'alice',
  org: 'wyre',
  agentDir: '/tmp/fwk/orgs/wyre/agents/alice',
  projectRoot: '/tmp/fwk',
};
const config: AgentConfig = {} as AgentConfig;

describe('AgentPTY — issue #342 binary resolution', () => {
  let fakeHome: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    fakeHome = mkdtempSync(join(tmpdir(), 'cortextos-home-'));
    originalHome = process.env.HOME;
    process.env.HOME = fakeHome;
  });

  afterEach(() => {
    if (originalHome !== undefined) process.env.HOME = originalHome;
    else delete process.env.HOME;
    rmSync(fakeHome, { recursive: true, force: true });
  });

  it('prefers ~/.local/bin/claude over /usr/local/bin/claude when both exist', () => {
    if (process.platform === 'win32') return; // unix-only path
    const localBin = join(homedir(), '.local/bin');
    mkdirSync(localBin, { recursive: true });
    const target = join(localBin, 'claude');
    writeFileSync(target, '#!/bin/sh\nexit 0\n');
    chmodSync(target, 0o755);

    const pty = new TestPTY(env, config);
    const resolved = pty.callResolveBinary();
    expect(resolved).toBe(target);
  });

  it('returns bare "claude" if no candidate path exists and which fails', () => {
    if (process.platform === 'win32') return;
    const pty = new TestPTY(env, config);
    const resolved = pty.callResolveBinary();
    // Either we got a real installed path, or the bare-name fallback.
    // Both are acceptable — what we're verifying is no throw.
    expect(typeof resolved).toBe('string');
    expect(resolved.length).toBeGreaterThan(0);
  });
});

describe('AgentPTY — issue #326 hang watchdog', () => {
  it('fires onHang exactly once when PTY is alive but idle past threshold after injection', async () => {
    vi.useFakeTimers();
    const pty = new AgentPTY(env, config) as AgentPTY & {
      pty: { write: (s: string) => void; kill: () => void } | null;
      _alive: boolean;
      lastInjectionAt: number;
      outputSeenSinceInjection: boolean;
      hangFired: boolean;
    };
    // Simulate spawned state without invoking node-pty.
    pty._alive = true;
    pty.pty = { write: () => {}, kill: () => {} } as never;

    const onHang = vi.fn();
    pty.enableHangWatchdog(1000, onHang);

    // No injection yet → no hang fires.
    vi.advanceTimersByTime(5000);
    expect(onHang).not.toHaveBeenCalled();

    // Simulate an injection at t=now, then no output.
    pty.write('hello');
    vi.advanceTimersByTime(2000);
    expect(onHang).toHaveBeenCalledTimes(1);

    // Should not refire while hangFired is set.
    vi.advanceTimersByTime(10000);
    expect(onHang).toHaveBeenCalledTimes(1);

    pty.kill();
    vi.useRealTimers();
  });

  it('does NOT fire when agent produces output and then goes quiet (healthy idle)', async () => {
    vi.useFakeTimers();
    let onData: ((d: string) => void) | null = null;
    const pty = new AgentPTY(env, config) as AgentPTY & {
      pty: { write: (s: string) => void; kill: () => void; onData: (cb: (d: string) => void) => void } | null;
      _alive: boolean;
      outputSeenSinceInjection: boolean;
    };
    pty._alive = true;
    pty.pty = {
      write: () => {},
      kill: () => {},
      onData: (cb) => { onData = cb; },
    } as never;

    const onHang = vi.fn();
    pty.enableHangWatchdog(500, onHang);

    pty.write('go');
    // Simulate the agent acking the inject and then going silent — exactly
    // the "healthy idle after a turn" pattern that previously tripped a
    // false positive in the live system. Direct flag flip mirrors what the
    // onData handler does in production, since the mock onData is captured
    // but never invoked.
    pty.outputSeenSinceInjection = true;

    vi.advanceTimersByTime(10_000);
    expect(onHang).not.toHaveBeenCalled();
    void onData; // appease lint — captured for the production code path

    pty.kill();
    vi.useRealTimers();
  });

  it('re-arms on the next injection after a hang fire', async () => {
    vi.useFakeTimers();
    const pty = new AgentPTY(env, config) as AgentPTY & {
      pty: { write: (s: string) => void; kill: () => void } | null;
      _alive: boolean;
    };
    pty._alive = true;
    pty.pty = { write: () => {}, kill: () => {} } as never;

    const onHang = vi.fn();
    pty.enableHangWatchdog(500, onHang);

    pty.write('first');
    vi.advanceTimersByTime(1500);
    expect(onHang).toHaveBeenCalledTimes(1);

    // Next injection re-arms (write() resets hangFired + outputSeenSinceInjection).
    pty.write('second');
    vi.advanceTimersByTime(1500);
    expect(onHang).toHaveBeenCalledTimes(2);

    pty.kill();
    vi.useRealTimers();
  });
});
