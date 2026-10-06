import { Command } from 'commander';
import { SlackAPI, loadSlackConfig, type PostMessageRequest } from '../slack/index.js';

export interface TestSendOptions {
  frameworkRoot: string;
  org: string;
  agent?: string;
  channel: string;
  text: string;
}

/**
 * Pure function — testable without process exit.
 *
 * `--as <agent>` (opts.agent) is a SELF-IDENTITY ASSERTION, not a source of
 * posting identity (task_1790871245210_64848240's identity-gate hardening —
 * see src/slack/api.ts's RUNTIME_AGENT_NAME docblock for the finding this
 * closes). It is checked against the calling process's own CTX_AGENT_NAME
 * and the send is REFUSED on a mismatch — fail closed, not a logged warning
 * (this fleet's own "a refusing guard beats a warning one" rule, CLAUDE.md
 * 2026-08-17) — because a mismatch here is exactly the shape of one agent
 * trying to post under another's name. When CTX_AGENT_NAME is unset (a
 * human operator running this CLI directly, outside any agent's process
 * context) the check does not apply: there is no runtime identity to
 * protect in that case, and the human already has the filesystem access
 * this check would otherwise be guarding.
 *
 * The flag still requires the named agent to have a slack.json (same
 * Slack-enabled check as before), but no longer reads display_name/icon
 * fields from it — the actual posted username is always SlackAPI's own
 * RUNTIME_AGENT_NAME, sourced from the process's own environment, never
 * from a file.
 */
export async function runTestSend(opts: TestSendOptions, api: SlackAPI): Promise<void> {
  const req: PostMessageRequest = { channel: opts.channel, text: opts.text };
  if (opts.agent) {
    const runtimeAgent = process.env.CTX_AGENT_NAME?.trim();
    if (runtimeAgent && runtimeAgent !== opts.agent) {
      throw new Error(
        `refusing to send --as "${opts.agent}": this process is running as "${runtimeAgent}". ` +
          `An agent may only post under its own identity.`,
      );
    }
    const cfg = loadSlackConfig(opts.frameworkRoot, opts.org, opts.agent);
    if (!cfg) throw new Error(`agent "${opts.agent}" has no slack.json (not Slack-enabled)`);
  }
  await api.postMessage(req);
}

function requireToken(): string {
  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) {
    console.error('SLACK_BOT_TOKEN not set. SP3a runbook covers the setup.');
    process.exit(1);
  }
  return token;
}

const testSendCommand = new Command('test-send')
  .argument('<channel>', 'Slack channel id (Cxxx) or name (#general)')
  .argument('<text>', 'Message text')
  .option('--as <agent>', 'Post under this agent\'s identity (loads slack.json)')
  .option('--org <org>', 'Org', 'wyre')
  .description('Post a test message to a Slack channel')
  .action(async (channel: string, text: string, options: { as?: string; org: string }) => {
    const api = new SlackAPI(requireToken());
    const frameworkRoot =
      process.env.CTX_FRAMEWORK_ROOT || process.env.CTX_PROJECT_ROOT || process.cwd();
    try {
      await runTestSend({ frameworkRoot, org: options.org, agent: options.as, channel, text }, api);
      console.log('sent');
    } catch (err) {
      console.error(`Error: ${(err as Error).message}`);
      process.exit(1);
    }
  });

// Stable command name the SP3b injected "Reply using:" line invokes. Shares
// runTestSend's implementation with test-send (same shape, same identity
// threading via --as) — this is the one operators/agents should treat as
// the standing reply path; test-send remains for ad-hoc manual testing.
const sendCommand = new Command('send')
  .argument('<channel>', 'Slack channel id (Cxxx) or name (#general)')
  .argument('<text>', 'Message text')
  .option('--as <agent>', 'Post under this agent\'s identity (loads slack.json)')
  .option('--org <org>', 'Org', 'wyre')
  .description('Send a Slack message (used by the SP3b inbound reply path)')
  .action(async (channel: string, text: string, options: { as?: string; org: string }) => {
    const api = new SlackAPI(requireToken());
    const frameworkRoot =
      process.env.CTX_FRAMEWORK_ROOT || process.env.CTX_PROJECT_ROOT || process.cwd();
    try {
      await runTestSend({ frameworkRoot, org: options.org, agent: options.as, channel, text }, api);
      console.log('sent');
    } catch (err) {
      console.error(`Error: ${(err as Error).message}`);
      process.exit(1);
    }
  });

const discoverChannelsCommand = new Command('discover-channels')
  .description('List Slack channels the bot is a member of (with ids)')
  .action(async () => {
    const api = new SlackAPI(requireToken());
    const channels = await api.listChannels();
    const visible = channels.filter((c) => c.is_member !== false);
    for (const c of visible) {
      const prefix = c.is_private ? '🔒' : '#';
      console.log(`${c.id}\t${prefix}${c.name}`);
    }
  });

export const slackCommand = new Command('slack')
  .description('Slack adapter ops')
  .addCommand(testSendCommand)
  .addCommand(sendCommand)
  .addCommand(discoverChannelsCommand);
