import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { resolveInstanceId, assertSingleDaemon } from '../../../src/daemon/instance-guard';

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

  it('daemon.pid points at a LIVE foreign pid → REFUSES to boot (the second-daemon guard)', () => {
    // This test process itself is the "already-running daemon".
    writeFileSync(join(ctxRoot, 'daemon.pid'), String(process.pid), 'utf-8');
    expect(() => assertSingleDaemon(ctxRoot, process.pid + 1)).toThrowError(/already|running|live/i);
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
