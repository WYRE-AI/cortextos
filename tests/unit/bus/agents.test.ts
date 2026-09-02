import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { listAgents, notifyAgent, getAgentsWithCapability, sendToCapability } from '../../../src/bus/agents';
import { checkInbox } from '../../../src/bus/message';
import type { BusPaths } from '../../../src/types';

describe('Agent Discovery', () => {
  let testDir: string;
  let ctxRoot: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'cortextos-agents-test-'));
    ctxRoot = testDir;
    // Point CTX_FRAMEWORK_ROOT at an isolated subdir (no orgs/ inside) so that
    // listAgents() sees a configured but empty framework root and does NOT fall
    // back to process.cwd() — which is the repo root and has a real orgs/ dir.
    process.env.CTX_FRAMEWORK_ROOT = join(testDir, 'framework');
    delete process.env.CTX_PROJECT_ROOT;
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
    // Clean up env vars
    delete process.env.CTX_FRAMEWORK_ROOT;
    delete process.env.CTX_PROJECT_ROOT;
  });

  describe('listAgents', () => {
    it('discovers agents from enabled-agents.json', () => {
      // Set up enabled-agents.json
      const configDir = join(ctxRoot, 'config');
      mkdirSync(configDir, { recursive: true });
      writeFileSync(
        join(configDir, 'enabled-agents.json'),
        JSON.stringify({
          boris: { org: 'acme', enabled: true },
          paul: { org: 'acme', enabled: true },
        }),
      );

      const agents = listAgents(ctxRoot);
      expect(agents.length).toBe(2);
      expect(agents.map(a => a.name).sort()).toEqual(['boris', 'paul']);
      expect(agents[0].org).toBe('acme');
      expect(agents[0].enabled).toBe(true);
    });

    it('reads IDENTITY.md first line for role', () => {
      // Set up framework root with agent identity
      const frameworkRoot = join(testDir, 'framework');
      process.env.CTX_FRAMEWORK_ROOT = frameworkRoot;

      const agentDir = join(frameworkRoot, 'orgs', 'testorg', 'agents', 'worker');
      mkdirSync(agentDir, { recursive: true });
      writeFileSync(
        join(agentDir, 'IDENTITY.md'),
        '# Worker Agent\n\n## Role\nBackend developer responsible for API implementation\n',
      );

      // Set up enabled-agents.json
      const configDir = join(ctxRoot, 'config');
      mkdirSync(configDir, { recursive: true });
      writeFileSync(
        join(configDir, 'enabled-agents.json'),
        JSON.stringify({ worker: { org: 'testorg', enabled: true } }),
      );

      const agents = listAgents(ctxRoot);
      expect(agents.length).toBe(1);
      expect(agents[0].role).toBe('Backend developer responsible for API implementation');
    });

    it('handles missing files gracefully', () => {
      // No config dir, no heartbeats - should return empty array
      const agents = listAgents(ctxRoot);
      expect(agents).toEqual([]);
    });

    it('handles missing IDENTITY.md gracefully', () => {
      const configDir = join(ctxRoot, 'config');
      mkdirSync(configDir, { recursive: true });
      writeFileSync(
        join(configDir, 'enabled-agents.json'),
        JSON.stringify({ agent1: { org: 'org1', enabled: true } }),
      );

      const agents = listAgents(ctxRoot);
      expect(agents.length).toBe(1);
      expect(agents[0].role).toBe('');
    });

    it('reads heartbeat data for status', () => {
      const configDir = join(ctxRoot, 'config');
      mkdirSync(configDir, { recursive: true });
      writeFileSync(
        join(configDir, 'enabled-agents.json'),
        JSON.stringify({ worker: { org: 'testorg', enabled: true } }),
      );

      // Write heartbeat to state dir (path: state/{agent}/heartbeat.json)
      const hbDir = join(ctxRoot, 'state', 'worker');
      mkdirSync(hbDir, { recursive: true });
      writeFileSync(
        join(hbDir, 'heartbeat.json'),
        JSON.stringify({
          agent: 'worker',
          timestamp: new Date().toISOString(),
          status: 'idle',
        }),
      );

      const agents = listAgents(ctxRoot);
      expect(agents.length).toBe(1);
      expect(agents[0].last_heartbeat).toBeTruthy();
      expect(agents[0].running).toBe(true); // Recent heartbeat means running
    });

    it('filters by org when specified', () => {
      const configDir = join(ctxRoot, 'config');
      mkdirSync(configDir, { recursive: true });
      writeFileSync(
        join(configDir, 'enabled-agents.json'),
        JSON.stringify({
          boris: { org: 'acme', enabled: true },
          other: { org: 'different', enabled: true },
        }),
      );

      const agents = listAgents(ctxRoot, 'acme');
      expect(agents.length).toBe(1);
      expect(agents[0].name).toBe('boris');
    });

    // BUG-028: daemon and CLI must agree on what's enabled.
    // Previously, listAgents short-circuited on enabled-agents.json existence,
    // hiding agents the daemon was actually running from `cortextos list-agents`.
    it('shows agents from dir scan even when enabled-agents.json exists', () => {
      // Set up: enabled-agents.json with one agent (alice), but TWO dirs on disk
      // (alice and bob). Previously listAgents would only return alice. After
      // the fix, both should be returned.
      const configDir = join(ctxRoot, 'config');
      mkdirSync(configDir, { recursive: true });
      writeFileSync(
        join(configDir, 'enabled-agents.json'),
        JSON.stringify({ alice: { org: 'acme', enabled: true } }),
      );

      const frameworkRoot = join(testDir, 'framework');
      process.env.CTX_FRAMEWORK_ROOT = frameworkRoot;
      mkdirSync(join(frameworkRoot, 'orgs', 'acme', 'agents', 'alice'), { recursive: true });
      mkdirSync(join(frameworkRoot, 'orgs', 'acme', 'agents', 'bob'), { recursive: true });

      const agents = listAgents(ctxRoot);
      expect(agents.map(a => a.name).sort()).toEqual(['alice', 'bob']);
    });

    it('respects enabled: false from enabled-agents.json for agents found in dir scan', () => {
      // Set up: dir for alice + entry in enabled-agents.json saying enabled: false.
      // listAgents should return alice with enabled: false (not skip her entirely).
      const configDir = join(ctxRoot, 'config');
      mkdirSync(configDir, { recursive: true });
      writeFileSync(
        join(configDir, 'enabled-agents.json'),
        JSON.stringify({ alice: { org: 'acme', enabled: false } }),
      );

      const frameworkRoot = join(testDir, 'framework');
      process.env.CTX_FRAMEWORK_ROOT = frameworkRoot;
      mkdirSync(join(frameworkRoot, 'orgs', 'acme', 'agents', 'alice'), { recursive: true });

      const agents = listAgents(ctxRoot);
      expect(agents.length).toBe(1);
      expect(agents[0].name).toBe('alice');
      expect(agents[0].enabled).toBe(false);
    });
  });

  describe('namespaced agent discovery', () => {
    it('discovers per-engineer agents under their qualified name', () => {
      const frameworkRoot = join(testDir, 'framework');
      process.env.CTX_FRAMEWORK_ROOT = frameworkRoot;

      // Shared org agent
      mkdirSync(join(frameworkRoot, 'orgs', 'wyre', 'agents', 'boss'), { recursive: true });
      // Personal agent under engineer namespace
      mkdirSync(join(frameworkRoot, 'orgs', 'wyre', 'engineers', 'aaron', 'agents', 'dev'), {
        recursive: true,
      });

      const agents = listAgents(ctxRoot, 'wyre');
      const names = agents.map(a => a.name).sort();

      expect(names).toContain('boss');
      expect(names).toContain('aaron/dev');

      const nsAgent = agents.find(a => a.name === 'aaron/dev');
      expect(nsAgent).toBeDefined();
      expect(nsAgent!.engineer).toBe('aaron');
    });
  });

  describe('notifyAgent', () => {
    let paths: BusPaths;

    beforeEach(() => {
      paths = {
        ctxRoot,
        inbox: join(ctxRoot, 'inbox', 'sender'),
        inflight: join(ctxRoot, 'inflight', 'sender'),
        processed: join(ctxRoot, 'processed', 'sender'),
        logDir: join(ctxRoot, 'logs', 'sender'),
        stateDir: join(ctxRoot, 'state', 'sender'),
        taskDir: join(ctxRoot, 'tasks'),
        approvalDir: join(ctxRoot, 'approvals'),
        analyticsDir: join(ctxRoot, 'analytics'),
        heartbeatDir: join(ctxRoot, 'heartbeats'),
      };
    });

    it('creates signal file and bus message', () => {
      notifyAgent(paths, 'sender', 'target', 'Wake up!', ctxRoot);

      // Check signal file exists
      const signalFile = join(ctxRoot, 'state', 'target', '.urgent-signal');
      expect(existsSync(signalFile)).toBe(true);

      // Check bus message was sent
      const targetInbox = join(ctxRoot, 'inbox', 'target');
      expect(existsSync(targetInbox)).toBe(true);
      const files = require('fs').readdirSync(targetInbox).filter((f: string) => f.endsWith('.json'));
      expect(files.length).toBe(1);
    });

    it('signal file has correct JSON format', () => {
      notifyAgent(paths, 'boris', 'paul', 'New task available', ctxRoot);

      const signalFile = join(ctxRoot, 'state', 'paul', '.urgent-signal');
      const content = JSON.parse(readFileSync(signalFile, 'utf-8'));

      expect(content).toHaveProperty('from', 'boris');
      expect(content).toHaveProperty('message', 'New task available');
      expect(content).toHaveProperty('timestamp');
      // Verify timestamp is ISO 8601
      expect(new Date(content.timestamp).toISOString()).toBeTruthy();
    });

    it('creates state directory if it does not exist', () => {
      const stateDir = join(ctxRoot, 'state', 'newagent');
      expect(existsSync(stateDir)).toBe(false);

      notifyAgent(paths, 'sender', 'newagent', 'Hello', ctxRoot);

      expect(existsSync(stateDir)).toBe(true);
    });
  });
});

// Capability-tagged relay fan-out (task_1788300871646_92090539 — fix for the
// "angela-relay" single point of failure). Modeled on Hermes's
// a2a_orchestrate(capability, mode="first") (task_1788300304747_69074594).
describe('getAgentsWithCapability / sendToCapability', () => {
  let testDir: string;
  let ctxRoot: string;
  let frameworkRoot: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'cortextos-relay-test-'));
    ctxRoot = testDir;
    frameworkRoot = join(testDir, 'framework');
    process.env.CTX_FRAMEWORK_ROOT = frameworkRoot;
    delete process.env.CTX_PROJECT_ROOT;
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
    delete process.env.CTX_FRAMEWORK_ROOT;
    delete process.env.CTX_PROJECT_ROOT;
  });

  function writeAgentConfig(org: string, name: string, config: Record<string, unknown>): void {
    const dir = join(frameworkRoot, 'orgs', org, 'agents', name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'config.json'), JSON.stringify(config));
  }

  function pathsFor(agent: string): BusPaths {
    return {
      ctxRoot,
      inbox: join(ctxRoot, 'inbox', agent),
      inflight: join(ctxRoot, 'inflight', agent),
      processed: join(ctxRoot, 'processed', agent),
      logDir: join(ctxRoot, 'logs', agent),
      stateDir: join(ctxRoot, 'state', agent),
      taskDir: join(ctxRoot, 'orgs', 'acme', 'tasks'),
      approvalDir: join(ctxRoot, 'orgs', 'acme', 'approvals'),
      analyticsDir: join(ctxRoot, 'orgs', 'acme', 'analytics'),
      deliverablesDir: join(ctxRoot, 'orgs', 'acme', 'deliverables'),
    };
  }

  describe('getAgentsWithCapability', () => {
    it('returns only enabled agents tagged with the capability', () => {
      writeAgentConfig('acme', 'boss', { capabilities: ['comms-relay'] });
      writeAgentConfig('acme', 'backup', { capabilities: ['comms-relay'] });
      writeAgentConfig('acme', 'worker', { capabilities: ['other-tag'] });
      writeAgentConfig('acme', 'untagged', {});

      const tagged = getAgentsWithCapability(ctxRoot, 'acme', 'comms-relay');
      expect(tagged.sort()).toEqual(['backup', 'boss']);
    });

    it('excludes a tagged agent explicitly disabled via enabled-agents.json', () => {
      writeAgentConfig('acme', 'boss', { capabilities: ['comms-relay'] });
      writeAgentConfig('acme', 'backup', { capabilities: ['comms-relay'] });
      const configDir = join(ctxRoot, 'config');
      mkdirSync(configDir, { recursive: true });
      writeFileSync(
        join(configDir, 'enabled-agents.json'),
        JSON.stringify({ boss: { org: 'acme', enabled: false } }),
      );

      // A disabled relay candidate must not receive fan-out traffic nobody
      // expects it to process.
      expect(getAgentsWithCapability(ctxRoot, 'acme', 'comms-relay')).toEqual(['backup']);
    });

    it('returns an empty array when no agent carries the capability', () => {
      writeAgentConfig('acme', 'boss', { capabilities: ['other-tag'] });
      expect(getAgentsWithCapability(ctxRoot, 'acme', 'comms-relay')).toEqual([]);
    });

    it('skips a corrupt config.json rather than hiding every other candidate', () => {
      const brokenDir = join(frameworkRoot, 'orgs', 'acme', 'agents', 'broken');
      mkdirSync(brokenDir, { recursive: true });
      writeFileSync(join(brokenDir, 'config.json'), '{not json');
      writeAgentConfig('acme', 'boss', { capabilities: ['comms-relay'] });

      expect(getAgentsWithCapability(ctxRoot, 'acme', 'comms-relay')).toEqual(['boss']);
    });

    it('rejects an invalid capability tag', () => {
      expect(() => getAgentsWithCapability(ctxRoot, 'acme', 'Not Valid!')).toThrow();
    });
  });

  describe('sendToCapability', () => {
    it('fans a message out to every tagged agent, sharing one fanout id', () => {
      writeAgentConfig('acme', 'boss', { capabilities: ['comms-relay'] });
      writeAgentConfig('acme', 'backup', { capabilities: ['comms-relay'] });

      const result = sendToCapability(
        pathsFor('sender'), 'sender', 'acme', 'comms-relay', 'high', 'cross-boundary msg',
      );

      expect(result.capability).toBe('comms-relay');
      expect(result.recipients.sort()).toEqual(['backup', 'boss']);
      expect(result.msgIds.length).toBe(2);

      const bossInbox = readdirSync(join(ctxRoot, 'inbox', 'boss')).filter(f => f.endsWith('.json'));
      const backupInbox = readdirSync(join(ctxRoot, 'inbox', 'backup')).filter(f => f.endsWith('.json'));
      expect(bossInbox.length).toBe(1);
      expect(backupInbox.length).toBe(1);

      const bossMsg = JSON.parse(readFileSync(join(ctxRoot, 'inbox', 'boss', bossInbox[0]), 'utf-8'));
      const backupMsg = JSON.parse(readFileSync(join(ctxRoot, 'inbox', 'backup', backupInbox[0]), 'utf-8'));
      expect(bossMsg.fanout.id).toBe(result.fanoutId);
      expect(bossMsg.fanout.id).toBe(backupMsg.fanout.id);
      expect(bossMsg.text).toBe('cross-boundary msg');
    });

    it('throws when no agent carries the capability, instead of silently reaching nobody', () => {
      expect(() =>
        sendToCapability(pathsFor('sender'), 'sender', 'acme', 'comms-relay', 'normal', 'hello'),
      ).toThrow(/No enabled agent/);
    });

    it('checkInbox on a tagged recipient finds its own copy', () => {
      writeAgentConfig('acme', 'boss', { capabilities: ['comms-relay'] });
      writeAgentConfig('acme', 'backup', { capabilities: ['comms-relay'] });
      sendToCapability(pathsFor('sender'), 'sender', 'acme', 'comms-relay', 'normal', 'hi');

      const bossMessages = checkInbox(pathsFor('boss'));
      expect(bossMessages.length).toBe(1);
      expect(bossMessages[0].text).toBe('hi');
    });
  });
});
