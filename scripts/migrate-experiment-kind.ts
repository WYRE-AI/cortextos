/**
 * scripts/migrate-experiment-kind.ts
 *
 * One-shot migration that backfills `kind: "snapshot"` onto analyst's
 * pre-existing `system_effectiveness` experiment records. Those records were
 * logged as recurring qualitative health-scores through the
 * create-experiment/evaluate-experiment machinery, which implies a discrete
 * tested intervention — they aren't one.
 * See deliverables/2026-07-27-experiment-scoring-honesty-proposal.md.
 *
 * Scope is deliberately narrow, per spec: only wyre/analyst's own
 * system_effectiveness records are known to be misclassified today. Every
 * other record — a same-named agent in a different org, a different agent,
 * or any other metric of analyst's — is left untouched; its `kind` stays
 * implicitly `intervention` via the code-side default (createExperiment()'s
 * default, the dashboard's `?? 'intervention'` fallback), not written
 * explicitly here. If this same recurring-health-score pattern turns up for
 * another agent later, that's a separate, reviewed decision — not something
 * this migration should silently extend to.
 *
 * Behavior:
 *   - Walk orgs/<org>/agents/<agent>/experiments/history/*.json
 *   - If `kind` is already set → leave the file alone (idempotent)
 *   - If org is `wyre`, agent is `analyst`, `metric` is `system_effectiveness`,
 *     and `kind` is missing → set `kind: "snapshot"`
 *   - Everything else missing `kind` → left alone, not applicable
 *   - Never touches results.tsv — that's an append-only historical log.
 *
 * Usage:
 *   npx tsx scripts/migrate-experiment-kind.ts --dry-run   # preview diffs
 *   npx tsx scripts/migrate-experiment-kind.ts             # apply changes
 *   npx tsx scripts/migrate-experiment-kind.ts --root <path>   # custom root
 */
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'fs';
import { join } from 'path';

// Scoped to the exact agent instance the finding was grounded against — a
// same-named "analyst" in another org is a different agent, not covered by
// this backfill.
const SNAPSHOT_ORG = 'wyre';
const SNAPSHOT_AGENT = 'analyst';
const SNAPSHOT_METRIC = 'system_effectiveness';

interface MigrationResult {
  path: string;
  org: string;
  agent: string;
  action: 'skip-already-set' | 'skip-not-json' | 'skip-not-applicable' | 'add-snapshot';
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

  if (org !== SNAPSHOT_ORG || agent !== SNAPSHOT_AGENT || record.metric !== SNAPSHOT_METRIC) {
    return { path, org, agent, action: 'skip-not-applicable' };
  }

  const next = { ...record, kind: 'snapshot' };
  return {
    path,
    org,
    agent,
    action: 'add-snapshot',
    after: JSON.stringify(next, null, 2) + '\n',
  };
}

export function runMigration(opts: MigrationOptions): {
  results: MigrationResult[];
  summary: { total: number; addedSnapshot: number; alreadySet: number; notApplicable: number; skipped: number };
} {
  const files = findExperimentHistoryFiles(opts.root);
  const results: MigrationResult[] = [];

  for (const path of files) {
    const result = migrateRecord(path, opts.root);
    results.push(result);

    if (result.action === 'add-snapshot' && !opts.dryRun && result.after) {
      writeFileSync(path, result.after, 'utf-8');
    }
  }

  const summary = {
    total: results.length,
    addedSnapshot: results.filter(r => r.action === 'add-snapshot').length,
    alreadySet: results.filter(r => r.action === 'skip-already-set').length,
    notApplicable: results.filter(r => r.action === 'skip-not-applicable').length,
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
    } else if (r.action === 'skip-already-set') {
      lines.push(`${prefix} SKIP (already set: kind="${r.before}")  ${r.path}`);
    } else if (r.action === 'skip-not-applicable') {
      lines.push(`${prefix} SKIP (not analyst/system_effectiveness)  ${r.path}`);
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
  console.log(`Will add kind=snapshot: ${summary.addedSnapshot}`);
  console.log(`Already set:            ${summary.alreadySet}`);
  console.log(`Not applicable:         ${summary.notApplicable}`);
  console.log(`Skipped (parse err):    ${summary.skipped}`);

  if (dryRun && summary.addedSnapshot > 0) {
    console.log('');
    console.log('Re-run without --dry-run to apply.');
  }
}
