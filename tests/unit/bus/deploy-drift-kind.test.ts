import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execSync } from 'child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { checkDeployDrift } from '../../../src/bus/system.js';

/**
 * `status` collapses both drifts into the word "drift", but they have OPPOSITE
 * remedies — pull drift means main has something the tree does not (benign),
 * build drift means dist has something main does not (dangerous). A consumer
 * that ACTS on the report must be able to tell them apart.
 *
 * These assert the DISTINCTION, not "never false-positives": a test asserting a
 * checker never fires passes on broken code and fails on a correct fix.
 */

let repo: string;

function git(cmd: string, cwd = repo) {
  return execSync(`git ${cmd}`, { cwd, encoding: 'utf-8', stdio: 'pipe' }).trim();
}

function stampManifest(gitSha: string | null, dirty = false) {
  mkdirSync(join(repo, 'dist'), { recursive: true });
  writeFileSync(
    join(repo, 'dist', 'build-manifest.json'),
    JSON.stringify({ gitSha, builtAt: '2026-08-15T00:00:00.000Z', dirty }),
  );
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'drift-kind-'));
  git('init -q -b main');
  git('config user.email t@t.t');
  git('config user.name t');
  writeFileSync(join(repo, 'f.txt'), 'one');
  git('add f.txt');
  git('commit -q -m one');
  // an "origin" so the pull-drift path has a remote to compare against
  git(`remote add origin ${repo}`);
  git('fetch -q origin 2>/dev/null || true');
});

afterEach(() => rmSync(repo, { recursive: true, force: true }));

describe('checkDeployDrift — drift_kind names WHICH drift', () => {
  it('reports no drift_kind when dist matches HEAD', () => {
    stampManifest(git('rev-parse HEAD'));
    const r = checkDeployDrift(repo);
    expect(r.build_drift?.stale).toBe(false);
    expect(r.drift_kind).toBeUndefined();
  });

  it('reports drift_kind "build" when dist is behind HEAD', () => {
    const old = git('rev-parse HEAD');
    writeFileSync(join(repo, 'f.txt'), 'two');
    git('commit -q -am two');
    stampManifest(old);
    const r = checkDeployDrift(repo);
    expect(r.drift_kind).toBe('build');
    expect(r.build_drift?.stale).toBe(true);
  });
});

describe('build drift — BEHIND vs DIVERGENT get different reasons', () => {
  it('an ANCESTOR build says "behind" and does not warn about discarding', () => {
    const old = git('rev-parse HEAD');
    writeFileSync(join(repo, 'f.txt'), 'two');
    git('commit -q -am two');
    stampManifest(old);
    const r = checkDeployDrift(repo);
    expect(r.build_drift?.reason).toMatch(/behind/i);
    expect(r.build_drift?.reason).not.toMatch(/not in this history/i);
  });

  it('a NON-ANCESTOR build warns that a rebuild would discard it', () => {
    // The 2026-08-15 shape: dist built while a side branch was checked out in
    // the shared tree, so dist carried code that was never on main.
    git('checkout -q -b side');
    writeFileSync(join(repo, 'f.txt'), 'side-only');
    git('commit -q -am side');
    const sideSha = git('rev-parse HEAD');
    git('checkout -q main');
    stampManifest(sideSha);

    const r = checkDeployDrift(repo);
    expect(r.drift_kind).toBe('build');
    expect(r.build_drift?.reason).toMatch(/NOT an ancestor/);
    expect(r.build_drift?.reason).toMatch(/discards it/);
  });

  it('DISCRIMINATES: the two cases produce different reasons', () => {
    // The whole point — a checker that fires on both but says the same thing
    // is the defect being fixed. Compare them directly rather than trusting
    // each assertion in isolation.
    const base = git('rev-parse HEAD');
    writeFileSync(join(repo, 'f.txt'), 'two');
    git('commit -q -am two');
    stampManifest(base);
    const behind = checkDeployDrift(repo).build_drift?.reason;

    git('checkout -q -b side2');
    writeFileSync(join(repo, 'g.txt'), 'x');
    git('add g.txt');
    git('commit -q -m side2');
    const sideSha = git('rev-parse HEAD');
    git('checkout -q main');
    stampManifest(sideSha);
    const divergent = checkDeployDrift(repo).build_drift?.reason;

    expect(behind).toBeTruthy();
    expect(divergent).toBeTruthy();
    expect(behind).not.toBe(divergent);
  });

  it('a non-SHA manifest value does not reach the shell and stays neutral', () => {
    stampManifest('$(touch /tmp/pwned)');
    const r = checkDeployDrift(repo);
    expect(r.build_drift?.stale).toBe(true);
    expect(r.build_drift?.reason).toMatch(/behind/i);
    expect(r.build_drift?.reason).not.toMatch(/NOT an ancestor/);
  });
});
