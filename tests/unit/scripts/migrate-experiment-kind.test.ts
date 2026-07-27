/**
 * scripts/migrate-experiment-kind.ts must be idempotent, must only classify
 * `system_effectiveness` records as snapshots, and must never touch a record
 * that already has `kind` set. Recovery from a bad backfill across live
 * experiment history would be a per-agent restore, and a second real run
 * must be a no-op.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { runMigration } from '../../../scripts/migrate-experiment-kind';

describe('migrate-experiment-kind', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'mig-experiment-kind-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function seed(org: string, agent: string, id: string, record: Record<string, unknown>) {
    const dir = join(root, 'orgs', org, 'agents', agent, 'experiments', 'history');
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `${id}.json`);
    writeFileSync(path, JSON.stringify(record, null, 2) + '\n', 'utf-8');
    return path;
  }

  it('backfills kind=snapshot onto system_effectiveness records missing kind', () => {
    const path = seed('wyre', 'analyst', 'exp_1', { id: 'exp_1', agent: 'analyst', metric: 'system_effectiveness', decision: 'keep' });

    const { summary } = runMigration({ root, dryRun: false });
    expect(summary.addedSnapshot).toBe(1);
    expect(summary.addedIntervention).toBe(0);

    const record = JSON.parse(readFileSync(path, 'utf-8'));
    expect(record.kind).toBe('snapshot');
    expect(record.decision).toBe('keep');
  });

  it('backfills kind=intervention onto non-system_effectiveness records missing kind', () => {
    const path = seed('wyre', 'forge', 'exp_2', { id: 'exp_2', agent: 'forge', metric: 'vendor-parity-drift', decision: 'keep' });

    const { summary } = runMigration({ root, dryRun: false });
    expect(summary.addedIntervention).toBe(1);
    expect(summary.addedSnapshot).toBe(0);

    const record = JSON.parse(readFileSync(path, 'utf-8'));
    expect(record.kind).toBe('intervention');
  });

  it('is idempotent — second run is a no-op', () => {
    const path = seed('wyre', 'analyst', 'exp_1', { id: 'exp_1', metric: 'system_effectiveness' });

    const first = runMigration({ root, dryRun: false });
    expect(first.summary.addedSnapshot).toBe(1);
    const afterFirst = readFileSync(path, 'utf-8');

    const second = runMigration({ root, dryRun: false });
    expect(second.summary.addedSnapshot).toBe(0);
    expect(second.summary.alreadySet).toBe(1);
    expect(readFileSync(path, 'utf-8')).toBe(afterFirst);
  });

  it('never overwrites a record that already has kind set', () => {
    seed('wyre', 'analyst', 'exp_1', { id: 'exp_1', metric: 'system_effectiveness', kind: 'intervention' });

    const { results, summary } = runMigration({ root, dryRun: false });
    expect(summary.alreadySet).toBe(1);
    expect(results[0]?.before).toBe('intervention');
  });

  it('dry-run does not write anything to disk', () => {
    const path = seed('wyre', 'analyst', 'exp_1', { id: 'exp_1', metric: 'system_effectiveness' });
    const before = readFileSync(path, 'utf-8');

    const { summary } = runMigration({ root, dryRun: true });
    expect(summary.addedSnapshot).toBe(1);
    expect(readFileSync(path, 'utf-8')).toBe(before);
  });

  it('walks every org and every agent under orgs/*/agents/*/experiments/history', () => {
    seed('wyre', 'analyst', 'exp_1', { id: 'exp_1', metric: 'system_effectiveness' });
    seed('wyre', 'forge', 'exp_2', { id: 'exp_2', metric: 'vendor-parity-drift' });
    seed('wyre-gateway', 'analyst', 'exp_3', { id: 'exp_3', metric: 'system_effectiveness' });

    const { summary } = runMigration({ root, dryRun: true });
    expect(summary.total).toBe(3);
    expect(summary.addedSnapshot).toBe(2);
    expect(summary.addedIntervention).toBe(1);
  });

  it('skips unparseable JSON files without throwing', () => {
    const dir = join(root, 'orgs', 'wyre', 'agents', 'analyst', 'experiments', 'history');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'corrupt.json'), '{ not valid json', 'utf-8');

    const { summary } = runMigration({ root, dryRun: false });
    expect(summary.skipped).toBe(1);
    expect(summary.total).toBe(1);
  });
});
