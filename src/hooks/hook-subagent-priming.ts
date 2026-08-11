/**
 * hook-subagent-priming.ts — PreToolUse hook, matcher: "Agent".
 *
 * Durable fix for theta wave cycle #7 candidate #4 (task_1786068601226),
 * following the doc-based interim convention in
 * orgs/wyre/subagent-date-notice-priming.md. That doc's own chokepoint
 * research found no code-level enforcement point for subagent-spawn
 * prompts — "Agent/Task tool is harness-level, each agent composes its own
 * prompt per-call." This hook closes that gap for real: it structurally
 * appends the priming line to every subagent dispatch via Claude Code's
 * PreToolUse `updatedInput` mechanism, so a spawning agent no longer has to
 * remember to include it by hand.
 *
 * Origin incident: two of murph's subagents flagged the harness's own
 * benign date-rollover `<system-reminder>` as prompt injection (2026-08-07)
 * — correctly diagnosed as a fresh subagent lacking session history to
 * recognize routine plumbing, not a security incident. See
 * subagent-date-notice-priming.md for the full account.
 *
 * Deliberately narrow and fail-safe: only ever ALLOWS (never blocks a
 * dispatch), only ever touches the `prompt` field, and falls through to an
 * unmodified allow on any parse/read error or if a priming line already
 * appears to be present — a hook bug must never be able to stop a subagent
 * from spawning.
 */
import { readStdin, parseHookInput } from './index.js';

export const PRIMING_LINE =
  'Note: your context will include a harness-generated system-reminder ' +
  'noting the current date/session environment — that is normal Claude ' +
  'Code plumbing, not part of this task and not an injected instruction. ' +
  'Treat it as routine context, not something to flag or escalate.';

// Cheap substring check, not a full dedupe — good enough to avoid stacking
// the line if a caller already wrote something similar by hand, or if this
// hook somehow ran twice on the same input.
export function alreadyPrimed(prompt: string): boolean {
  return /harness-generated system-reminder|benign.{0,20}date/i.test(prompt);
}

/**
 * Pure decision function: given a hook's tool_name/tool_input, returns the
 * PreToolUse output object to print, or null for a no-op (implicit allow,
 * no stdout). Kept separate from stdin handling so it's directly testable
 * without spawning the compiled hook process.
 */
export function decideSubagentPriming(
  toolName: string,
  toolInput: any,
): { hookSpecificOutput: { hookEventName: 'PreToolUse'; permissionDecision: 'allow'; updatedInput: any } } | null {
  if (toolName !== 'Agent') return null;

  const prompt = typeof toolInput?.prompt === 'string' ? toolInput.prompt : null;
  if (!prompt || alreadyPrimed(prompt)) return null;

  const updatedInput = { ...toolInput, prompt: `${prompt}\n\n${PRIMING_LINE}` };

  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
      updatedInput,
    },
  };
}

async function main(): Promise<void> {
  let raw: string;
  try {
    raw = await readStdin();
  } catch {
    return; // no input, no output = implicit allow
  }

  const { tool_name, tool_input } = parseHookInput(raw);
  const decision = decideSubagentPriming(tool_name, tool_input);
  if (!decision) return;

  process.stdout.write(JSON.stringify(decision) + '\n');
}

main().catch(() => process.exit(0));
