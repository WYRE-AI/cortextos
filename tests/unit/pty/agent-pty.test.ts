import { describe, it, expect, vi, afterEach } from 'vitest';
import { existsSync, readFileSync } from 'fs';

// node-pty is native; stub it so constructing AgentPTY never touches it.
vi.mock('node-pty', () => ({ spawn: vi.fn() }));

// existsSync=false → the local/*.md system-prompt block is skipped in buildClaudeArgs.
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    existsSync: vi.fn().mockReturnValue(false),
    readFileSync: vi.fn(),
    readdirSync: vi.fn().mockReturnValue([]),
  };
});

const { AgentPTY, applyEnvAssignment } = await import('../../../src/pty/agent-pty.js');

const mockEnv = {
  instanceId: 'test',
  ctxRoot: '/tmp/test-ctx',
  frameworkRoot: '/tmp/fw',
  agentName: 'alice',
  agentDir: '/tmp/fw/orgs/acme/agents/alice',
  org: 'acme',
  projectRoot: '/tmp/fw',
} as any;

function argsFor(config: any): string[] {
  const pty = new AgentPTY(mockEnv, config);
  return (pty as unknown as { buildClaudeArgs(m: 'fresh' | 'continue', p: string): string[] })
    .buildClaudeArgs('fresh', 'PROMPT');
}

describe('AgentPTY --dangerously-skip-permissions toggle', () => {
  it('includes the flag by default (back-compat: skip stays ON)', () => {
    expect(argsFor({})).toContain('--dangerously-skip-permissions');
  });

  it('includes the flag when dangerously_skip_permissions is explicitly true', () => {
    expect(argsFor({ dangerously_skip_permissions: true })).toContain('--dangerously-skip-permissions');
  });

  it('does NOT include the flag when dangerously_skip_permissions is false (permission gate engaged)', () => {
    expect(argsFor({ dangerously_skip_permissions: false })).not.toContain('--dangerously-skip-permissions');
  });

  it('includes the flag when dangerously_skip_permissions is explicitly undefined (treated as default)', () => {
    expect(argsFor({ dangerously_skip_permissions: undefined })).toContain('--dangerously-skip-permissions');
  });

  it('fails safe (keeps the flag) and warns on a non-boolean value, e.g. the string "false"', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      // A typo'd string must NOT silently disable the skip flag.
      expect(argsFor({ dangerously_skip_permissions: 'false' as any })).toContain('--dangerously-skip-permissions');
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});

describe('AgentPTY auto-updater pinning (shared-binary race)', () => {
  // Every agent gets its own CLAUDE_CONFIG_DIR, so each Claude Code instance
  // believes it is a standalone install and independently schedules updates —
  // but all N agents share ONE binary (~/.local/bin/claude -> versions/<v>).
  // On 2026-08-04 two updaters fired 250ms apart, both reported
  // install_failed, and left the symlink dangling at a deleted 2.1.220 for
  // ~12min. Every agent that respawned in that window exec'd a symlink to
  // nothing: node-pty assigns a pid, then exit 1 with zero output. The daemon
  // read that as an agent crash — boss burned 8, analyst hit 10 and HALTED.
  // Pinning the updater off is the prevention half; agent-process.ts's
  // binary-unavailable exemption is the resilience half.
  function baseEnvFor(config: any): Record<string, string> {
    const pty = new AgentPTY(mockEnv, config);
    return (pty as unknown as { getBaseEnv(): Record<string, string> }).getBaseEnv();
  }

  it('sets DISABLE_AUTOUPDATER=1 so agents never race on the shared binary', () => {
    expect(baseEnvFor({})['DISABLE_AUTOUPDATER']).toBe('1');
  });
});

describe('applyEnvAssignment (PATH prepend, not overwrite)', () => {
  // .env files here are read with readFileSync + a literal split on the
  // first "=" — there is no shell involved, so a line like
  // PATH="/dir:$PATH" can never expand $PATH. This function is what makes
  // a bare `PATH=/dir` line in an org secrets.env / agent .env mean
  // "prepend /dir to whatever PATH already is", instead of replacing the
  // whole thing (which would break every other binary lookup for that
  // agent — node, git, homebrew, etc. all live on the base PATH).
  it('prepends PATH onto an existing value instead of replacing it', () => {
    const ptyEnv: Record<string, string> = { PATH: '/usr/bin:/bin' };
    applyEnvAssignment(ptyEnv, 'PATH', '/opt/gh-shim');
    expect(ptyEnv.PATH).toBe('/opt/gh-shim:/usr/bin:/bin');
  });

  it('sets PATH directly when no base PATH exists yet', () => {
    const ptyEnv: Record<string, string> = {};
    applyEnvAssignment(ptyEnv, 'PATH', '/opt/gh-shim');
    expect(ptyEnv.PATH).toBe('/opt/gh-shim');
  });

  it('overwrites (not prepends) every other key, unchanged from prior behavior', () => {
    const ptyEnv: Record<string, string> = { BOT_TOKEN: 'old' };
    applyEnvAssignment(ptyEnv, 'BOT_TOKEN', 'new');
    expect(ptyEnv.BOT_TOKEN).toBe('new');
  });
});

describe('buildPtyEnv (.env-driven PATH prepend, end to end)', () => {
  function ptyEnvFor(
    config: any,
    files: Record<string, string>,
  ): Record<string, string> {
    vi.mocked(existsSync).mockImplementation((p) => Object.hasOwn(files, String(p)));
    vi.mocked(readFileSync).mockImplementation(((p: string) => files[String(p)] ?? '') as any);
    const pty = new AgentPTY(mockEnv, config);
    return (pty as unknown as { buildPtyEnv(): Record<string, string> }).buildPtyEnv();
  }

  afterEach(() => {
    vi.mocked(existsSync).mockReset().mockReturnValue(false);
    vi.mocked(readFileSync).mockReset();
  });

  it('prepends a gh-shim-style PATH line from the agent .env onto the base PATH', () => {
    const basePath = process.env.PATH ?? '';
    const env = ptyEnvFor({}, {
      '/tmp/fw/orgs/acme/agents/alice/.env': 'PATH=/opt/gh-shim\nBOT_TOKEN=xyz\n',
    });
    expect(env.PATH).toBe(`/opt/gh-shim:${basePath}`);
    expect(env.BOT_TOKEN).toBe('xyz');
  });

  it('agent .env PATH prepends onto (not replaces) an org secrets.env PATH prepend', () => {
    const basePath = process.env.PATH ?? '';
    const env = ptyEnvFor({}, {
      '/tmp/fw/orgs/acme/secrets.env': 'PATH=/opt/org-wide-shim\n',
      '/tmp/fw/orgs/acme/agents/alice/.env': 'PATH=/opt/gh-shim\n',
    });
    expect(env.PATH).toBe(`/opt/gh-shim:/opt/org-wide-shim:${basePath}`);
  });
});
