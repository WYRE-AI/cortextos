# WYRE cortextOS SP1 — Fork & Namespace Foundation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give cortextOS a per-engineer namespace so shared org agents and personal specialist agents coexist on one host, and ship a `WYRE-AI/cortextos` fork with one-command engineer provisioning.

**Architecture:** Personal agents nest at `orgs/<org>/engineers/<engineer>/agents/<name>`; shared agents stay at `orgs/<org>/agents/<name>`. All agent-directory resolution is funneled through one resolver module so namespace logic lives in exactly one place. A new `add-engineer` CLI command scaffolds namespaces.

**Tech Stack:** TypeScript (strict), Node.js 20+, Commander (CLI), Vitest (tests), tsup (build).

**Spec:** `docs/superpowers/specs/2026-05-20-wyre-cortextos-sp1-fork-namespace-design.md`

**Conventions for every task below:**
- Tests run with `npm test` (vitest); a single file with `npx vitest run <path>`.
- Build/typecheck gate: `npm run build` and `npm run typecheck` must pass.
- Commit messages follow Conventional Commits. Commit after every task.
- Work happens on branch `feat/wyre-team-edition` (already created).

---

## Task 1: Create the WYRE fork

Infrastructure task — no tests.

- [ ] **Step 1: Create the fork under wyre-technology**

```bash
gh repo fork asachs01/cortextos --org wyre-technology --fork-name cortextos --clone=false
```

Expected: `✓ Created fork WYRE-AI/cortextos`.

- [ ] **Step 2: Re-point the local repo's remotes**

```bash
cd ~/cortextos
git remote set-url origin git@github.com:WYRE-AI/cortextos.git
git remote set-url upstream git@github.com:grandamenium/cortextos.git
git remote -v
```

Expected: `origin` → `WYRE-AI/cortextos`, `upstream` → `grandamenium/cortextos`.

- [ ] **Step 3: Push the working branch**

```bash
git push -u origin feat/wyre-team-edition
```

Expected: branch published, tracking set.

- [ ] **Step 4: Document the upstream-sync process**

Append to `CONTRIBUTING.md` (create the section if `CONTRIBUTING.md` exists; it does):

```markdown
## Syncing with upstream cortextOS

WYRE runs a hard fork. To pull upstream fixes:

    git fetch upstream
    git checkout -b sync/<date> upstream/main
    # cherry-pick or merge specific commits, resolving conflicts in src/
    git checkout main && git merge sync/<date>

Keep WYRE-specific changes surgical and isolated (prefer new files over edits
to upstream files) to minimise merge conflicts.
```

- [ ] **Step 5: Commit**

```bash
git add CONTRIBUTING.md
git commit -m "docs: document upstream-sync process for the WYRE fork"
```

---

## Task 2: Agent-directory resolver module

Centralizes the scattered `join(orgsDir, org, 'agents', name)` logic into one
module that also understands the `engineers/<engineer>/agents/<name>` layout.

**Files:**
- Create: `src/utils/agent-dir.ts`
- Test: `tests/unit/utils/agent-dir.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/utils/agent-dir.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { join } from 'path';
import { parseQualifiedName, resolveAgentDir } from '../../../src/utils/agent-dir';

describe('parseQualifiedName', () => {
  it('parses a bare (shared) agent name', () => {
    expect(parseQualifiedName('boss')).toEqual({ agent: 'boss' });
  });

  it('parses an engineer-qualified agent name', () => {
    expect(parseQualifiedName('aaron/dev')).toEqual({ engineer: 'aaron', agent: 'dev' });
  });

  it('rejects a name with more than one slash', () => {
    expect(() => parseQualifiedName('a/b/c')).toThrow(/qualified/i);
  });

  it('rejects an invalid engineer segment', () => {
    expect(() => parseQualifiedName('Aaron/dev')).toThrow(/engineer/i);
  });

  it('rejects an invalid agent segment', () => {
    expect(() => parseQualifiedName('aaron/Dev')).toThrow(/agent/i);
  });
});

describe('resolveAgentDir', () => {
  const root = '/fw';

  it('resolves a shared agent under orgs/<org>/agents', () => {
    expect(resolveAgentDir(root, 'wyre', 'boss'))
      .toBe(join(root, 'orgs', 'wyre', 'agents', 'boss'));
  });

  it('resolves a namespaced agent under engineers/<engineer>/agents', () => {
    expect(resolveAgentDir(root, 'wyre', 'aaron/dev'))
      .toBe(join(root, 'orgs', 'wyre', 'engineers', 'aaron', 'agents', 'dev'));
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/unit/utils/agent-dir.test.ts`
Expected: FAIL — `Cannot find module '../../../src/utils/agent-dir'`.

- [ ] **Step 3: Write the implementation**

Create `src/utils/agent-dir.ts`:

```typescript
import { join } from 'path';

/** Canonical segment rule — matches AGENT_NAME_REGEX in src/utils/validate.ts. */
const SEGMENT_RE = /^[a-z0-9_-]+$/;

export interface QualifiedName {
  /** Engineer namespace, if this is a personal agent. */
  engineer?: string;
  /** Bare agent name. */
  agent: string;
}

/**
 * Parse an agent reference into its parts.
 *   "boss"       -> { agent: 'boss' }            (shared org agent)
 *   "aaron/dev"  -> { engineer: 'aaron', agent: 'dev' }  (personal agent)
 */
export function parseQualifiedName(name: string): QualifiedName {
  const parts = name.split('/');
  if (parts.length > 2) {
    throw new Error(`Invalid qualified agent name "${name}": at most one "/" allowed.`);
  }
  if (parts.length === 2) {
    const [engineer, agent] = parts;
    if (!SEGMENT_RE.test(engineer)) {
      throw new Error(`Invalid engineer segment "${engineer}" in "${name}": must match ${SEGMENT_RE}.`);
    }
    if (!SEGMENT_RE.test(agent)) {
      throw new Error(`Invalid agent segment "${agent}" in "${name}": must match ${SEGMENT_RE}.`);
    }
    return { engineer, agent };
  }
  if (!SEGMENT_RE.test(name)) {
    throw new Error(`Invalid agent name "${name}": must match ${SEGMENT_RE}.`);
  }
  return { agent: name };
}

/**
 * Resolve the on-disk framework directory for an agent.
 * `frameworkRoot` is the cortextOS checkout (CTX_FRAMEWORK_ROOT).
 * `qualifiedName` is bare ("boss") or engineer-qualified ("aaron/dev").
 */
export function resolveAgentDir(frameworkRoot: string, org: string, qualifiedName: string): string {
  const { engineer, agent } = parseQualifiedName(qualifiedName);
  if (engineer) {
    return join(frameworkRoot, 'orgs', org, 'engineers', engineer, 'agents', agent);
  }
  return join(frameworkRoot, 'orgs', org, 'agents', agent);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/unit/utils/agent-dir.test.ts`
Expected: PASS — all 7 tests green.

- [ ] **Step 5: Commit**

```bash
git add src/utils/agent-dir.ts tests/unit/utils/agent-dir.test.ts
git commit -m "feat: add centralized agent-directory resolver with namespace support"
```

---

## Task 3: Route hardcoded path joins through the resolver

Mechanical refactor — no behaviour change. Existing tests are the safety net.

**Files to modify** (replace each `join(<root>, 'orgs', <org>, 'agents', <name>)`
with `resolveAgentDir(<root>, <org>, <name>)`, adding the import):
- `src/bus/agents.ts`
- `src/bus/system.ts`
- `src/bus/oauth.ts`
- `src/utils/env.ts`
- `src/cli/get-config.ts`
- `src/cli/ecosystem.ts`
- `src/cli/setup.ts`
- `src/cli/bus.ts`

- [ ] **Step 1: Confirm the full set of call sites**

Run: `grep -rn "'orgs'.*'agents'\|orgs/.*agents" src/ | grep join`
Expected: a list matching the 8 files above. If a file is missing from the
list above, add it to this task; if one no longer matches, skip it.

- [ ] **Step 2: Refactor each file**

In each file, add at the top:

```typescript
import { resolveAgentDir } from '../utils/agent-dir.js'; // adjust depth: '../../' from src/cli or src/bus is '../utils/agent-dir.js'
```

Then replace every expression of the form
`join(someRoot, 'orgs', someOrg, 'agents', someName)` with
`resolveAgentDir(someRoot, someOrg, someName)`.

Leave the top-level `agents/<name>` *fallback* joins (e.g.
`src/bus/agents.ts:152`, `src/cli/bus.ts:431`) untouched — those are a separate
legacy layout, out of scope for SP1.

Do **not** change the directory-scan loops in `src/bus/agents.ts` (the
`readdirSync(agentsDir)` block) in this task — that is Task 4.

- [ ] **Step 3: Typecheck and build**

Run: `npm run typecheck && npm run build`
Expected: clean compile, no errors.

- [ ] **Step 4: Run the full test suite**

Run: `npm test`
Expected: PASS — the same tests that passed before this task still pass.
A behaviour-preserving refactor changes no test outcomes.

- [ ] **Step 5: Commit**

```bash
git add src/
git commit -m "refactor: route agent-directory resolution through resolveAgentDir"
```

---

## Task 4: Discover namespaced agents in listAgents

Teaches the directory scan to also enumerate `engineers/<engineer>/agents/<name>`,
reporting personal agents under their qualified name.

**Files:**
- Modify: `src/bus/agents.ts` (the `listAgents` scan loop, ~lines 71-95)
- Modify: `src/types/index.ts` (add optional `engineer` field to `AgentInfo`)
- Test: `tests/unit/bus/agents.test.ts` (extend existing file)

- [ ] **Step 1: Write the failing test**

Append to `tests/unit/bus/agents.test.ts` a test using the file's existing temp-dir
fixture pattern. It must create an org with both a shared and a namespaced agent:

```typescript
describe('listAgents — engineer namespaces', () => {
  it('discovers namespaced agents under engineers/<engineer>/agents', () => {
    // tmpRoot is a fresh temp dir; mkdirp helper creates nested dirs.
    const tmpRoot = makeTempFrameworkRoot(); // existing helper in this test file
    mkdirSync(join(tmpRoot, 'orgs', 'wyre', 'agents', 'boss'), { recursive: true });
    mkdirSync(join(tmpRoot, 'orgs', 'wyre', 'engineers', 'aaron', 'agents', 'dev'), { recursive: true });

    process.env.CTX_FRAMEWORK_ROOT = tmpRoot;
    const agents = listAgents(makeTempCtxRoot(), 'wyre');
    const names = agents.map(a => a.name).sort();

    expect(names).toContain('boss');
    expect(names).toContain('aaron/dev');
    const dev = agents.find(a => a.name === 'aaron/dev');
    expect(dev?.engineer).toBe('aaron');
  });
});
```

> If the test file lacks `makeTempFrameworkRoot`/`makeTempCtxRoot` helpers, use
> the temp-dir setup already present in `tests/unit/bus/agents.test.ts` (it
> creates temp roots in `beforeEach`); mirror that exact pattern instead.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/unit/bus/agents.test.ts`
Expected: FAIL — `aaron/dev` not found (namespaced agents are not scanned yet).

- [ ] **Step 3: Add the `engineer` field to the type**

In `src/types/index.ts`, find the `AgentInfo` interface and add:

```typescript
  /** Engineer namespace for personal agents; absent for shared org agents. */
  engineer?: string;
```

- [ ] **Step 4: Implement namespace discovery**

In `src/bus/agents.ts`, inside the `for (const orgName of orgDirs)` loop, after
the existing shared-agent scan block, add a namespaced-agent scan:

```typescript
      // Namespaced (per-engineer) agents: orgs/<org>/engineers/<eng>/agents/<name>
      const engineersDir = join(orgsDir, orgName, 'engineers');
      if (existsSync(engineersDir)) {
        let engineerDirs: string[];
        try {
          engineerDirs = readdirSync(engineersDir);
        } catch {
          engineerDirs = [];
        }
        for (const engineer of engineerDirs) {
          if (!/^[a-z0-9_-]+$/.test(engineer)) continue;
          const nsAgentsDir = join(engineersDir, engineer, 'agents');
          if (!existsSync(nsAgentsDir)) continue;
          let nsAgentDirs: string[];
          try {
            nsAgentDirs = readdirSync(nsAgentsDir);
          } catch {
            continue;
          }
          for (const agentName of nsAgentDirs) {
            if (!/^[a-z0-9_-]+$/.test(agentName)) continue;
            const qualified = `${engineer}/${agentName}`;
            if (seen.has(qualified)) continue;
            seen.add(qualified);
            const explicitEntry = enabledAgents[qualified];
            const isEnabled = explicitEntry ? explicitEntry.enabled !== false : true;
            const info = buildAgentInfo(qualified, orgName, isEnabled, ctxRoot);
            info.engineer = engineer;
            agents.push(info);
          }
        }
      }
```

> `buildAgentInfo` already accepts the agent name as its first arg; passing the
> qualified name keeps `info.name === 'aaron/dev'`. Setting `info.engineer`
> after the call is intentional — `buildAgentInfo` has no engineer parameter and
> SP1 keeps that helper's signature unchanged.

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run tests/unit/bus/agents.test.ts`
Expected: PASS — including the new namespace test.

- [ ] **Step 6: Typecheck, build, full suite**

Run: `npm run typecheck && npm run build && npm test`
Expected: all PASS.

- [ ] **Step 7: Commit**

```bash
git add src/bus/agents.ts src/types/index.ts tests/unit/bus/agents.test.ts
git commit -m "feat: discover per-engineer namespaced agents in listAgents"
```

---

## Task 5: The `templates/engineer` template

A scaffold for a new engineer namespace: an empty `agents/` dir and a README.

**Files:**
- Create: `templates/engineer/agents/.gitkeep`
- Create: `templates/engineer/README.md`

- [ ] **Step 1: Create the template files**

```bash
mkdir -p templates/engineer/agents
touch templates/engineer/agents/.gitkeep
```

Create `templates/engineer/README.md`:

```markdown
# Engineer namespace: {{engineer}}

Personal specialist agents for {{engineer}}, scoped to the {{org}} org.

Add a personal agent into this namespace:

    cortextos add-agent {{engineer}}/<name> --org {{org}} --template agent

Shared org agents live in `orgs/{{org}}/agents/` and are run for the whole team.
```

- [ ] **Step 2: Commit**

```bash
git add templates/engineer
git commit -m "feat: add templates/engineer scaffold for namespaces"
```

---

## Task 6: The `add-engineer` CLI command

Scaffolds `orgs/<org>/engineers/<name>/` from `templates/engineer`, substituting
`{{engineer}}` and `{{org}}` placeholders.

**Files:**
- Create: `src/cli/add-engineer.ts`
- Modify: `src/cli/index.ts` (register the command)
- Test: `tests/unit/cli/add-engineer.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/cli/add-engineer.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, existsSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { scaffoldEngineer } from '../../../src/cli/add-engineer';

describe('scaffoldEngineer', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'ctx-eng-'));
    mkdirSync(join(root, 'orgs', 'wyre'), { recursive: true });
    // minimal templates/engineer
    mkdirSync(join(root, 'templates', 'engineer', 'agents'), { recursive: true });
    require('fs').writeFileSync(
      join(root, 'templates', 'engineer', 'README.md'),
      'Namespace for {{engineer}} in {{org}}.\n',
    );
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('scaffolds an engineer namespace with substituted placeholders', () => {
    scaffoldEngineer(root, 'wyre', 'aaron');
    const nsDir = join(root, 'orgs', 'wyre', 'engineers', 'aaron');
    expect(existsSync(join(nsDir, 'agents'))).toBe(true);
    expect(readFileSync(join(nsDir, 'README.md'), 'utf-8'))
      .toBe('Namespace for aaron in wyre.\n');
  });

  it('rejects an invalid engineer name', () => {
    expect(() => scaffoldEngineer(root, 'wyre', 'Aaron')).toThrow(/name/i);
  });

  it('rejects scaffolding an engineer that already exists', () => {
    scaffoldEngineer(root, 'wyre', 'aaron');
    expect(() => scaffoldEngineer(root, 'wyre', 'aaron')).toThrow(/exists/i);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/unit/cli/add-engineer.test.ts`
Expected: FAIL — `Cannot find module '../../../src/cli/add-engineer'`.

- [ ] **Step 3: Write the implementation**

Create `src/cli/add-engineer.ts`:

```typescript
import { Command } from 'commander';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, statSync } from 'fs';
import { join } from 'path';

const NAME_RE = /^[a-z0-9_-]+$/;

/**
 * Copy templates/engineer into orgs/<org>/engineers/<engineer>/, substituting
 * {{engineer}} and {{org}} placeholders. Pure function — no process.exit, so
 * it is unit-testable. Throws on invalid input.
 */
export function scaffoldEngineer(frameworkRoot: string, org: string, engineer: string): string {
  if (!NAME_RE.test(engineer)) {
    throw new Error(`Invalid engineer name "${engineer}": must match ${NAME_RE}.`);
  }
  const orgDir = join(frameworkRoot, 'orgs', org);
  if (!existsSync(orgDir)) {
    throw new Error(`Org "${org}" not found at ${orgDir}. Run "cortextos init ${org}" first.`);
  }
  const nsDir = join(orgDir, 'engineers', engineer);
  if (existsSync(nsDir)) {
    throw new Error(`Engineer namespace "${engineer}" already exists at ${nsDir}.`);
  }
  const templateDir = join(frameworkRoot, 'templates', 'engineer');
  if (!existsSync(templateDir)) {
    throw new Error(`templates/engineer not found at ${templateDir}.`);
  }
  copyDir(templateDir, nsDir, engineer, org);
  return nsDir;
}

function copyDir(src: string, dest: string, engineer: string, org: string): void {
  mkdirSync(dest, { recursive: true });
  for (const entry of readdirSync(src)) {
    const s = join(src, entry);
    const d = join(dest, entry);
    if (statSync(s).isDirectory()) {
      copyDir(s, d, engineer, org);
    } else {
      const content = readFileSync(s, 'utf-8')
        .replace(/\{\{engineer\}\}/g, engineer)
        .replace(/\{\{org\}\}/g, org);
      writeFileSync(d, content, 'utf-8');
    }
  }
}

export const addEngineerCommand = new Command('add-engineer')
  .argument('<name>', 'Engineer namespace name')
  .option('--org <org>', 'Organization name')
  .description('Create a per-engineer namespace for personal agents')
  .action((name: string, options: { org?: string }) => {
    const frameworkRoot =
      process.env.CTX_FRAMEWORK_ROOT || process.env.CTX_PROJECT_ROOT || process.cwd();

    let org = options.org;
    if (!org) {
      const orgsDir = join(frameworkRoot, 'orgs');
      if (existsSync(orgsDir)) {
        const orgs = readdirSync(orgsDir, { withFileTypes: true })
          .filter(d => d.isDirectory())
          .map(d => d.name);
        if (orgs.length === 1) org = orgs[0];
        else if (orgs.length > 1) {
          console.error('Multiple organizations found. Specify one with --org <name>');
          process.exit(1);
        }
      }
    }
    if (!org) {
      console.error('No organization found. Run "cortextos init <org>" first.');
      process.exit(1);
    }

    try {
      const nsDir = scaffoldEngineer(frameworkRoot, org, name);
      console.log(`\n  Engineer namespace "${name}" created at ${nsDir}`);
      console.log(`\n  Next: add personal agents into the namespace:`);
      console.log(`    cortextos add-agent ${name}/<agent> --org ${org} --template agent\n`);
    } catch (err) {
      console.error(`Error: ${(err as Error).message}`);
      process.exit(1);
    }
  });
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/unit/cli/add-engineer.test.ts`
Expected: PASS — all 3 tests green.

- [ ] **Step 5: Register the command in the CLI**

In `src/cli/index.ts`, add the import after the `addAgentCommand` import:

```typescript
import { addEngineerCommand } from './add-engineer.js';
```

And register it after `program.addCommand(addAgentCommand);`:

```typescript
program.addCommand(addEngineerCommand);
```

- [ ] **Step 6: Typecheck, build, full suite**

Run: `npm run typecheck && npm run build && npm test`
Expected: all PASS.

- [ ] **Step 7: Manual smoke test**

```bash
node dist/cli.js add-engineer testeng --org wyre
ls orgs/wyre/engineers/testeng/agents
rm -rf orgs/wyre/engineers/testeng
```

Expected: the namespace scaffolds, then is cleaned up.

- [ ] **Step 8: Commit**

```bash
git add src/cli/add-engineer.ts src/cli/index.ts tests/unit/cli/add-engineer.test.ts
git commit -m "feat: add 'cortextos add-engineer' command for namespace provisioning"
```

---

## Task 7: Collision-free PM2 process names for namespaced agents

Ensures `cortextos ecosystem` emits unique PM2 process names so a personal
agent never collides with a shared agent or another engineer's agent.

**Files:**
- Modify: `src/cli/ecosystem.ts`
- Test: `tests/unit/cli/ecosystem-namespace.test.ts`

- [ ] **Step 1: Read the current ecosystem generator**

Run: `cat src/cli/ecosystem.ts`
Identify the function that builds a PM2 process entry and the variable holding
the process `name` (currently the bare agent name). Note its exported surface.

- [ ] **Step 2: Write the failing test**

Create `tests/unit/cli/ecosystem-namespace.test.ts`. Use the *actual* exported
function name found in Step 1 (shown here as `pm2ProcessName`):

```typescript
import { describe, it, expect } from 'vitest';
import { pm2ProcessName } from '../../../src/cli/ecosystem';

describe('pm2ProcessName', () => {
  it('uses the bare name for a shared agent', () => {
    expect(pm2ProcessName('wyre', 'boss')).toBe('wyre-boss');
  });

  it('qualifies a namespaced agent with the engineer segment', () => {
    expect(pm2ProcessName('wyre', 'aaron/dev')).toBe('wyre-aaron-dev');
  });

  it('never collides a shared agent with a namespaced one of the same leaf', () => {
    expect(pm2ProcessName('wyre', 'dev'))
      .not.toBe(pm2ProcessName('wyre', 'aaron/dev'));
  });
});
```

> If `ecosystem.ts` builds the name inline with no exported helper, first
> extract the name-building logic into an exported `pm2ProcessName(org, name)`
> function and have the generator call it — then this test targets that
> function. Extraction-then-test is the intended approach here.

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run tests/unit/cli/ecosystem-namespace.test.ts`
Expected: FAIL — function missing, or namespaced name not qualified.

- [ ] **Step 4: Implement `pm2ProcessName`**

In `src/cli/ecosystem.ts`, add and export:

```typescript
/**
 * PM2 process name for an agent. Namespaced agents ("aaron/dev") have the "/"
 * replaced with "-" so the name is unique across engineers and shell-safe.
 */
export function pm2ProcessName(org: string, agentName: string): string {
  return `${org}-${agentName.replace('/', '-')}`;
}
```

Then update the generator loop to call `pm2ProcessName(org.name, agentName)`
for the process `name` field. If the loop currently only iterates the shared
`agents/` dir, extend it to also iterate `engineers/*/agents/*` and pass the
qualified `engineer/agent` name (reuse the discovery shape from Task 4, or call
`listAgents` and iterate its results — prefer `listAgents` to avoid duplicating
the scan).

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run tests/unit/cli/ecosystem-namespace.test.ts`
Expected: PASS — all 3 tests green.

- [ ] **Step 6: Typecheck, build, full suite**

Run: `npm run typecheck && npm run build && npm test`
Expected: all PASS.

- [ ] **Step 7: Commit**

```bash
git add src/cli/ecosystem.ts tests/unit/cli/ecosystem-namespace.test.ts
git commit -m "feat: qualified, collision-free PM2 names for namespaced agents"
```

---

## Task 8: WYRE branding & CHANGELOG

**Files:**
- Modify: `README.md`
- Modify: `CHANGELOG.md` (exists — add an Unreleased section at the top)

- [ ] **Step 1: Add a WYRE banner to the README**

Insert immediately below the first heading in `README.md`:

```markdown
> **WYRE fork.** This is `WYRE-AI/cortextos`, WYRE's hard fork of
> [grandamenium/cortextos](https://github.com/grandamenium/cortextos). It adds
> per-engineer namespaces so a shared agent fleet and personal specialist agents
> run together on one host. See `CONTRIBUTING.md` for the upstream-sync process.
```

- [ ] **Step 2: Add the Unreleased CHANGELOG section**

At the top of `CHANGELOG.md`, below the title/preamble, add:

```markdown
## [Unreleased]

### Added
- Per-engineer agent namespaces: personal agents live under
  `orgs/<org>/engineers/<engineer>/agents/<name>`, addressed as `<engineer>/<name>`.
- `cortextos add-engineer <name>` command to scaffold a namespace.
- `templates/engineer` namespace template.
- Centralized agent-directory resolution (`src/utils/agent-dir.ts`).

### Changed
- `listAgents` now also discovers namespaced agents.
- `cortextos ecosystem` emits qualified, collision-free PM2 process names.
- Forked to `WYRE-AI/cortextos`; `CONTRIBUTING.md` documents upstream sync.
```

- [ ] **Step 3: Commit**

```bash
git add README.md CHANGELOG.md
git commit -m "docs: WYRE fork branding and SP1 changelog"
```

---

## Task 9: Open the pull request

- [ ] **Step 1: Push and open the PR**

```bash
git push origin feat/wyre-team-edition
gh pr create --repo WYRE-AI/cortextos --base main --head feat/wyre-team-edition \
  --title "SP1: per-engineer namespace foundation" \
  --body "Implements docs/superpowers/specs/2026-05-20-wyre-cortextos-sp1-fork-namespace-design.md — centralized agent-dir resolution, namespaced agent discovery, add-engineer command, qualified PM2 names. SP2-4 tracked separately."
```

Expected: PR URL printed.

- [ ] **Step 2: Confirm CI is green**

Run: `gh pr checks --repo WYRE-AI/cortextos`
Expected: build + test checks pass.

---

## Self-review notes

- **Spec coverage:** fork (T1), centralize resolution (T2-3), namespace discovery
  + types (T4), `add-engineer` + `templates/engineer` (T5-6), ecosystem PM2 names
  (T7), branding/CHANGELOG (T8), plus PR (T9). The spec's "migrate existing
  structure" item resolves to "no move needed" — current `orgs/wyre/agents/*` are
  the shared agents and stay; if implementation review finds a personal-only agent,
  move it with `git mv` into `engineers/aaron/agents/` and note it in the T8 commit.
- **Resolver location:** the spec said `src/utils/paths.ts`; the plan uses a
  dedicated `src/utils/agent-dir.ts` instead, because `paths.ts` resolves
  `~/.cortextos` *state* paths while this resolves *framework* paths — different
  concern, own file. This honours the spec's intent (one place for namespace logic).
- **Placeholder scan:** none — every code step has complete code; Task 3 is an
  explicit mechanical pattern over an enumerated file list; Tasks 1, 7-step-1 are
  inspection steps by nature.
- **Type consistency:** `parseQualifiedName`/`resolveAgentDir` (T2),
  `AgentInfo.engineer` (T4), `scaffoldEngineer`/`addEngineerCommand` (T6),
  `pm2ProcessName` (T7) are referenced consistently throughout.
