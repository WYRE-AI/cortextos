/**
 * hook-ask-discord.ts - Non-blocking PreToolUse hook for AskUserQuestion
 * (orchestrator-scoped). Mirrors hook-ask-telegram.ts: posts the first
 * question to the Discord orchestrator channel, saves an ask-state.json (same
 * schema as the Telegram hook), and exits immediately. A Discord interaction
 * handler navigates multi-question flows (deferred inbound-parity piece —
 * mirrors Telegram's fast-checker).
 *
 * Discord has no inline-keyboard callbacks routed through the daemon yet, so
 * options render as a numbered list (formatQuestionMessage already does this)
 * and the user replies with the option number(s).
 */

import { DiscordRestAPI } from '../discord/rest';
import { loadDiscordConfig } from '../discord/config';
import { truncateForDiscord } from '../discord/normalize';
import {
  readStdin,
  parseHookInput,
  loadEnv,
  buildAskState,
  formatQuestionMessage,
} from './index';
import { writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';

async function main(): Promise<void> {
  const input = await readStdin();
  const { tool_input } = parseHookInput(input);

  const questions = tool_input.questions || [];
  if (questions.length === 0) {
    process.exit(0);
  }

  const env = loadEnv();
  const config = loadDiscordConfig();

  if (!config) {
    process.exit(0);
  }

  // Save state file for the interaction handler.
  mkdirSync(env.stateDir, { recursive: true });
  const stateFile = join(env.stateDir, 'ask-state.json');
  const state = buildAskState(questions) as Record<string, unknown>;
  state.channel = 'discord';
  writeFileSync(stateFile, JSON.stringify(state), 'utf-8');

  // Post the first question (numbered options as text).
  const q = questions[0];
  const messageText = truncateForDiscord(
    formatQuestionMessage(env.agentName, 0, questions.length, q),
  );

  const api = new DiscordRestAPI(config.botToken);

  try {
    await api.createMessage({ channel: config.orchChannelId, content: messageText });
  } catch {
    // Non-blocking - exit even on send failure
  }

  process.exit(0);
}

main().catch((err) => {
  process.stderr.write(`hook-ask-discord error: ${err}\n`);
  process.exit(0);
});
