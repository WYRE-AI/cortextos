import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { readBuildManifest } from '../../../src/daemon/index';

// task_1785551337187: build provenance so "what code is actually running"
// is a lookup (read dist/build-manifest.json) instead of a forensic
// reconstruction from OS process timestamps + git log correlation — see
// the 2026-08-01 daemon-restart reconciliation for the case that made this
// genuinely unresolvable without it.

function mkFrameworkRoot(): string {
  return mkdtempSync(join(tmpdir(), 'cortextos-build-manifest-'));
}

describe('readBuildManifest', () => {
  let frameworkRoot: string;

  beforeEach(() => { frameworkRoot = mkFrameworkRoot(); });
  afterEach(() => { rmSync(frameworkRoot, { recursive: true, force: true }); });

  it('returns null when dist/build-manifest.json does not exist', () => {
    expect(readBuildManifest(frameworkRoot)).toBeNull();
  });

  it('reads a valid manifest', () => {
    mkdirSync(join(frameworkRoot, 'dist'), { recursive: true });
    writeFileSync(
      join(frameworkRoot, 'dist', 'build-manifest.json'),
      JSON.stringify({ gitSha: 'abc1234', builtAt: '2026-08-02T00:00:00.000Z' }),
      'utf-8',
    );
    expect(readBuildManifest(frameworkRoot)).toEqual({
      gitSha: 'abc1234',
      builtAt: '2026-08-02T00:00:00.000Z',
    });
  });

  it('returns null on malformed JSON', () => {
    mkdirSync(join(frameworkRoot, 'dist'), { recursive: true });
    writeFileSync(join(frameworkRoot, 'dist', 'build-manifest.json'), '{not json', 'utf-8');
    expect(readBuildManifest(frameworkRoot)).toBeNull();
  });

  it('returns null when gitSha is missing', () => {
    mkdirSync(join(frameworkRoot, 'dist'), { recursive: true });
    writeFileSync(
      join(frameworkRoot, 'dist', 'build-manifest.json'),
      JSON.stringify({ builtAt: '2026-08-02T00:00:00.000Z' }),
      'utf-8',
    );
    expect(readBuildManifest(frameworkRoot)).toBeNull();
  });

  it('returns null when builtAt is missing', () => {
    mkdirSync(join(frameworkRoot, 'dist'), { recursive: true });
    writeFileSync(
      join(frameworkRoot, 'dist', 'build-manifest.json'),
      JSON.stringify({ gitSha: 'abc1234' }),
      'utf-8',
    );
    expect(readBuildManifest(frameworkRoot)).toBeNull();
  });

  it('returns null when fields have the wrong type', () => {
    mkdirSync(join(frameworkRoot, 'dist'), { recursive: true });
    writeFileSync(
      join(frameworkRoot, 'dist', 'build-manifest.json'),
      JSON.stringify({ gitSha: 12345, builtAt: '2026-08-02T00:00:00.000Z' }),
      'utf-8',
    );
    expect(readBuildManifest(frameworkRoot)).toBeNull();
  });
});
