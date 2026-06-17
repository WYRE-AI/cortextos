/**
 * hook-permission-discord.ts - Blocking PermissionRequest hook (orchestrator-scoped)
 * Mirrors hook-permission-telegram.ts: forwards permission prompts to the
 * Discord orchestrator channel, then polls for a response file written when the
 * user approves/denies. Timeout: 1800s (30 min, deny by default).
 *
 * The Discord interaction handler that writes hook-response-<id>.json is the
 * deferred inbound-parity piece (mirrors Telegram's fast-checker inline-button
 * handling). Until it lands the hook degrades safely (deny on timeout).
 */

import { DiscordRestAPI } from '../discord/rest';
import { loadDiscordConfig } from '../discord/config';
import { truncateForDiscord } from '../discord/normalize';
import {
  readStdin,
  parseHookInput,
  loadEnv,
  outputDecision,
  generateId,
  waitForResponseFile,
  formatToolSummary,
  isClaudeDirOperation,
  sanitizeCodeBlock,
  cleanupResponseFile,
} from './index';
import { join } from 'path';
import { mkdirSync } from 'fs';

async function main(): Promise<void> {
  const input = await readStdin();
  const { tool_name, tool_input } = parseHookInput(input);

  // Short-circuit cases that don't need env/config loading on the hot path:
  // ExitPlanMode and AskUserQuestion are handled by other hooks; .claude/
  // directory writes are auto-approved.
  if (tool_name === 'ExitPlanMode' || tool_name === 'AskUserQuestion') {
    process.exit(0);
  }
  if (isClaudeDirOperation(tool_name, tool_input)) {
    outputDecision('allow');
    return;
  }

  // loadEnv() loads the agent .env into process.env (side effect) and gives us
  // agentName/stateDir; loadDiscordConfig() then reads the Discord creds.
  const env = loadEnv();
  const config = loadDiscordConfig();

  if (!config) {
    outputDecision('deny', 'No Discord credentials configured for remote approval');
    return;
  }

  const summary = formatToolSummary(tool_name, tool_input);

  const uniqueId = generateId();
  mkdirSync(env.stateDir, { recursive: true });
  const responseFile = join(env.stateDir, `hook-response-${uniqueId}.json`);

  const cleanup = () => cleanupResponseFile(responseFile);
  process.on('exit', cleanup);
  process.on('SIGTERM', () => { cleanup(); process.exit(1); });
  process.on('SIGINT', () => { cleanup(); process.exit(1); });

  const message = truncateForDiscord(
    `PERMISSION REQUEST\nAgent: ${env.agentName}\nTool: ${tool_name}\nID: ${uniqueId}\n\n` +
      '```\n' +
      sanitizeCodeBlock(summary) +
      '\n```\n\n' +
      `Reply 'approve ${uniqueId}' or 'deny ${uniqueId}'.`,
  );

  const api = new DiscordRestAPI(config.botToken);

  try {
    await api.createMessage({ channel: config.orchChannelId, content: message });
  } catch {
    outputDecision('deny', 'Failed to send permission request to Discord');
    return;
  }

  const TIMEOUT_MS = 1800 * 1000;
  const content = await waitForResponseFile(responseFile, TIMEOUT_MS);

  if (content !== null) {
    try {
      if (JSON.parse(content).decision === 'allow') {
        outputDecision('allow');
      } else {
        outputDecision('deny', 'Denied by user via Discord');
      }
    } catch {
      outputDecision('deny', 'Invalid response file');
    }
  } else {
    await api
      .createMessage({
        channel: config.orchChannelId,
        content: `Permission request TIMED OUT (auto-denied): ${tool_name}`,
      })
      .catch(() => { /* ignore notification failure */ });
    outputDecision('deny', 'Timed out waiting for Discord approval (30m)');
  }
}

main().catch((err) => {
  process.stderr.write(`hook-permission-discord error: ${err}\n`);
  outputDecision('deny', `Hook error: ${err}`);
});
