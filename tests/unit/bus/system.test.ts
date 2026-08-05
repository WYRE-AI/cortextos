import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { execSync } from 'child_process';
import { selfRestart, hardRestart, autoCommit, checkGoalStaleness, postActivity } from '../../../src/bus/system';
import type { BusPaths } from '../../../src/types';

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

  describe('autoCommit', () => {
    let gitDir: string;

    beforeEach(() => {
      gitDir = mkdtempSync(join(tmpdir(), 'cortextos-autocommit-test-'));
      execSync('git init', { cwd: gitDir, stdio: 'pipe' });
      execSync('git config user.email "test@test.com"', { cwd: gitDir, stdio: 'pipe' });
      execSync('git config user.name "Test"', { cwd: gitDir, stdio: 'pipe' });
      // Create initial commit so git status works properly
      writeFileSync(join(gitDir, '.gitkeep'), '');
      execSync('git add .gitkeep && git commit -m "init"', { cwd: gitDir, stdio: 'pipe' });
    });

    afterEach(() => {
      rmSync(gitDir, { recursive: true, force: true });
    });

    it('filters out .env files', () => {
      writeFileSync(join(gitDir, 'app.env'), 'SECRET=abc');
      writeFileSync(join(gitDir, 'safe.txt'), 'hello');

      const report = autoCommit(gitDir, true);
      expect(report.status).toBe('dry_run');
      expect(report.staged).toContain('safe.txt');
      expect(report.blocked.some(b => b.includes('app.env'))).toBe(true);
    });

    it('filters out files with credential patterns', () => {
      writeFileSync(join(gitDir, 'config.json'), '{"token=abc123"}');
      writeFileSync(join(gitDir, 'readme.md'), 'just a readme');

      const report = autoCommit(gitDir, true);
      expect(report.blocked.some(b => b.includes('config.json') && b.includes('credential'))).toBe(true);
      expect(report.staged).toContain('readme.md');
    });

    // 2026-07-15 (analyst root-cause): the pre-fix sk- branch was a bare
    // substring match, so prose merely DOCUMENTING a token format (no real
    // secret value) tripped it — e.g. CLAUDE.md's "Setup-tokens (sk-ant-oat01)
    // lack the user:profile scope" blocked the daily auto-commit for a week.
    it('does NOT false-positive on prose documenting a token FORMAT, not a real value (regression guard)', () => {
      writeFileSync(
        join(gitDir, 'CLAUDE.md'),
        '- Setup-tokens (`sk-ant-oat01`) lack the `user:profile` scope, so preflight 403s with them.',
      );

      const report = autoCommit(gitDir, true);
      expect(report.staged).toContain('CLAUDE.md');
      expect(report.blocked.some(b => b.includes('CLAUDE.md'))).toBe(false);
    });

    it('STILL blocks a real sk- shaped token — the false-positive fix must not weaken real leak detection', () => {
      writeFileSync(
        join(gitDir, 'oops.json'),
        '{"key":"sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-ABCDEF"}',
      );

      const report = autoCommit(gitDir, true);
      expect(report.blocked.some(b => b.includes('oops.json') && b.includes('credential'))).toBe(true);
    });

    it('allows script files even with credential-like patterns', () => {
      writeFileSync(join(gitDir, 'deploy.sh'), '#!/bin/bash\ntoken=get_from_env');
      writeFileSync(join(gitDir, 'app.py'), 'password=input("Enter:")');
      writeFileSync(join(gitDir, 'main.js'), 'const secret=process.env.SECRET');

      const report = autoCommit(gitDir, true);
      expect(report.staged).toContain('deploy.sh');
      expect(report.staged).toContain('app.py');
      expect(report.staged).toContain('main.js');
    });

    it('filters out binary/temp files', () => {
      writeFileSync(join(gitDir, 'output.log'), 'log data');
      writeFileSync(join(gitDir, 'cache.tmp'), 'temp');
      writeFileSync(join(gitDir, 'app.pid'), '12345');

      const report = autoCommit(gitDir, true);
      expect(report.blocked.some(b => b.includes('output.log'))).toBe(true);
      expect(report.blocked.some(b => b.includes('cache.tmp'))).toBe(true);
      expect(report.blocked.some(b => b.includes('app.pid'))).toBe(true);
    });

    it('dry-run does not stage files', () => {
      writeFileSync(join(gitDir, 'newfile.txt'), 'content');

      const report = autoCommit(gitDir, true);
      expect(report.status).toBe('dry_run');

      // Verify nothing is staged
      const staged = execSync('git diff --cached --name-only', { cwd: gitDir, encoding: 'utf-8' });
      expect(staged.trim()).toBe('');
    });

    it('returns clean when no changes', () => {
      const report = autoCommit(gitDir);
      expect(report.status).toBe('clean');
    });

    it('stages safe files when not dry-run', () => {
      writeFileSync(join(gitDir, 'newfile.txt'), 'content');

      const report = autoCommit(gitDir, false);
      expect(report.status).toBe('staged');
      expect(report.staged).toContain('newfile.txt');

      // Verify file is actually staged
      const staged = execSync('git diff --cached --name-only', { cwd: gitDir, encoding: 'utf-8' });
      expect(staged.trim()).toContain('newfile.txt');
    });

    it('returns nothing_to_stage when all files blocked', () => {
      writeFileSync(join(gitDir, 'secrets.env'), 'API_KEY=123');

      const report = autoCommit(gitDir);
      expect(report.status).toBe('nothing_to_stage');
      expect(report.blocked.length).toBeGreaterThan(0);
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
});
