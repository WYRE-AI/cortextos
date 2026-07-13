import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { resolveInstanceId, assertSingleDaemon, recordDaemonPid } from '../../../src/daemon/instance-guard';
import { processStartTimeMs } from '../../../src/utils/agent-pidfile';

// Topology guard (2026-07-13 two-daemon incident): the daemon read ONLY env
// CTX_INSTANCE_ID and treated `--instance` argv as decoration. ecosystem.config.js
// bakes the env from the CALLING shell at eval time, so a
// `pm2 start --update-env` from a default shell re-baked the gateway-named app
// onto instance 'default' — two daemons, one instance, duplicate fleet, bus
// double-delivery. These guards make that class of divergence a loud boot
// failure instead of a silent split-brain.

describe('resolveInstanceId — argv/env agreement guard', () => {
  it('argv and env agree → that instance id', () => {
    expect(resolveInstanceId(['node', 'daemon.js', '--instance', 'wyre-gateway'], { CTX_INSTANCE_ID: 'wyre-gateway' }))
      .toBe('wyre-gateway');
  });

  it('argv and env DISAGREE → throws loudly, naming both values (the --update-env re-bake class)', () => {
    expect(() =>
      resolveInstanceId(['node', 'daemon.js', '--instance', 'wyre-gateway'], { CTX_INSTANCE_ID: 'default' }),
    ).toThrowError(/wyre-gateway.*default|default.*wyre-gateway/);
  });

  it('argv only (no env) → argv wins', () => {
    expect(resolveInstanceId(['node', 'daemon.js', '--instance', 'acme'], {})).toBe('acme');
  });

  it('env only (no --instance argv) → env wins', () => {
    expect(resolveInstanceId(['node', 'daemon.js'], { CTX_INSTANCE_ID: 'acme' })).toBe('acme');
  });

  it('neither → default', () => {
    expect(resolveInstanceId(['node', 'daemon.js'], {})).toBe('default');
  });

  it('supports --instance=<id> form too', () => {
    expect(resolveInstanceId(['node', 'daemon.js', '--instance=acme'], {})).toBe('acme');
  });

  it('empty env string is treated as unset, not a mismatch', () => {
    expect(resolveInstanceId(['node', 'daemon.js', '--instance', 'acme'], { CTX_INSTANCE_ID: '' })).toBe('acme');
  });

  it('--instance with a missing value is treated as unset, not a crash', () => {
    expect(resolveInstanceId(['node', 'daemon.js', '--instance'], { CTX_INSTANCE_ID: 'acme' })).toBe('acme');
  });
});

describe('assertSingleDaemon — one live daemon per instance', () => {
  let ctxRoot: string;

  beforeEach(() => {
    ctxRoot = mkdtempSync(join(tmpdir(), 'instance-guard-'));
  });
  afterEach(() => {
    rmSync(ctxRoot, { recursive: true, force: true });
  });

  it('no daemon.pid → boots fine', () => {
    expect(() => assertSingleDaemon(ctxRoot, process.pid)).not.toThrow();
  });

  it('daemon.pid points at a DEAD pid → boots fine (stale file from a crash)', () => {
    // 2^22 exceeds every real macOS/Linux default pid_max we run on.
    writeFileSync(join(ctxRoot, 'daemon.pid'), '4194304', 'utf-8');
    expect(() => assertSingleDaemon(ctxRoot, process.pid)).not.toThrow();
  });

  it('daemon.pid points at a LIVE foreign pid with NO anchor (legacy file) → REFUSES to boot (fail-closed: cannot disprove ownership)', () => {
    // This test process itself is the "already-running daemon".
    writeFileSync(join(ctxRoot, 'daemon.pid'), String(process.pid), 'utf-8');
    expect(() => assertSingleDaemon(ctxRoot, process.pid + 1)).toThrowError(/already|running|live/i);
  });

  it('live foreign pid whose start time MATCHES the anchor → REFUSES (positively-confirmed second daemon)', () => {
    writeFileSync(join(ctxRoot, 'daemon.pid'), String(process.pid), 'utf-8');
    const realStart = processStartTimeMs(process.pid);
    expect(realStart).not.toBeNull(); // sanity: ps must work in this env for the pair below to mean anything
    writeFileSync(join(ctxRoot, 'daemon.start-time'), String(realStart), 'utf-8');
    expect(() => assertSingleDaemon(ctxRoot, process.pid + 1)).toThrowError(/already|running|live/i);
  });

  it('live foreign pid whose start time MISMATCHES the anchor → BOOTS (recycled pid after crash-then-long-gap — the false-refuse fix)', () => {
    writeFileSync(join(ctxRoot, 'daemon.pid'), String(process.pid), 'utf-8');
    const realStart = processStartTimeMs(process.pid);
    expect(realStart).not.toBeNull();
    // Anchor says the recorded daemon started a full day earlier than the live
    // process actually did → the pid was recycled; the old daemon is gone.
    writeFileSync(join(ctxRoot, 'daemon.start-time'), String(realStart! - 24 * 60 * 60_000), 'utf-8');
    expect(() => assertSingleDaemon(ctxRoot, process.pid + 1)).not.toThrow();
  });

  it('corrupt anchor file with a live pid → REFUSES (unknown anchor is fail-closed, same as no anchor)', () => {
    writeFileSync(join(ctxRoot, 'daemon.pid'), String(process.pid), 'utf-8');
    writeFileSync(join(ctxRoot, 'daemon.start-time'), 'garbage\n', 'utf-8');
    expect(() => assertSingleDaemon(ctxRoot, process.pid + 1)).toThrowError(/already|running|live/i);
  });

  it('recordDaemonPid writes the bare-int pidfile (operator-cattable, format unchanged) plus the start-time anchor', () => {
    recordDaemonPid(ctxRoot, process.pid);
    const pidRaw = readFileSync(join(ctxRoot, 'daemon.pid'), 'utf-8').trim();
    expect(parseInt(pidRaw, 10)).toBe(process.pid);
    const anchorRaw = readFileSync(join(ctxRoot, 'daemon.start-time'), 'utf-8').trim();
    const anchor = parseInt(anchorRaw, 10);
    const real = processStartTimeMs(process.pid);
    expect(real).not.toBeNull();
    expect(Math.abs(anchor - real!)).toBeLessThanOrEqual(5_000);
  });

  it('recordDaemonPid writes the ANCHOR FIRST, pid second (partial-write cell: a failed pid write must leave a fresh anchor + the OLD pid, never a fresh pid + a stale anchor — the inverted pairing would false-BOOT a third daemon past a live one)', () => {
    // Block the pid write only: daemon.pid as a DIRECTORY makes the final
    // rename/write throw, while the sibling anchor path stays writable.
    mkdirSync(join(ctxRoot, 'daemon.pid'));
    expect(() => recordDaemonPid(ctxRoot, process.pid)).toThrow();
    // Anchor landed BEFORE the pid attempt — fresh and durable.
    const anchorRaw = readFileSync(join(ctxRoot, 'daemon.start-time'), 'utf-8').trim();
    const real = processStartTimeMs(process.pid);
    expect(real).not.toBeNull();
    expect(Math.abs(parseInt(anchorRaw, 10) - real!)).toBeLessThanOrEqual(5_000);
  });

  it('daemon.pid pointing at OUR OWN pid → boots fine (idempotent same-process restart path)', () => {
    writeFileSync(join(ctxRoot, 'daemon.pid'), String(process.pid), 'utf-8');
    expect(() => assertSingleDaemon(ctxRoot, process.pid)).not.toThrow();
  });

  it('corrupt daemon.pid → boots fine (cannot positively confirm a live daemon)', () => {
    writeFileSync(join(ctxRoot, 'daemon.pid'), 'not-a-pid\n', 'utf-8');
    expect(() => assertSingleDaemon(ctxRoot, process.pid)).not.toThrow();
  });

  it('missing ctxRoot dir entirely → boots fine (first boot of a new instance)', () => {
    const fresh = join(ctxRoot, 'never-created');
    expect(() => assertSingleDaemon(fresh, process.pid)).not.toThrow();
  });
});
