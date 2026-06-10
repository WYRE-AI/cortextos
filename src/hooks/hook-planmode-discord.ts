/**
 * hook-planmode-discord.ts - ExitPlanMode PermissionRequest hook (orchestrator-scoped)
 * Mirrors hook-planmode-telegram.ts: reads the plan file, posts it to the
 * Discord orchestrator channel, and polls for an approve/deny response file.
 * Timeout: 1800s (30 min), auto-APPROVES so agents aren't blocked if user is away.
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
  cleanupResponseFile,
} from './index';
import { join, resolve, sep } from 'path';
import { mkdirSync, readFileSync, existsSync, readdirSync, statSync } from 'fs';
import { homedir } from 'os';

/** Only paths inside ~/.claude/plans/ may be read — hook input is untrusted. */
function isAllowedPlanPath(planPath: string): boolean {
  const plansDir = resolve(join(homedir(), '.claude', 'plans'));
  return resolve(planPath).startsWith(plansDir + sep);
}

/** Find the most recent plan file in ~/.claude/plans/ (mirrors the TG hook). */
function findMostRecentPlan(): string | null {
  const plansDir = join(homedir(), '.claude', 'plans');
  if (!existsSync(plansDir)) return null;
  try {
    const files = readdirSync(plansDir)
      .filter((f) => f.endsWith('.md'))
      .map((f) => ({ path: join(plansDir, f), mtime: statSync(join(plansDir, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    return files.length > 0 ? files[0].path : null;
  } catch {
    return null;
  }
}

function readPlanContent(planPath: string): string {
  try {
    return readFileSync(planPath, 'utf-8').split('\n').slice(0, 100).join('\n');
  } catch {
    return '';
  }
}

async function main(): Promise<void> {
  const input = await readStdin();
  const { tool_input } = parseHookInput(input);

  const env = loadEnv();
  const config = loadDiscordConfig();

  if (!config) {
    outputDecision('allow');
    return;
  }

  let planPath = tool_input.plan_file || '';
  if (planPath && !isAllowedPlanPath(planPath)) planPath = '';
  if (!planPath) planPath = findMostRecentPlan() || '';

  let planContent = '';
  if (planPath && existsSync(planPath)) planContent = readPlanContent(planPath);
  if (!planContent) planContent = '(Plan file not found or empty)';

  const uniqueId = generateId();
  mkdirSync(env.stateDir, { recursive: true });
  const responseFile = join(env.stateDir, `hook-response-${uniqueId}.json`);

  const cleanup = () => cleanupResponseFile(responseFile);
  process.on('exit', cleanup);
  process.on('SIGTERM', () => { cleanup(); process.exit(1); });
  process.on('SIGINT', () => { cleanup(); process.exit(1); });

  const message = truncateForDiscord(
    `PLAN REVIEW - ${env.agentName}\nID: ${uniqueId}\n\n${planContent}\n\n` +
      `Reply 'approve ${uniqueId}' or 'deny ${uniqueId}'.`,
  );
  const api = new DiscordRestAPI(config.botToken);

  try {
    await api.createMessage({ channel: config.orchChannelId, content: message });
  } catch {
    // If send fails, auto-approve so agent isn't blocked
    outputDecision('allow');
    return;
  }

  const TIMEOUT_MS = 1800 * 1000;
  const content = await waitForResponseFile(responseFile, TIMEOUT_MS);

  if (content !== null) {
    try {
      const response = JSON.parse(content);
      const decision = response.decision || 'deny';
      if (decision === 'allow') {
        outputDecision('allow');
      } else {
        outputDecision('deny', 'Plan denied by user via Discord. Ask what they want to change.');
      }
    } catch {
      outputDecision('allow');
    }
  } else {
    try {
      await api.createMessage({
        channel: config.orchChannelId,
        content: `Plan review TIMED OUT (auto-approved): ${env.agentName}`,
      });
    } catch {
      /* ignore notification failure */
    }
    outputDecision('allow');
  }
}

main().catch((err) => {
  process.stderr.write(`hook-planmode-discord error: ${err}\n`);
  outputDecision('allow');
});
