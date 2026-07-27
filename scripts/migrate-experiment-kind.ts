/**
 * scripts/migrate-experiment-kind.ts
 *
 * One-shot migration that backfills the `kind` field onto pre-existing
 * `system_effectiveness` experiment records in every agent's
 * experiments/history/*.json. Those records were logged as recurring
 * qualitative health-scores through the create-experiment/evaluate-experiment
 * machinery, which implies a discrete tested intervention — they aren't one.
 * See deliverables/2026-07-27-experiment-scoring-honesty-proposal.md.
 *
 * Behavior:
 *   - Walk orgs/<org>/agents/<agent>/experiments/history/*.json
 *   - If `kind` is already set → leave the file alone (idempotent)
 *   - If `metric` is `system_effectiveness` and `kind` is missing → set
 *     `kind: "snapshot"`
 *   - Any other record missing `kind` → set `kind: "intervention"` (matches
 *     the backward-compat default used by createExperiment()/the CLI flag,
 *     so the migration is safe to run before or after the code deploys)
 *   - Never touches results.tsv — that's an append-only historical log.
 *
 * Usage:
 *   npx tsx scripts/migrate-experiment-kind.ts --dry-run   # preview diffs
 *   npx tsx scripts/migrate-experiment-kind.ts             # apply changes
 *   npx tsx scripts/migrate-experiment-kind.ts --root <path>   # custom root
 */
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'fs';
import { join } from 'path';

const SNAPSHOT_METRIC = 'system_effectiveness';

interface MigrationResult {
  path: string;
  org: string;
  agent: string;
  action: 'skip-already-set' | 'skip-not-json' | 'add-snapshot' | 'add-intervention';
  before?: string | undefined;
  after?: string;
}

interface MigrationOptions {
  root: string;
  dryRun: boolean;
}

export function findExperimentHistoryFiles(root: string): string[] {
  const orgsDir = join(root, 'orgs');
  if (!existsSync(orgsDir)) return [];

  const files: string[] = [];
  for (const orgEntry of readdirSync(orgsDir, { withFileTypes: true })) {
    if (!orgEntry.isDirectory()) continue;
    const agentsDir = join(orgsDir, orgEntry.name, 'agents');
    if (!existsSync(agentsDir)) continue;

    for (const agentEntry of readdirSync(agentsDir, { withFileTypes: true })) {
      if (!agentEntry.isDirectory()) continue;
      const historyDir = join(agentsDir, agentEntry.name, 'experiments', 'history');
      if (!existsSync(historyDir)) continue;

      for (const file of readdirSync(historyDir)) {
        if (file.endsWith('.json')) files.push(join(historyDir, file));
      }
    }
  }
  return files.sort();
}

export function migrateRecord(path: string, root: string): MigrationResult {
  const rel = path.startsWith(root) ? path.slice(root.length + 1) : path;
  const parts = rel.split('/');
  const org = parts[1] ?? '?';
  const agent = parts[3] ?? '?';

  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch {
    return { path, org, agent, action: 'skip-not-json' };
  }

  let record: Record<string, unknown>;
  try {
    record = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return { path, org, agent, action: 'skip-not-json' };
  }

  if ('kind' in record) {
    return { path, org, agent, action: 'skip-already-set', before: String(record.kind) };
  }

  const kind = record.metric === SNAPSHOT_METRIC ? 'snapshot' : 'intervention';
  const next = { ...record, kind };
  return {
    path,
    org,
    agent,
    action: kind === 'snapshot' ? 'add-snapshot' : 'add-intervention',
    after: JSON.stringify(next, null, 2) + '\n',
  };
}

export function runMigration(opts: MigrationOptions): {
  results: MigrationResult[];
  summary: { total: number; addedSnapshot: number; addedIntervention: number; alreadySet: number; skipped: number };
} {
  const files = findExperimentHistoryFiles(opts.root);
  const results: MigrationResult[] = [];

  for (const path of files) {
    const result = migrateRecord(path, opts.root);
    results.push(result);

    if ((result.action === 'add-snapshot' || result.action === 'add-intervention') && !opts.dryRun && result.after) {
      writeFileSync(path, result.after, 'utf-8');
    }
  }

  const summary = {
    total: results.length,
    addedSnapshot: results.filter(r => r.action === 'add-snapshot').length,
    addedIntervention: results.filter(r => r.action === 'add-intervention').length,
    alreadySet: results.filter(r => r.action === 'skip-already-set').length,
    skipped: results.filter(r => r.action === 'skip-not-json').length,
  };

  return { results, summary };
}

function formatResults(results: MigrationResult[], dryRun: boolean): string {
  const lines: string[] = [];
  lines.push(dryRun ? '=== DRY RUN — no files written ===' : '=== MIGRATION APPLIED ===');
  lines.push('');

  for (const r of results) {
    const prefix = `[${r.org}/${r.agent}]`;
    if (r.action === 'add-snapshot') {
      lines.push(`${prefix} ADD kind="snapshot"  ${r.path}`);
    } else if (r.action === 'add-intervention') {
      lines.push(`${prefix} ADD kind="intervention"  ${r.path}`);
    } else if (r.action === 'skip-already-set') {
      lines.push(`${prefix} SKIP (already set: kind="${r.before}")  ${r.path}`);
    } else {
      lines.push(`${prefix} SKIP (not parseable JSON)  ${r.path}`);
    }
  }
  return lines.join('\n');
}

const isMain = (() => {
  try {
    return Boolean(typeof require !== 'undefined' && require.main === module);
  } catch {
    return false;
  }
})();

if (isMain) {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes('--dry-run');
  const rootIdx = argv.indexOf('--root');
  const root = rootIdx >= 0 && argv[rootIdx + 1]
    ? argv[rootIdx + 1]
    : (process.env.CTX_FRAMEWORK_ROOT || process.cwd());

  const { results, summary } = runMigration({ root, dryRun });
  console.log(formatResults(results, dryRun));
  console.log('');
  console.log(`Total records scanned: ${summary.total}`);
  console.log(`Will add kind=snapshot:     ${summary.addedSnapshot}`);
  console.log(`Will add kind=intervention: ${summary.addedIntervention}`);
  console.log(`Already set:                ${summary.alreadySet}`);
  console.log(`Skipped (parse err):        ${summary.skipped}`);

  if (dryRun && (summary.addedSnapshot > 0 || summary.addedIntervention > 0)) {
    console.log('');
    console.log('Re-run without --dry-run to apply.');
  }
}
