/**
 * scripts/agent-doc-drift.ts
 *
 * Diff-and-flag tool: compares each deployed agent's bootstrap docs against
 * templates/agent/, the live source add-agent.ts copies from at creation
 * time. Read-only — reports drift, never writes.
 *
 * Scope, and why it's this narrow (see the writeup this script implements):
 *   - Compares deployed agents against templates/agent/ ONLY.
 *   - Does NOT compare against community/agents/agent/ (the public catalog
 *     install source, consumed by `install-community-item`) — that tree
 *     serves a different, external audience and has its own, separate,
 *     not-yet-answered correctness question. Comparing the two trees to
 *     each other would flag permitted differences as drift and train
 *     everyone to ignore the tool (the standing-red problem).
 *   - Direction is per-LINE, not per-file, and not even per-surface: a
 *     single file can simultaneously be ahead of the template on one line
 *     and behind it on another (observed live: an agent's own AGENTS.md
 *     was ahead on a path fix and behind on a KB-collection-model
 *     rewrite, at the same time). This tool reports WHAT differs; it does
 *     not — cannot — decide which side is correct. A human resolves each
 *     diff.
 *
 * Four file categories, each with a genuinely different check shape, and
 * each check labels itself in the OUTPUT (not just in this docstring) as
 * either EQUALITY-based or PROPERTY-based, per the explicit requirement
 * that a reader must be able to tell the difference from the report alone:
 *
 *   FRAMEWORK   — expected near-identical to template. EQUALITY-based:
 *                 reports every line present in one side and absent from
 *                 the other, with no verdict on which side is right.
 *   HYBRID      — template content should be a SUBSET of deployed; agents
 *                 legitimately extend these (e.g. GUARDRAILS.md rows added
 *                 per-agent over time). PROPERTY-based: for each non-blank
 *                 template line, checks it's present somewhere in the
 *                 deployed file (order-independent). Only reports MISSING
 *                 template lines — deployed-only additions are the whole
 *                 point of this category and are never flagged.
 *   PLACEHOLDER — template has literal {{...}} markers or is otherwise
 *                 meant to be instantiated once at creation, never synced
 *                 back. NOT compared for content at all (comparing would
 *                 report 100% drift on files that are perfectly correct,
 *                 and the natural response is to widen an ignore list
 *                 until the tool detects nothing and still reports clean
 *                 — see the standing-red family this guards against).
 *                 Only existence is checked.
 *   AGENT-OWNED — fully agent-specific by design (identity, goals, memory,
 *                 learned user preferences). Not compared at all.
 *
 * Every category, EVERY RUN, reports its population and count even when
 * clean — a clean report that doesn't name what it examined is
 * indistinguishable from one that examined nothing (same requirement as
 * the review-standard Gate 1/7 sweeps).
 *
 * Usage:
 *   npx tsx scripts/agent-doc-drift.ts --agent scribe --org wyre
 *   npx tsx scripts/agent-doc-drift.ts --agent scribe --org wyre --json
 *   npx tsx scripts/agent-doc-drift.ts --all --org wyre   # every agent in the org
 *
 * This is a read-only report. It never modifies any file. Fixing a
 * reported drift is a human/agent decision per line, made deliberately —
 * boss's standing caution: "targeted line replacement only, do not copy
 * the file."
 */
import { readFileSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';

type CheckKind = 'equality' | 'property' | 'existence-only' | 'skipped';

interface FileCategory {
  file: string;
  kind: CheckKind;
  reason: string;
}

// Category assignments, derived from a real diff pass (scribe vs
// templates/agent/, 2026-08-15) rather than assumed from filenames alone.
const CATEGORIES: FileCategory[] = [
  { file: 'AGENTS.md', kind: 'equality', reason: 'framework file, expected near-identical' },
  { file: 'CLAUDE.md', kind: 'equality', reason: 'framework file, expected near-identical' },
  { file: 'HEARTBEAT.md', kind: 'equality', reason: 'framework file, expected near-identical' },
  { file: 'ONBOARDING.md', kind: 'equality', reason: 'framework file, expected near-identical' },
  { file: 'GUARDRAILS.md', kind: 'property', reason: 'agents extend this per-agent by design; template rows must still be present' },
  { file: 'TOOLS.md', kind: 'property', reason: 'agents extend this per-agent by design; template rows must still be present' },
  { file: 'SYSTEM.md', kind: 'existence-only', reason: 'template has {{...}} placeholders instantiated once at creation, never synced back' },
  { file: 'SOUL.md', kind: 'existence-only', reason: 'template has {{...}} placeholders instantiated once at creation, never synced back' },
  { file: 'GOALS.md', kind: 'existence-only', reason: 'template has {{...}} placeholders; also regenerated from goals.json, never hand-synced' },
  { file: 'IDENTITY.md', kind: 'skipped', reason: 'fully agent-owned — name, role, vibe' },
  { file: 'MEMORY.md', kind: 'skipped', reason: 'fully agent-owned — accumulated learnings' },
  { file: 'USER.md', kind: 'skipped', reason: 'fully agent-owned — learned user preferences' },
  { file: 'goals.json', kind: 'skipped', reason: 'fully agent-owned — regenerates GOALS.md' },
  { file: 'config.json', kind: 'skipped', reason: 'fully agent-owned — per-agent runtime config; has its own {{}} placeholder + migration tooling' },
];

interface EqualityDiff {
  onlyInTemplate: string[];
  onlyInDeployed: string[];
}

function nonBlankLines(text: string): string[] {
  return text.split('\n').filter((l) => l.trim().length > 0);
}

function equalityDiff(templateText: string, deployedText: string): EqualityDiff {
  const t = nonBlankLines(templateText);
  const d = nonBlankLines(deployedText);
  const tSet = new Set(t);
  const dSet = new Set(d);
  return {
    onlyInTemplate: t.filter((l) => !dSet.has(l)),
    onlyInDeployed: d.filter((l) => !tSet.has(l)),
  };
}

function propertyDiff(templateText: string, deployedText: string): string[] {
  const t = nonBlankLines(templateText);
  const dSet = new Set(nonBlankLines(deployedText));
  return t.filter((l) => !dSet.has(l));
}

interface AgentReport {
  agent: string;
  org: string;
  results: Array<{
    file: string;
    kind: CheckKind;
    reason: string;
    status: 'clean' | 'drift' | 'missing-in-deployed' | 'missing-in-template' | 'skipped';
    detail?: EqualityDiff | string[] | string;
  }>;
}

function runForAgent(frameworkRoot: string, org: string, agent: string): AgentReport {
  const templateDir = join(frameworkRoot, 'templates', 'agent');
  const deployedDir = join(frameworkRoot, 'orgs', org, 'agents', agent);
  const results: AgentReport['results'] = [];

  for (const cat of CATEGORIES) {
    const templatePath = join(templateDir, cat.file);
    const deployedPath = join(deployedDir, cat.file);
    const templateExists = existsSync(templatePath);
    const deployedExists = existsSync(deployedPath);

    if (cat.kind === 'skipped') {
      results.push({ file: cat.file, kind: cat.kind, reason: cat.reason, status: 'skipped' });
      continue;
    }

    if (!templateExists) {
      results.push({ file: cat.file, kind: cat.kind, reason: cat.reason, status: 'missing-in-template' });
      continue;
    }
    if (!deployedExists) {
      results.push({ file: cat.file, kind: cat.kind, reason: cat.reason, status: 'missing-in-deployed' });
      continue;
    }

    if (cat.kind === 'existence-only') {
      results.push({ file: cat.file, kind: cat.kind, reason: cat.reason, status: 'clean' });
      continue;
    }

    const templateText = readFileSync(templatePath, 'utf-8');
    const deployedText = readFileSync(deployedPath, 'utf-8');

    if (cat.kind === 'equality') {
      const diff = equalityDiff(templateText, deployedText);
      const isClean = diff.onlyInTemplate.length === 0 && diff.onlyInDeployed.length === 0;
      results.push({
        file: cat.file,
        kind: cat.kind,
        reason: cat.reason,
        status: isClean ? 'clean' : 'drift',
        detail: isClean ? undefined : diff,
      });
    } else if (cat.kind === 'property') {
      const missing = propertyDiff(templateText, deployedText);
      results.push({
        file: cat.file,
        kind: cat.kind,
        reason: cat.reason,
        status: missing.length === 0 ? 'clean' : 'drift',
        detail: missing.length === 0 ? undefined : missing,
      });
    }
  }

  return { agent, org, results };
}

function printReport(report: AgentReport): void {
  const counts = { equality: 0, property: 0, 'existence-only': 0, skipped: 0 };
  for (const r of report.results) counts[r.kind]++;

  console.log(`\n=== ${report.org}/${report.agent} — agent-doc-drift report ===`);
  console.log(
    `Population examined: ${report.results.length} tracked template files ` +
      `(${counts.equality} equality-checked, ${counts.property} property-checked, ` +
      `${counts['existence-only']} existence-only, ${counts.skipped} deliberately skipped as agent-owned)`,
  );
  console.log('NOT covered by this run: community/agents/agent/ (public catalog tree — separate, unanswered question, not this tool\'s scope).');
  console.log(
    'READ EQUALITY vs PROPERTY DIFFERENTLY: an EQUALITY drift means the file differs, in either direction — a human decides which side is right. ' +
      'A PROPERTY drift means specific template content is MISSING from the deployed file — it is NEVER triggered by an agent\'s own legitimate ' +
      'additions (those are expected and healthy, and this tool does not flag them). A high PROPERTY drift count is a real gap, not noise.\n',
  );

  for (const r of report.results) {
    const kindLabel = r.kind.toUpperCase();
    if (r.status === 'skipped') {
      console.log(`  [SKIPPED, agent-owned] ${r.file} — ${r.reason}`);
      continue;
    }
    if (r.status === 'missing-in-template' || r.status === 'missing-in-deployed') {
      console.log(`  [${kindLabel}] ${r.file} — ${r.status.toUpperCase()} (${r.reason})`);
      continue;
    }
    if (r.status === 'clean') {
      console.log(`  [${kindLabel}] ${r.file} — clean`);
      continue;
    }
    // drift
    console.log(`  [${kindLabel}] ${r.file} — DRIFT`);
    if (r.kind === 'equality') {
      const d = r.detail as EqualityDiff;
      if (d.onlyInTemplate.length > 0) {
        console.log(`      only in template (${d.onlyInTemplate.length} line(s), deployed may be behind):`);
        for (const line of d.onlyInTemplate.slice(0, 5)) console.log(`        - ${line.slice(0, 140)}`);
        if (d.onlyInTemplate.length > 5) console.log(`        ... and ${d.onlyInTemplate.length - 5} more`);
      }
      if (d.onlyInDeployed.length > 0) {
        console.log(`      only in deployed (${d.onlyInDeployed.length} line(s), deployed may be ahead, or a legitimate local edit):`);
        for (const line of d.onlyInDeployed.slice(0, 5)) console.log(`        - ${line.slice(0, 140)}`);
        if (d.onlyInDeployed.length > 5) console.log(`        ... and ${d.onlyInDeployed.length - 5} more`);
      }
    } else if (r.kind === 'property') {
      const missing = r.detail as string[];
      console.log(`      ${missing.length} template line(s) not found anywhere in deployed file (base content may be missing, not just un-extended):`);
      for (const line of missing.slice(0, 5)) console.log(`        - ${line.slice(0, 140)}`);
      if (missing.length > 5) console.log(`        ... and ${missing.length - 5} more`);
    }
  }
  console.log('');
}

function findFrameworkRoot(rootOverride?: string): string {
  // scripts/ is always a direct child of the framework root — BUT orgs/ is
  // gitignored, so a fresh `git worktree` checkout of this repo never has
  // it, even though scripts/ resolves fine. Discovered running this very
  // script from an isolated worktree: __dirname/.. pointed at a real,
  // existing directory that nonetheless reported every file as "missing in
  // deployed," because orgs/<org>/agents/ simply didn't exist there. This
  // tool must run against a checkout with the real orgs/ tree — normally
  // the primary framework checkout, not an arbitrary worktree — or be
  // pointed at one explicitly with --root.
  if (rootOverride) return rootOverride;
  return join(__dirname, '..');
}

function listAgentsInOrg(frameworkRoot: string, org: string): string[] {
  const agentsDir = join(frameworkRoot, 'orgs', org, 'agents');
  if (!existsSync(agentsDir)) return [];
  return readdirSync(agentsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
}

function main(): void {
  const args = process.argv.slice(2);
  const orgIdx = args.indexOf('--org');
  const org = orgIdx >= 0 ? args[orgIdx + 1] : undefined;
  const agentIdx = args.indexOf('--agent');
  const agent = agentIdx >= 0 ? args[agentIdx + 1] : undefined;
  const all = args.includes('--all');
  const asJson = args.includes('--json');
  const rootIdx = args.indexOf('--root');
  const rootOverride = rootIdx >= 0 ? args[rootIdx + 1] : undefined;

  if (!org || (!agent && !all)) {
    console.error('Usage: npx tsx scripts/agent-doc-drift.ts --agent <name> --org <org> [--json] [--root <path>]');
    console.error('   or: npx tsx scripts/agent-doc-drift.ts --all --org <org> [--json] [--root <path>]');
    process.exit(1);
  }

  const frameworkRoot = findFrameworkRoot(rootOverride);

  // Fail CLOSED, explicitly, before doing any per-file work. orgs/ is
  // gitignored — a fresh `git worktree` checkout (or a CI runner without
  // the real tree mounted) does not have it, and the naive failure mode
  // for that is a CLEAN, EMPTY result: every file check reports "missing
  // in deployed," which a hasty reader can misread as "nothing to see
  // here" rather than "this tool couldn't see the tree it needed to
  // check." Refuse outright instead, with an error that names the exact
  // thing that's missing, rather than let the absence look like a report.
  const agentsBaseDir = join(frameworkRoot, 'orgs', org, 'agents');
  if (!existsSync(agentsBaseDir)) {
    console.error(`REFUSING TO RUN: orgs/${org}/agents/ does not exist under ${frameworkRoot}.`);
    console.error('orgs/ is gitignored — a fresh `git worktree` checkout will never have it.');
    console.error('Point --root at a checkout with the real orgs/ tree (normally the primary framework checkout).');
    process.exit(1);
  }

  const agents = all ? listAgentsInOrg(frameworkRoot, org) : [agent as string];

  if (agents.length === 0) {
    console.error(`No agents found under orgs/${org}/agents/`);
    process.exit(1);
  }

  if (!all && !existsSync(join(agentsBaseDir, agent as string))) {
    console.error(`REFUSING TO RUN: orgs/${org}/agents/${agent}/ does not exist.`);
    process.exit(1);
  }

  const reports = agents.map((a) => runForAgent(frameworkRoot, org, a));

  if (asJson) {
    console.log(JSON.stringify(reports, null, 2));
  } else {
    for (const r of reports) printReport(r);
  }
}

main();
