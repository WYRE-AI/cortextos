import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { loadSlackConfig, isSlackUserAllowed, slackIdentityKey, type SlackConfig } from '../../../src/slack/identity';

function makeAgent(root: string, name: string, slackJson?: object): string {
  const dir = join(root, 'orgs', 'wyre', 'agents', name);
  mkdirSync(dir, { recursive: true });
  if (slackJson) writeFileSync(join(dir, 'slack.json'), JSON.stringify(slackJson));
  return dir;
}

// loadSlackIdentity was removed as part of the identity-gate hardening
// (task_1790871245210_64848240) — it turned a file's display_name into a
// chat.postMessage username with no check that the caller was the agent it
// claimed to be. See src/slack/api.ts's RUNTIME_AGENT_NAME for the
// replacement: the posted identity now always comes from the calling
// process's own environment, never from a file. loadSlackConfig (below)
// remains the correct way to check whether an agent is Slack-enabled.
describe('loadSlackConfig', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'sp3a-id-'));
  });

  it('returns the parsed config from slack.json', () => {
    makeAgent(root, 'boss', {
      display_name: 'boss',
      channels: { recap: 'C01' },
      allowed_channels: ['C01'],
      allowed_users: ['T1:U1'],
    });
    const cfg = loadSlackConfig(root, 'wyre', 'boss');
    expect(cfg?.allowed_channels).toEqual(['C01']);
  });

  it('returns null when slack.json is absent (agent is Slack-disabled)', () => {
    makeAgent(root, 'dev'); // no slack.json
    expect(loadSlackConfig(root, 'wyre', 'dev')).toBeNull();
  });

  it('resolves namespaced agent (engineer/agent)', () => {
    const nsDir = join(root, 'orgs', 'wyre', 'engineers', 'aaron', 'agents', 'dev');
    mkdirSync(nsDir, { recursive: true });
    writeFileSync(
      join(nsDir, 'slack.json'),
      JSON.stringify({ channels: {}, allowed_channels: ['C9'], allowed_users: [] }),
    );
    const cfg = loadSlackConfig(root, 'wyre', 'aaron/dev');
    expect(cfg?.allowed_channels).toEqual(['C9']);
  });
});

describe('slackIdentityKey', () => {
  it('composes team_id and user_id into a single key', () => {
    expect(slackIdentityKey('T123', 'U456')).toBe('T123:U456');
  });

  it('does not collide across teams for the same user_id (the bug the composite key prevents)', () => {
    expect(slackIdentityKey('T-A', 'U-SAME')).not.toBe(slackIdentityKey('T-B', 'U-SAME'));
  });
});

describe('isSlackUserAllowed', () => {
  const baseConfig: SlackConfig = {
    display_name: 'test',
    channels: {},
    allowed_channels: ['C1'],
    allowed_users: ['T1:U1', 'T1:U2'],
  };

  it('true for a team_id+user_id pair in allowed_users', () => {
    expect(isSlackUserAllowed(baseConfig, 'T1', 'U1')).toBe(true);
  });

  it('false for a user_id not in allowed_users', () => {
    expect(isSlackUserAllowed(baseConfig, 'T1', 'U999')).toBe(false);
  });

  it('false when the user_id matches but the team_id does not (cross-workspace collision guard)', () => {
    expect(isSlackUserAllowed(baseConfig, 'T-OTHER', 'U1')).toBe(false);
  });

  it('fail-closed: false when allowed_users is empty', () => {
    expect(isSlackUserAllowed({ ...baseConfig, allowed_users: [] }, 'T1', 'U1')).toBe(false);
  });

  it('fail-closed: false when allowed_users is missing entirely', () => {
    const cfg = { ...baseConfig } as Partial<SlackConfig>;
    delete cfg.allowed_users;
    expect(isSlackUserAllowed(cfg as SlackConfig, 'T1', 'U1')).toBe(false);
  });
});
