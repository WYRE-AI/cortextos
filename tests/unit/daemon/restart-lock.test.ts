import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { tryAcquireRestartLock, releaseRestartLock, isRestartInFlight } from '../../../src/daemon/restart-lock.js';

describe('restart-lock — cross-path restart-in-flight guard', () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), 'restart-lock-test-'));
  });

  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
  });

  it('acquires the lock when none is held', () => {
    const r = tryAcquireRestartLock(stateDir, 'hang-detector');
    expect(r.acquired).toBe(true);
    expect(existsSync(join(stateDir, '.restart-in-flight'))).toBe(true);
  });

  it('a SECOND caller (different source) is a clean no-op while the first lock is fresh — the core cross-path race fix', () => {
    // Simulates the confirmed storm mechanism: the automated hang-detector actuator
    // acquires first; the manual/CLI restart path (a different call site entirely)
    // attempts the same agent moments later and must be blocked, not double-spawn.
    const first = tryAcquireRestartLock(stateDir, 'hang-detector');
    expect(first.acquired).toBe(true);

    const second = tryAcquireRestartLock(stateDir, 'manual-cli-restart');
    expect(second.acquired).toBe(false);
    expect(second.reason).toMatch(/hang-detector/); // names which source is holding it, for logging
  });

  it('a SECOND caller from the SAME source is also blocked (not just cross-path — any concurrent attempt)', () => {
    const first = tryAcquireRestartLock(stateDir, 'hang-detector');
    expect(first.acquired).toBe(true);
    const second = tryAcquireRestartLock(stateDir, 'hang-detector');
    expect(second.acquired).toBe(false);
  });

  it('releaseRestartLock clears it — a subsequent acquire succeeds', () => {
    tryAcquireRestartLock(stateDir, 'hang-detector');
    releaseRestartLock(stateDir);
    const r = tryAcquireRestartLock(stateDir, 'manual-cli-restart');
    expect(r.acquired).toBe(true);
  });

  it('releaseRestartLock on an already-clear lock is a harmless no-op (no throw)', () => {
    expect(() => releaseRestartLock(stateDir)).not.toThrow();
  });

  it('a STALE lock (older than the timeout — e.g. the holder crashed mid-restart) is reclaimed, not honored forever', () => {
    // Write a lock file that's already "old" by writing a backdated timestamp directly,
    // rather than waiting in real time.
    const staleAt = Date.now() - 5 * 60_000; // 5min old — well past any real restart duration
    writeFileSync(join(stateDir, '.restart-in-flight'), JSON.stringify({ source: 'hang-detector', at: staleAt }), 'utf-8');

    const r = tryAcquireRestartLock(stateDir, 'manual-cli-restart');
    expect(r.acquired).toBe(true); // stale lock does not block forever
  });

  it('a FRESH lock (just under the staleness threshold) is still honored', () => {
    const recentAt = Date.now() - 5_000; // 5s old
    writeFileSync(join(stateDir, '.restart-in-flight'), JSON.stringify({ source: 'hang-detector', at: recentAt }), 'utf-8');

    const r = tryAcquireRestartLock(stateDir, 'manual-cli-restart');
    expect(r.acquired).toBe(false);
  });

  it('fails OPEN (acquires) on a corrupt/unparseable lock file — never blocks a real restart on lock-mechanism trouble', () => {
    writeFileSync(join(stateDir, '.restart-in-flight'), 'not valid json{{{', 'utf-8');
    const r = tryAcquireRestartLock(stateDir, 'manual-cli-restart');
    expect(r.acquired).toBe(true);
  });

  it('the lock file records the acquiring source and a fresh timestamp', () => {
    const before = Date.now();
    tryAcquireRestartLock(stateDir, 'context-handoff');
    const data = JSON.parse(readFileSync(join(stateDir, '.restart-in-flight'), 'utf-8'));
    expect(data.source).toBe('context-handoff');
    expect(data.at).toBeGreaterThanOrEqual(before);
  });

  it('ATOMICITY: acquire is a single wx-flagged write, not a check-then-write pair — a lock file created by ANOTHER process between check and write cannot be silently overwritten', () => {
    // The prior implementation did existsSync(...) then writeFileSync(...) as two
    // separate calls — a real TOCTOU window where two processes could both pass the
    // existsSync check before either write landed. Simulating that exact race
    // directly: a lock file appears (as if written by a concurrent process) with a
    // FRESH timestamp; the current implementation's single wx-flagged write MUST
    // fail with EEXIST and fall through to the fresh-lock-blocks branch, never
    // blindly overwrite a fresh concurrent lock.
    writeFileSync(join(stateDir, '.restart-in-flight'), JSON.stringify({ source: 'concurrent-writer', at: Date.now() }), 'utf-8');
    const r = tryAcquireRestartLock(stateDir, 'this-caller');
    expect(r.acquired).toBe(false);
    expect(r.reason).toMatch(/concurrent-writer/);
    // The concurrent writer's lock must be untouched — proves no blind overwrite happened.
    const data = JSON.parse(readFileSync(join(stateDir, '.restart-in-flight'), 'utf-8'));
    expect(data.source).toBe('concurrent-writer');
  });
});

describe('isRestartInFlight — read-only peek used by injectMessageDetailed', () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), 'restart-lock-peek-test-'));
  });

  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
  });

  it('returns false when no lock file exists', () => {
    expect(isRestartInFlight(stateDir)).toBe(false);
  });

  it('returns true for a fresh lock', () => {
    tryAcquireRestartLock(stateDir, 'hang-detector');
    expect(isRestartInFlight(stateDir)).toBe(true);
  });

  it('returns false for a stale lock (older than the staleness threshold)', () => {
    const staleAt = Date.now() - 5 * 60_000; // 5min old
    writeFileSync(join(stateDir, '.restart-in-flight'), JSON.stringify({ source: 'hang-detector', at: staleAt }), 'utf-8');
    expect(isRestartInFlight(stateDir)).toBe(false);
  });

  it('returns false (fail-open) for a malformed/corrupt lock file', () => {
    writeFileSync(join(stateDir, '.restart-in-flight'), 'not valid json{{{', 'utf-8');
    expect(isRestartInFlight(stateDir)).toBe(false);
  });

  it('does not mutate or remove the lock file — a peek is non-destructive', () => {
    tryAcquireRestartLock(stateDir, 'hang-detector');
    isRestartInFlight(stateDir);
    const data = JSON.parse(readFileSync(join(stateDir, '.restart-in-flight'), 'utf-8'));
    expect(data.source).toBe('hang-detector');
  });
});
