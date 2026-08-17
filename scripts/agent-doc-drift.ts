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
 *   npx tsx scripts/agent-doc-drift.ts --all --org wyre   # every agent in one org
 *   npx tsx scripts/agent-doc-drift.ts --all              # every agent in every org under orgs/*
 *
 * This is a read-only report. It never modifies any file. Fixing a
 * reported drift is a human/agent decision per line, made deliberately —
 * boss's standing caution: "targeted line replacement only, do not copy
 * the file."
 */
import { readFileSync, existsSync, readdirSync } from 'fs';
import { join, relative } from 'path';

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

// Top-level templates/agent/ entries this tool deliberately does not treat
// as individual doc files — either because they're directories handled
// separately (skills/.claude, discovered dynamically below) or because
// they're agent-owned/non-doc by construction. Named explicitly so the
// runtime enumeration below can tell "known and intentionally skipped"
// apart from "genuinely never considered."
const KNOWN_NON_CATEGORY_TOPLEVEL: Record<string, string> = {
  '.gitignore': 'not a doc file',
  'skills': 'top-level skills/ (drafts, archive) is agent-authored content, not framework docs',
  'experiments': 'fully agent-owned — experiment records',
  'memory': 'fully agent-owned — daily memory files',
  '.claude': 'contains settings.json (not yet categorized — see UNEXAMINED below) and skills/ (discovered dynamically as equality entries)',
};

// infra found (2026-08-15, before #105 merged) that this tool's original
// hardcoded 14-entry CATEGORIES list silently never examined 5 of
// templates/agent/'s 19 top-level entries, including .claude/, which holds
// 24 files — every .claude/skills/*/SKILL.md among them. Five open
// cortextos PRs (#99-#102, #104) touch that tree; two of them (#102, #104)
// ALSO touch tracked AGENTS.md/CLAUDE.md, so the tool would have shown
// real drift on the tracked files while identical-shaped drift in
// .claude/skills/ sat invisible beside it — a partial hit that reads as
// "we found the drift" instead of "we found the part we look at," the
// exact standing-red shape this tool exists to avoid, one directory down
// from where it was looking. Fix: discover .claude/skills/*/SKILL.md
// dynamically (so a future new skill can't repeat the omission), AND
// enumerate the full template tree at runtime to report anything still
// not covered as UNEXAMINED by name — dual enumeration, the same
// discipline infra shipped as cortextos#103, pointed back at this tool's
// own scope.
function discoverSkillCategories(templateDir: string): FileCategory[] {
  const skillsDir = join(templateDir, '.claude', 'skills');
  if (!existsSync(skillsDir)) return [];
  const skillNames = readdirSync(skillsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
  const categories: FileCategory[] = [];
  for (const skill of skillNames) {
    const skillFile = join('.claude', 'skills', skill, 'SKILL.md');
    if (existsSync(join(templateDir, skillFile))) {
      categories.push({
        file: skillFile,
        kind: 'equality',
        reason: 'framework skill file, expected near-identical',
      });
    }
  }
  return categories;
}

interface UnexaminedEntry {
  path: string;
  note: string;
}

// Walk the full template tree and report every top-level entry not
// accounted for by CATEGORIES, the dynamically-discovered skill files, or
// KNOWN_NON_CATEGORY_TOPLEVEL — so a future template file added by anyone
// can't become invisible by default the way .claude/ did.
function findUnexaminedEntries(templateDir: string, categories: FileCategory[]): UnexaminedEntry[] {
  const categorizedTop = new Set(categories.map((c) => c.file.split('/')[0]));
  const topLevel = readdirSync(templateDir, { withFileTypes: true });
  const unexamined: UnexaminedEntry[] = [];
  for (const entry of topLevel) {
    // .claude/ is checked BEFORE the categorizedTop shortcut deliberately:
    // its skill files DO appear in categorizedTop (as '.claude/skills/...'
    // entries, split(\/)[0] === '.claude'), which would otherwise mask
    // settings.json — the one real file under .claude/ this tool still
    // doesn't examine. This was the exact bug the first version of this
    // fix shipped with: settings.json silently vanished from UNEXAMINED
    // because .claude "looked" fully categorized once skills/ was covered.
    if (entry.name === '.claude') {
      unexamined.push({
        path: '.claude/settings.json',
        note: 'not yet categorized — contains real framework-relevant config (e.g. defaultMode) alongside plausible per-agent permission customization; needs a deliberate category, not a guess',
      });
      continue;
    }
    if (categorizedTop.has(entry.name)) continue;
    if (entry.name in KNOWN_NON_CATEGORY_TOPLEVEL) continue;
    unexamined.push({ path: entry.name, note: 'new template entry, never considered by this tool — categorize it before trusting a clean report' });
  }
  return unexamined;
}

interface EqualityDiff {
  onlyInTemplate: string[];
  onlyInDeployed: string[];
  // Same multiset (same lines, same counts) but not the same sequence —
  // e.g. a section moved. Distinct from onlyInTemplate/onlyInDeployed,
  // which are both empty when this is true.
  reordered: boolean;
}

function nonBlankLines(text: string): string[] {
  return text.split('\n').filter((l) => l.trim().length > 0);
}

// infra found (2026-08-15) that Set-membership filtering is both
// order-blind and duplicate-blind: template=[alpha,bravo,charlie],
// deployed=[charlie,bravo,alpha,alpha] reported clean, because Set.has()
// only asks "does this line exist anywhere," never "how many times" or
// "in what order." A duplicated section is the signature artifact of a
// botched bulk write — exactly the case this tool exists to catch — so a
// clean report here was actively misleading. Fixed with a line MULTISET
// (frequency count): a line appearing more/fewer times on one side than
// the other now surfaces as an extra/missing occurrence, not just an
// extra/missing distinct value. Pure reordering (same multiset, same
// lines, different sequence) is reported separately via `reordered`
// rather than folded into the line lists, since positional diffing would
// otherwise flood the report with noise for a single moved line.
function lineCounts(lines: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const line of lines) counts.set(line, (counts.get(line) ?? 0) + 1);
  return counts;
}

function equalityDiff(templateText: string, deployedText: string): EqualityDiff {
  const t = nonBlankLines(templateText);
  const d = nonBlankLines(deployedText);
  const tCounts = lineCounts(t);
  const dCounts = lineCounts(d);
  const onlyInTemplate: string[] = [];
  const onlyInDeployed: string[] = [];
  for (const key of new Set([...tCounts.keys(), ...dCounts.keys()])) {
    const tc = tCounts.get(key) ?? 0;
    const dc = dCounts.get(key) ?? 0;
    for (let i = 0; i < tc - dc; i++) onlyInTemplate.push(key);
    for (let i = 0; i < dc - tc; i++) onlyInDeployed.push(key);
  }
  const sameMultiset = onlyInTemplate.length === 0 && onlyInDeployed.length === 0;
  const reordered = sameMultiset && t.join('\n') !== d.join('\n');
  return { onlyInTemplate, onlyInDeployed, reordered };
}

function propertyDiff(templateText: string, deployedText: string): string[] {
  const t = nonBlankLines(templateText);
  const dSet = new Set(nonBlankLines(deployedText));
  return t.filter((l) => !dSet.has(l));
}

interface AgentReport {
  agent: string;
  org: string;
  unexamined: UnexaminedEntry[];
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
  const allCategories = [...CATEGORIES, ...discoverSkillCategories(templateDir)];
  const unexamined = findUnexaminedEntries(templateDir, allCategories);

  for (const cat of allCategories) {
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
      const isClean = diff.onlyInTemplate.length === 0 && diff.onlyInDeployed.length === 0 && !diff.reordered;
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

  return { agent, org, unexamined, results };
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
      'additions (those are expected and healthy, and this tool does not flag them). A high PROPERTY drift count is a real gap, not noise.',
  );
  console.log(
    'CAVEAT (PROPERTY checks only): comparison is by line-set MEMBERSHIP, not count or position — a clean PROPERTY result does not rule out a ' +
      'template line appearing duplicated in the deployed file. EQUALITY checks use a line MULTISET (duplicates flagged) plus a separate reordered ' +
      'flag (same lines/counts, different sequence), so a clean EQUALITY result does rule out both reordering and duplication.',
  );
  if (report.unexamined.length > 0) {
    console.log(
      `\nUNEXAMINED (${report.unexamined.length} template entr${report.unexamined.length === 1 ? 'y' : 'ies'} not covered by any category — ` +
        'a clean report below does NOT mean these are clean, it means they were never checked):',
    );
    for (const u of report.unexamined) console.log(`    - ${u.path} — ${u.note}`);
  } else {
    console.log('\nUNEXAMINED: none — every top-level template entry is accounted for by a category.');
  }
  console.log('');

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
        console.log(`      only in template (${d.onlyInTemplate.length} line(s), deployed may be behind — a count above 1 for the same line means a missing DUPLICATE, not just a missing line):`);
        for (const line of d.onlyInTemplate.slice(0, 5)) console.log(`        - ${line.slice(0, 140)}`);
        if (d.onlyInTemplate.length > 5) console.log(`        ... and ${d.onlyInTemplate.length - 5} more`);
      }
      if (d.onlyInDeployed.length > 0) {
        console.log(`      only in deployed (${d.onlyInDeployed.length} line(s), deployed may be ahead, a legitimate local edit, or an UNINTENDED DUPLICATE — check which):`);
        for (const line of d.onlyInDeployed.slice(0, 5)) console.log(`        - ${line.slice(0, 140)}`);
        if (d.onlyInDeployed.length > 5) console.log(`        ... and ${d.onlyInDeployed.length - 5} more`);
      }
      if (d.reordered) {
        console.log('      REORDERED: same lines, same counts, different sequence (e.g. a section moved) — not shown line-by-line, verify manually.');
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

// infra found (2026-08-15) that --org was mandatory and --all only ever
// meant "every agent in the one org named" — orgs/wyre-gateway/ (5 more
// agents, all same-named as wyre agents, so a 15-row wyre-only report
// reads as complete beside it) sat entirely unexamined by every --all
// run, and nothing in the output said so. Same shape as the
// findUnexaminedEntries fix above, one directory up: a partial
// population must never be able to look like the whole one.
function listOrgs(frameworkRoot: string): string[] {
  const orgsDir = join(frameworkRoot, 'orgs');
  if (!existsSync(orgsDir)) return [];
  return readdirSync(orgsDir, { withFileTypes: true })
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

  // --org is now optional, but ONLY alongside --all (every org under
  // orgs/*). --agent still requires --org — a bare agent name is
  // ambiguous across orgs (this fleet's agent names collide across
  // wyre/wyre-gateway on purpose, which is exactly what made the old gap
  // invisible).
  if (!all && !org) {
    console.error('Usage: npx tsx scripts/agent-doc-drift.ts --agent <name> --org <org> [--json] [--root <path>]');
    console.error('   or: npx tsx scripts/agent-doc-drift.ts --all --org <org> [--json] [--root <path>]');
    console.error('   or: npx tsx scripts/agent-doc-drift.ts --all [--json] [--root <path>]   # every org under orgs/*');
    process.exit(1);
  }
  if (!all && !agent) {
    console.error('Usage: npx tsx scripts/agent-doc-drift.ts --agent <name> --org <org> [--json] [--root <path>]');
    process.exit(1);
  }
  if (agent && !org) {
    console.error('--agent requires --org — a bare agent name is ambiguous across orgs.');
    process.exit(1);
  }

  const frameworkRoot = findFrameworkRoot(rootOverride);
  const orgsToRun = org ? [org] : listOrgs(frameworkRoot);

  if (orgsToRun.length === 0) {
    console.error(`REFUSING TO RUN: no orgs found under ${join(frameworkRoot, 'orgs')}/ (missing or empty — orgs/ is gitignored, absent in a fresh worktree).`);
    console.error('Point --root at a checkout with the real orgs/ tree (normally the primary framework checkout).');
    process.exit(1);
  }

  const population: Array<{ org: string; agents: string[] }> = [];
  const reports: AgentReport[] = [];

  for (const o of orgsToRun) {
    // Fail CLOSED, explicitly, before doing any per-file work. orgs/ is
    // gitignored — a fresh `git worktree` checkout (or a CI runner without
    // the real tree mounted) does not have it, and the naive failure mode
    // for that is a CLEAN, EMPTY result: every file check reports "missing
    // in deployed," which a hasty reader can misread as "nothing to see
    // here" rather than "this tool couldn't see the tree it needed to
    // check." Refuse outright instead, with an error that names the exact
    // thing that's missing, rather than let the absence look like a report.
    const agentsBaseDir = join(frameworkRoot, 'orgs', o, 'agents');
    if (!existsSync(agentsBaseDir)) {
      console.error(`REFUSING TO RUN: orgs/${o}/agents/ does not exist under ${frameworkRoot}.`);
      console.error('orgs/ is gitignored — a fresh `git worktree` checkout will never have it.');
      console.error('Point --root at a checkout with the real orgs/ tree (normally the primary framework checkout).');
      process.exit(1);
    }

    const agentsInOrg = all ? listAgentsInOrg(frameworkRoot, o) : [agent as string];

    if (agentsInOrg.length === 0) {
      console.error(`No agents found under orgs/${o}/agents/`);
      process.exit(1);
    }

    if (!all && !existsSync(join(agentsBaseDir, agent as string))) {
      console.error(`REFUSING TO RUN: orgs/${o}/agents/${agent}/ does not exist.`);
      process.exit(1);
    }

    population.push({ org: o, agents: agentsInOrg });
    for (const a of agentsInOrg) reports.push(runForAgent(frameworkRoot, o, a));
  }

  // Print the examined population EVERY run, clean or not — the exact
  // discipline this tool already applies to its own file categories
  // (Population examined / UNEXAMINED above), now applied to org scope
  // too: a missing org must show up as absent, never as silently unasked.
  if (asJson) {
    console.log(JSON.stringify({ orgsExamined: population, reports }, null, 2));
  } else {
    const populationSummary = population
      .map((p) => `${p.org} (${p.agents.length} agent${p.agents.length === 1 ? '' : 's'})`)
      .join(', ');
    console.log(`\nOrgs examined this run: ${populationSummary}`);
    if (!org) console.log('(no --org given — enumerated every org under orgs/*; pass --org to scope to one)');
    for (const r of reports) printReport(r);
  }
}

main();
