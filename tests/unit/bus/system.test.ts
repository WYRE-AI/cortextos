import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { execSync } from 'child_process';
import { selfRestart, hardRestart, checkGoalStaleness, checkStaleBlockers, checkDeployDrift, postActivity } from '../../../src/bus/system';
import type { BusPaths, Task } from '../../../src/types';

function makePaths(testDir: string, agent: string = 'test-agent'): BusPaths {
  return {
    ctxRoot: testDir,
    inbox: join(testDir, 'inbox', agent),
    inflight: join(testDir, 'inflight', agent),
    processed: join(testDir, 'processed', agent),
    logDir: join(testDir, 'logs', agent),
    stateDir: join(testDir, 'state', agent),
    taskDir: join(testDir, 'tasks'),
    approvalDir: join(testDir, 'approvals'),
    analyticsDir: join(testDir, 'analytics'),
    heartbeatDir: join(testDir, 'heartbeats'),
  };
}

describe('Bus System', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'cortextos-system-test-'));
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  describe('selfRestart', () => {
    it('creates marker file and appends to restarts.log', () => {
      const paths = makePaths(testDir);
      selfRestart(paths, 'test-agent', 'config reload needed');

      // Check marker file
      const markerPath = join(paths.stateDir, '.restart-planned');
      expect(existsSync(markerPath)).toBe(true);
      const markerContent = readFileSync(markerPath, 'utf-8').trim();
      expect(markerContent).toBe('config reload needed');

      // Check restarts.log
      const logPath = join(paths.logDir, 'restarts.log');
      expect(existsSync(logPath)).toBe(true);
      const logContent = readFileSync(logPath, 'utf-8');
      expect(logContent).toContain('SELF-RESTART: config reload needed');
      expect(logContent).toMatch(/\[\d{4}-\d{2}-\d{2}T/);
    });

    it('uses default reason when none provided', () => {
      const paths = makePaths(testDir);
      selfRestart(paths, 'test-agent');

      const logPath = join(paths.logDir, 'restarts.log');
      const logContent = readFileSync(logPath, 'utf-8');
      expect(logContent).toContain('SELF-RESTART: no reason specified');
    });
  });

  describe('hardRestart', () => {
    it('creates .force-fresh and .restart-planned markers', () => {
      const paths = makePaths(testDir);
      hardRestart(paths, 'test-agent', 'context handoff');

      expect(existsSync(join(paths.stateDir, '.force-fresh'))).toBe(true);
      expect(existsSync(join(paths.stateDir, '.restart-planned'))).toBe(true);
      const logContent = readFileSync(join(paths.logDir, 'restarts.log'), 'utf-8');
      expect(logContent).toContain('HARD-RESTART: context handoff');
    });

    it('uses default reason when none provided', () => {
      const paths = makePaths(testDir);
      hardRestart(paths, 'test-agent');
      const logContent = readFileSync(join(paths.logDir, 'restarts.log'), 'utf-8');
      expect(logContent).toContain('HARD-RESTART: no reason specified');
    });
  });

  describe('checkGoalStaleness', () => {
    it('identifies stale goals', () => {
      // Create org/agent structure with old timestamp
      const agentDir = join(testDir, 'orgs', 'myorg', 'agents', 'worker');
      mkdirSync(agentDir, { recursive: true });

      const oldDate = new Date(Date.now() - 10 * 86400 * 1000).toISOString();
      writeFileSync(join(agentDir, 'GOALS.md'), `# Goals\n\n## Updated\n${oldDate}\n\nSome goal`);

      const report = checkGoalStaleness(testDir, 7);
      expect(report.summary.total).toBe(1);
      expect(report.summary.stale).toBe(1);
      expect(report.agents[0].status).toBe('stale');
      expect(report.agents[0].agent).toBe('worker');
      expect(report.agents[0].org).toBe('myorg');
      expect(report.agents[0].stale).toBe(true);
    });

    it('identifies fresh goals', () => {
      const agentDir = join(testDir, 'orgs', 'myorg', 'agents', 'worker');
      mkdirSync(agentDir, { recursive: true });

      const recentDate = new Date().toISOString();
      writeFileSync(join(agentDir, 'GOALS.md'), `# Goals\n\n## Updated\n${recentDate}\n\nSome goal`);

      const report = checkGoalStaleness(testDir, 7);
      expect(report.summary.fresh).toBe(1);
      expect(report.agents[0].status).toBe('fresh');
      expect(report.agents[0].stale).toBe(false);
    });

    it('handles missing GOALS.md', () => {
      const agentDir = join(testDir, 'orgs', 'myorg', 'agents', 'worker');
      mkdirSync(agentDir, { recursive: true });
      // No GOALS.md created

      const report = checkGoalStaleness(testDir);
      expect(report.agents[0].status).toBe('missing');
      expect(report.agents[0].stale).toBe(true);
      expect(report.agents[0].reason).toContain('no GOALS.md');
    });

    it('handles missing timestamp in GOALS.md', () => {
      const agentDir = join(testDir, 'orgs', 'myorg', 'agents', 'worker');
      mkdirSync(agentDir, { recursive: true });
      writeFileSync(join(agentDir, 'GOALS.md'), '# Goals\n\nJust some text without updated section');

      const report = checkGoalStaleness(testDir);
      expect(report.agents[0].status).toBe('no_timestamp');
      expect(report.agents[0].stale).toBe(true);
    });

    it('handles unparseable timestamp', () => {
      const agentDir = join(testDir, 'orgs', 'myorg', 'agents', 'worker');
      mkdirSync(agentDir, { recursive: true });
      writeFileSync(join(agentDir, 'GOALS.md'), '# Goals\n\n## Updated\nnot-a-date\n');

      const report = checkGoalStaleness(testDir);
      expect(report.agents[0].status).toBe('parse_error');
      expect(report.agents[0].stale).toBe(true);
    });

    // goals.json actually writes the timestamp with a trailing "(by <agent>)"
    // attribution suffix (e.g. "2026-07-28T12:03:06Z (by boss)") — Date()
    // returns Invalid Date for that whole string, which previously fell
    // through to 'parse_error'/stale=true fleet-wide even for goals updated
    // minutes ago. Pins the fix: the suffix must be stripped before parsing.
    it('parses a timestamp with the "(by <agent>)" attribution suffix goals.json writes (fresh)', () => {
      const agentDir = join(testDir, 'orgs', 'myorg', 'agents', 'worker');
      mkdirSync(agentDir, { recursive: true });

      const recentDate = new Date().toISOString();
      writeFileSync(join(agentDir, 'GOALS.md'), `# Goals\n\n## Updated\n${recentDate} (by boss)\n\nSome goal`);

      const report = checkGoalStaleness(testDir, 7);
      expect(report.agents[0].status).toBe('fresh');
      expect(report.agents[0].stale).toBe(false);
    });

    it('parses a timestamp with the "(by <agent>)" attribution suffix goals.json writes (stale)', () => {
      const agentDir = join(testDir, 'orgs', 'myorg', 'agents', 'worker');
      mkdirSync(agentDir, { recursive: true });

      const oldDate = new Date(Date.now() - 10 * 86400 * 1000).toISOString();
      writeFileSync(join(agentDir, 'GOALS.md'), `# Goals\n\n## Updated\n${oldDate} (by boss)\n\nSome goal`);

      const report = checkGoalStaleness(testDir, 7);
      expect(report.agents[0].status).toBe('stale');
      expect(report.agents[0].stale).toBe(true);
    });

    it('still parses a bare ISO timestamp with no attribution suffix (no regression)', () => {
      const agentDir = join(testDir, 'orgs', 'myorg', 'agents', 'worker');
      mkdirSync(agentDir, { recursive: true });

      const recentDate = new Date().toISOString();
      writeFileSync(join(agentDir, 'GOALS.md'), `# Goals\n\n## Updated\n${recentDate}\n\nSome goal`);

      const report = checkGoalStaleness(testDir, 7);
      expect(report.agents[0].status).toBe('fresh');
      expect(report.agents[0].stale).toBe(false);
    });

    it('returns empty report when no orgs directory', () => {
      const report = checkGoalStaleness(testDir);
      expect(report.summary.total).toBe(0);
      expect(report.agents).toEqual([]);
    });

    it('scans multiple orgs and agents', () => {
      // Create two orgs, each with a distinctly-named agent. Agent names are
      // assumed unique fleet-wide (discoverAllAgents/list-agents key on bare
      // name across orgs) — same-bare-name-in-different-orgs is a separate,
      // pre-existing edge case, not what this test is exercising.
      for (const [org, name] of [['org1', 'bot1'], ['org2', 'bot2']]) {
        const agentDir = join(testDir, 'orgs', org, 'agents', name);
        mkdirSync(agentDir, { recursive: true });
        const date = new Date().toISOString();
        writeFileSync(join(agentDir, 'GOALS.md'), `# Goals\n\n## Updated\n${date}\n`);
      }

      const report = checkGoalStaleness(testDir);
      expect(report.summary.total).toBe(2);
    });

    it('covers namespaced personal agents, not just shared org agents', () => {
      // task_1785723303692: the bug this whole fix closes — a personal agent
      // under orgs/<org>/engineers/<eng>/agents/<name> used to be silently
      // invisible to this scan entirely.
      const agentDir = join(testDir, 'orgs', 'myorg', 'engineers', 'aaron', 'agents', 'sidekick');
      mkdirSync(agentDir, { recursive: true });
      writeFileSync(join(agentDir, 'GOALS.md'), `# Goals\n\n## Updated\n${new Date().toISOString()}\n`);

      const report = checkGoalStaleness(testDir);
      expect(report.summary.total).toBe(1);
      expect(report.agents[0].agent).toBe('aaron/sidekick');
      expect(report.agents[0].org).toBe('myorg');
      expect(report.agents[0].stale).toBe(false);
    });
  });

  describe('postActivity', () => {
    it('returns false when not configured', async () => {
      const result = await postActivity(
        join(testDir, 'nonexistent'),
        testDir,
        'myorg',
        'hello',
      );
      expect(result).toBe(false);
    });

    it('returns false when env file has no token', async () => {
      const orgDir = join(testDir, 'orgdir');
      mkdirSync(orgDir, { recursive: true });
      writeFileSync(join(orgDir, 'activity-channel.env'), 'ACTIVITY_CHAT_ID=123\n');

      const result = await postActivity(orgDir, testDir, 'myorg', 'hello');
      expect(result).toBe(false);
    });

    it('returns false when env file has no chat ID', async () => {
      const orgDir = join(testDir, 'orgdir');
      mkdirSync(orgDir, { recursive: true });
      writeFileSync(join(orgDir, 'activity-channel.env'), 'ACTIVITY_BOT_TOKEN=abc123\n');

      const result = await postActivity(orgDir, testDir, 'myorg', 'hello');
      expect(result).toBe(false);
    });
  });

  describe('checkStaleBlockers', () => {
    function writeTask(org: string, task: Partial<Task> & Pick<Task, 'id' | 'title' | 'status'>) {
      const taskDir = join(testDir, 'orgs', org, 'tasks');
      mkdirSync(taskDir, { recursive: true });
      const full: Task = {
        description: '',
        type: 'agent',
        needs_approval: false,
        assigned_to: 'worker',
        created_by: 'worker',
        org,
        priority: 'normal',
        project: '',
        kpi_key: null,
        created_at: '2026-08-01T00:00:00Z',
        updated_at: '2026-08-01T00:00:00Z',
        completed_at: null,
        due_date: null,
        archived: false,
        ...task,
      };
      writeFileSync(join(taskDir, `${task.id}.json`), JSON.stringify(full));
    }

    it('flags a blocked task whose blocked_by dependency is already completed', () => {
      writeTask('myorg', { id: 'task_dep', title: 'dependency', status: 'completed' });
      writeTask('myorg', {
        id: 'task_blocked',
        title: 'waiting on dep',
        status: 'blocked',
        blocked_by: ['task_dep'],
      });

      const report = checkStaleBlockers(testDir);

      expect(report.summary.scanned).toBe(1);
      expect(report.summary.resolved_dependency_eligible).toBe(1);
      expect(report.entries).toHaveLength(1);
      expect(report.entries[0]).toMatchObject({
        task_id: 'task_blocked',
        org: 'myorg',
        kind: 'resolved_dependency',
      });
    });

    it('does not flag a blocked task whose dependency is still open, but still counts it as eligible', () => {
      writeTask('myorg', { id: 'task_dep', title: 'dependency', status: 'in_progress' });
      writeTask('myorg', {
        id: 'task_blocked',
        title: 'waiting on dep',
        status: 'blocked',
        blocked_by: ['task_dep'],
      });

      const report = checkStaleBlockers(testDir);

      expect(report.entries).toHaveLength(0);
      // Eligible (it carries blocked_by and WAS checked) but not resolved
      // (dependency still open) — a real "checked, found none" case, not a
      // "could not check" one.
      expect(report.summary.resolved_dependency_eligible).toBe(1);
      expect(report.summary.resolved_dependency).toBe(0);
    });

    it('flags a blocked task mentioning a bare PR reference as unverified_external_ref', () => {
      writeTask('myorg', {
        id: 'task_pr',
        title: 'ship the fix',
        status: 'blocked',
        description: 'blocked on PR#67 merging',
      });

      const report = checkStaleBlockers(testDir);

      expect(report.entries).toHaveLength(1);
      expect(report.entries[0]).toMatchObject({
        task_id: 'task_pr',
        kind: 'unverified_external_ref',
      });
      expect(report.entries[0].detail).toContain('PR #67');
    });

    // task_1786548092193 (analyst/forge, 2026-08-12 first live run): the
    // sweep matched "PR #306" in "...same shape as the action1 precedent,
    // PR #306..." as if it were the blocker, when it's a precedent-citation
    // example — PR #306 predated the task by weeks and never touched the
    // task's actual subject. This exact scenario, reproduced.
    it('does not flag a PR mention that is a precedent-citation example, not a blocker', () => {
      writeTask('myorg', {
        id: 'task_precedent',
        title: 'Gateway vendor-parity decision: mimecast + scalepad',
        status: 'blocked',
        description: 'Needs a business-scope call — same shape as the action1 precedent, PR #306.',
      });

      const report = checkStaleBlockers(testDir);

      expect(report.entries).toHaveLength(0);
    });

    it('still flags a genuine blocking PR mention even when a precedent citation appears earlier in the same description', () => {
      writeTask('myorg', {
        id: 'task_mixed',
        title: 'ship the fix',
        status: 'blocked',
        description:
          'Same shape as the action1 precedent, PR #306. This one is actually blocked on PR#67 merging.',
      });

      const report = checkStaleBlockers(testDir);

      expect(report.entries).toHaveLength(1);
      expect(report.entries[0].detail).toContain('PR #67');
      expect(report.entries[0].detail).not.toContain('PR #306');
    });

    it('does not flag other precedent-citation phrasings ("see PR #NN for the pattern", "e.g.", "prior art")', () => {
      writeTask('org-a', {
        id: 'task_see_pattern',
        title: 'wire the new vendor',
        status: 'blocked',
        description: 'Follow the existing rollout — see PR #12 for the pattern.',
      });
      writeTask('org-a', {
        id: 'task_eg',
        title: 'add the config flag',
        status: 'blocked',
        description: 'Gate it behind a flag (e.g. PR #45) rather than hardcoding.',
      });
      writeTask('org-a', {
        id: 'task_prior_art',
        title: 'draft the design doc',
        status: 'blocked',
        description: 'Prior art: PR #99 covers a similar migration.',
      });

      const report = checkStaleBlockers(testDir);

      expect(report.entries).toHaveLength(0);
    });

    // task_1788228644615 (grower's report, 2026-09-01): a real-world
    // reproduction — grower's task re-mentioned "PR #1424" in every
    // check-stale-blockers re-verify note explaining why it was already
    // dismissed, and kept re-flagging identically 6 times for zero new
    // information because the dismissal note sits far past the original
    // mention, outside the precedent-citation window.
    it('does not re-flag a PR reference already dismissed elsewhere in the text as a "tool artifact"', () => {
      writeTask('myorg', {
        id: 'task_dismissed',
        title: 'Trialing rows with NULL current_period_end',
        status: 'blocked',
        description:
          'Related: documented in-code by conduit PR #1424 as 13 verified against prod. ' +
          '--- APPENDED later ---\n' +
          "re-verify: already resolved 3x -- re-flag is a tool artifact of the bare 'PR #1424' text, not new info.",
      });

      const report = checkStaleBlockers(testDir);

      expect(report.entries).toHaveLength(0);
    });

    it('still flags a genuine PR reference when "tool artifact" appears but not near that PR number', () => {
      writeTask('myorg', {
        id: 'task_unrelated_dismissal',
        title: 'ship the fix',
        status: 'blocked',
        description:
          'A prior finding here (PR #55) was a tool artifact of an unrelated regex bug, already fixed. ' +
          'This task itself is genuinely blocked on PR#67 merging.',
      });

      const report = checkStaleBlockers(testDir);

      expect(report.entries).toHaveLength(1);
      expect(report.entries[0].detail).toContain('PR #67');
      expect(report.entries[0].detail).not.toContain('PR #55');
    });

    it('does not suppress a PR reference on the generic word "resolved" alone, only the narrow "tool artifact" cue', () => {
      writeTask('myorg', {
        id: 'task_generic_resolved',
        title: 'ship the fix',
        status: 'blocked',
        description: 'Still blocked on PR #67 — the upstream discussion was resolved but the merge has not happened.',
      });

      const report = checkStaleBlockers(testDir);

      expect(report.entries).toHaveLength(1);
      expect(report.entries[0].detail).toContain('PR #67');
    });

    // task_1788276323687 (grower, non-author review of #167): a NEGATED
    // mention of the dismissal idiom ("this is NOT a tool artifact") was
    // wrongly treated as a genuine dismissal, silently suppressing a real
    // still-open blocker — the exact failure #167 itself was fixing, from
    // the opposite direction.
    it('still flags a PR reference when "tool artifact" appears negated ("NOT a tool artifact")', () => {
      writeTask('myorg', {
        id: 'task_negated_dismissal',
        title: 'ship the fix',
        status: 'blocked',
        description: 'Checked carefully -- this is NOT a tool artifact, PR #67 is a genuine still-open blocker.',
      });

      const report = checkStaleBlockers(testDir);

      expect(report.entries).toHaveLength(1);
      expect(report.entries[0].detail).toContain('PR #67');
    });

    it('still suppresses a genuinely dismissed reference when a DIFFERENT, non-negated "tool artifact" mention exists in the same window', () => {
      writeTask('myorg', {
        id: 'task_mixed_negation',
        title: 'ship the fix',
        status: 'blocked',
        description:
          'Re-verify: this is NOT a tool artifact -- wait, actually on closer look it IS a tool artifact, PR #67 was already resolved elsewhere.',
      });

      const report = checkStaleBlockers(testDir);

      expect(report.entries).toHaveLength(0);
    });

    // task_1788276326374's sibling finding (grower's delta review of the
    // negation fix itself): an intervening adverb between the negation word
    // and "a tool artifact" defeated an end-anchored negation check.
    it('still flags a PR reference when an adverb intervenes ("not really a tool artifact")', () => {
      writeTask('myorg', {
        id: 'task_negated_adverb',
        title: 'ship the fix',
        status: 'blocked',
        description: 'This is not really a tool artifact, PR #67 is a genuine blocker.',
      });

      const report = checkStaleBlockers(testDir);

      expect(report.entries).toHaveLength(1);
      expect(report.entries[0].detail).toContain('PR #67');
    });

    it('still suppresses a genuine dismissal even when an unrelated negation appears earlier in the same sentence, outside the lookback window', () => {
      writeTask('myorg', {
        id: 'task_unrelated_negation',
        title: 'ship the fix',
        status: 'blocked',
        description: 'Status update: task is not resolved, separately it is a tool artifact, PR #67 was closed.',
      });

      const report = checkStaleBlockers(testDir);

      expect(report.entries).toHaveLength(0);
    });

    it('does not flag a blocked task with no dependency signal at all, and does not count it as eligible', () => {
      writeTask('myorg', {
        id: 'task_plain',
        title: 'held for Aaron',
        status: 'blocked',
        description: 'waiting on a human decision',
      });

      const report = checkStaleBlockers(testDir);

      expect(report.entries).toHaveLength(0);
      expect(report.summary.resolved_dependency_eligible).toBe(0);
    });

    // task_1786777242641: the motivating scenario — resolved_dependency: 0
    // must be distinguishable from "0 of N were even checkable" rather than
    // "checked N, found none stale". Only one of these two tasks carries a
    // blocked_by field at all.
    it('distinguishes "checked, found none" from "could not check" via resolved_dependency_eligible', () => {
      writeTask('myorg', { id: 'task_dep', title: 'dependency', status: 'in_progress' });
      writeTask('myorg', {
        id: 'task_checkable',
        title: 'has a structured blocker, still open',
        status: 'blocked',
        blocked_by: ['task_dep'],
      });
      writeTask('myorg', {
        id: 'task_unstructured',
        title: 'held for Aaron',
        status: 'blocked',
        description: 'waiting on a human decision, no structured blocker field',
      });

      const report = checkStaleBlockers(testDir);

      expect(report.summary.scanned).toBe(2);
      expect(report.summary.resolved_dependency).toBe(0);
      // Without this field, "resolved_dependency: 0" alone can't tell you
      // that only 1 of the 2 scanned tasks was actually checkable.
      expect(report.summary.resolved_dependency_eligible).toBe(1);
    });

    it('scans every org, not just one', () => {
      writeTask('org-a', { id: 'task_dep_a', title: 'dep', status: 'completed' });
      writeTask('org-a', {
        id: 'task_blocked_a',
        title: 'waiting',
        status: 'blocked',
        blocked_by: ['task_dep_a'],
      });
      writeTask('org-b', {
        id: 'task_blocked_b',
        title: 'waiting',
        status: 'blocked',
        description: 'blocked on PR #12',
      });

      const report = checkStaleBlockers(testDir);

      expect(report.summary.scanned).toBe(2);
      // Only org-a's task carries blocked_by; org-b's is a freeform PR
      // mention with no structured field.
      expect(report.summary.resolved_dependency_eligible).toBe(1);
      const orgs = report.entries.map(e => e.org).sort();
      expect(orgs).toEqual(['org-a', 'org-b']);
    });

    it('returns an empty report when there are no orgs yet', () => {
      const report = checkStaleBlockers(testDir);
      expect(report.summary.scanned).toBe(0);
      expect(report.summary.resolved_dependency_eligible).toBe(0);
      expect(report.entries).toHaveLength(0);
    });
  });

  describe('checkDeployDrift', () => {
    let fixtureDir: string;
    let originDir: string;
    let localDir: string;

    function sh(cmd: string, cwd: string): string {
      return execSync(cmd, { cwd, encoding: 'utf-8', stdio: 'pipe' }).trim();
    }

    function writeManifest(sha: string, dirty: boolean = false) {
      writeFileSync(
        join(localDir, 'dist', 'build-manifest.json'),
        JSON.stringify({ gitSha: sha, dirty, builtAt: '2026-08-11T00:00:00.000Z' }),
      );
    }

    beforeEach(() => {
      fixtureDir = mkdtempSync(join(tmpdir(), 'cortextos-deploy-drift-'));
      originDir = join(fixtureDir, 'origin');
      localDir = join(fixtureDir, 'local');

      mkdirSync(originDir, { recursive: true });
      // -b main explicitly: the host's init.defaultBranch decides the bare
      // repo's HEAD otherwise, and on a `master` default the clones below end
      // up on an unborn `master` while these fixtures push/read `main`.
      sh('git init --bare -q -b main .', originDir);

      sh(`git clone -q ${originDir} local`, fixtureDir);
      sh('git config user.email test@test.com', localDir);
      sh('git config user.name Test', localDir);
      writeFileSync(join(localDir, 'file.txt'), 'a');
      sh('git add file.txt && git commit -q -m init', localDir);
      sh('git push -q origin HEAD:main', localDir);
      mkdirSync(join(localDir, 'dist'), { recursive: true });
    });

    afterEach(() => {
      rmSync(fixtureDir, { recursive: true, force: true });
    });

    it('reports clean when local HEAD matches origin/main and dist/ matches HEAD', () => {
      const head = sh('git rev-parse HEAD', localDir);
      writeManifest(head);

      const report = checkDeployDrift(localDir);

      expect(report.status).toBe('clean');
      expect(report.pull_drift?.behind).toBe(false);
      expect(report.build_drift?.stale).toBe(false);
    });

    it('reports pull drift when origin/main has commits local has not fetched', () => {
      const head = sh('git rev-parse HEAD', localDir);
      writeManifest(head);

      // Simulate another agent merging a PR: a second clone pushes ahead.
      const otherDir = join(fixtureDir, 'other');
      sh(`git clone -q -b main ${originDir} other`, fixtureDir);
      sh('git config user.email test@test.com', otherDir);
      sh('git config user.name Other', otherDir);
      writeFileSync(join(otherDir, 'file2.txt'), 'b');
      sh('git add file2.txt && git commit -q -m second', otherDir);
      sh('git push -q origin HEAD:main', otherDir);

      const report = checkDeployDrift(localDir);

      expect(report.status).toBe('drift');
      expect(report.pull_drift?.behind).toBe(true);
      expect(report.pull_drift?.commits_behind).toBe(1);
      expect(report.pull_drift?.commit_summaries).toHaveLength(1);
      expect(report.pull_drift?.commit_summaries[0]).toContain('second');
      // build_drift stays clean — dist/ still matches the (unchanged) local HEAD.
      expect(report.build_drift?.stale).toBe(false);
    });

    it('reports build drift when dist/build-manifest.json gitSha does not match local HEAD', () => {
      writeManifest('0000000000000000000000000000000000dead');

      const report = checkDeployDrift(localDir);

      expect(report.status).toBe('drift');
      expect(report.pull_drift?.behind).toBe(false);
      expect(report.build_drift?.stale).toBe(true);
      expect(report.build_drift?.reason).toMatch(/different commit/);
    });

    // 2026-08-11 fleet-CLI incident: a build from a dirty tree stamps the
    // same gitSha as a clean build at that commit — sha-match alone can't
    // tell them apart, so `dirty` must be checked independently.
    it('reports build drift when dist/ was built from a dirty tree, even though gitSha matches HEAD', () => {
      const head = sh('git rev-parse HEAD', localDir);
      writeManifest(head, true);

      const report = checkDeployDrift(localDir);

      expect(report.status).toBe('drift');
      expect(report.pull_drift?.behind).toBe(false);
      expect(report.build_drift?.stale).toBe(true);
      expect(report.build_drift?.built_dirty).toBe(true);
      expect(report.build_drift?.reason).toMatch(/dirty working tree/);
    });

    it('reports build drift when dist/build-manifest.json is missing', () => {
      const report = checkDeployDrift(localDir);

      expect(report.status).toBe('drift');
      expect(report.build_drift?.stale).toBe(true);
      expect(report.build_drift?.built_sha).toBeNull();
      expect(report.build_drift?.reason).toMatch(/not found/);
    });

    it('returns status error when the path is not a git repository', () => {
      const nonGitDir = join(fixtureDir, 'not-a-repo');
      mkdirSync(nonGitDir, { recursive: true });

      const report = checkDeployDrift(nonGitDir);

      expect(report.status).toBe('error');
      expect(report.error).toMatch(/not a git repository/);
    });

    it('returns status error when there is no origin remote configured', () => {
      sh('git remote remove origin', localDir);

      const report = checkDeployDrift(localDir);

      expect(report.status).toBe('error');
      expect(report.error).toMatch(/no origin remote/);
    });
  });
});
