/**
 * hook-loop-detector.ts — PreToolUse hook.
 *
 * Detects and blocks repeated tool loops:
 * 1. Same tool and same args too many times.
 * 2. Two tools ping-ponging repeatedly.
 *
 * Blocked calls are NOT recorded in history — the original design counted
 * rejections toward the alternation window, which made the wedge
 * self-perpetuating. The current design only records calls that pass.
 *
 * History is also time-windowed: entries older than {HISTORY_RETAIN_MS}
 * are filtered out before each decision. This prevents a stale prior-session
 * tail (which persists in the on-disk state file) from blocking the first
 * tool call of a new session.
 *
 * After {EMERGENCY_ESCAPE_MS} of being continuously blocked, the next
 * incoming call is allowed exactly once so the agent can send a Telegram
 * alert. Subsequent calls keep blocking until the workflow itself changes
 * (the next allowed call resets the blocked-window state).
 *
 * State: {ctxRoot}/state/{agentName}/loop-detector.json
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { createHash } from 'crypto';
import { execFile } from 'child_process';
import { readStdin, parseHookInput } from './index.js';

export const HISTORY_SIZE = 30;
export const REPETITION_BLOCK = 15;
export const PINGPONG_WINDOW = 12;
export const PINGPONG_BLOCK = 24;
export const PINGPONG_DOMINANCE = 0.8;
export const EMERGENCY_ESCAPE_MS = 30 * 60 * 1000;
// Entries older than this fall out of the active window. Without this,
// alternation history persists across session restarts and the first
// tool call after boot trips ping-pong against stale prior-session state.
// Real loops fire fast (sub-second per call), so 60s is plenty of room
// to detect them while letting any normal idle gap clear stale history.
export const HISTORY_RETAIN_MS = 60 * 1000;

export interface ToolCallRecord {
  toolName: string;
  argsHash: string;
  ts: number;
}

export interface LoopDetectorState {
  history: ToolCallRecord[];
  firstBlockedAt?: number | null;
  emergencyEscapeUsed?: boolean;
}

function sortObjectKeys(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(sortObjectKeys);
  const obj = value as Record<string, unknown>;
  return Object.keys(obj)
    .sort()
    .reduce<Record<string, unknown>>((acc, k) => {
      acc[k] = sortObjectKeys(obj[k]);
      return acc;
    }, {});
}

export function hashArgs(toolInput: unknown): string {
  if (toolInput === null || toolInput === undefined) return '';
  try {
    const normalized = JSON.stringify(sortObjectKeys(toolInput));
    return createHash('sha256').update(normalized).digest('hex').slice(0, 16);
  } catch {
    return '';
  }
}

function statePath(stateDir: string): string {
  return join(stateDir, 'loop-detector.json');
}

export function loadState(stateDir: string): LoopDetectorState {
  const p = statePath(stateDir);
  if (!existsSync(p)) return { history: [], firstBlockedAt: null, emergencyEscapeUsed: false };
  try {
    const parsed = JSON.parse(readFileSync(p, 'utf-8')) as Partial<LoopDetectorState>;
    const rawHistory = Array.isArray(parsed.history) ? parsed.history : [];
    const history: ToolCallRecord[] = rawHistory.filter(
      (r): r is ToolCallRecord =>
        r !== null &&
        typeof r === 'object' &&
        typeof (r as ToolCallRecord).toolName === 'string' &&
        typeof (r as ToolCallRecord).argsHash === 'string' &&
        typeof (r as ToolCallRecord).ts === 'number',
    );
    const firstBlockedAt =
      typeof parsed.firstBlockedAt === 'number' ? parsed.firstBlockedAt : null;
    const emergencyEscapeUsed =
      typeof parsed.emergencyEscapeUsed === 'boolean' ? parsed.emergencyEscapeUsed : false;
    return { history, firstBlockedAt, emergencyEscapeUsed };
  } catch {
    return { history: [], firstBlockedAt: null, emergencyEscapeUsed: false };
  }
}

function saveState(stateDir: string, state: LoopDetectorState): void {
  try {
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(statePath(stateDir), JSON.stringify(state, null, 2) + '\n', 'utf-8');
  } catch {
    // Best-effort; never break a hook.
  }
}

export function countRepetitions(
  history: ToolCallRecord[],
  toolName: string,
  argsHash: string,
): number {
  return history.filter(r => r.toolName === toolName && r.argsHash === argsHash).length;
}

export function detectPingPong(history: ToolCallRecord[]): {
  count: number;
  tools: [string, string] | null;
} {
  if (history.length < PINGPONG_WINDOW) return { count: 0, tools: null };

  const window = history.slice(-PINGPONG_WINDOW);
  const freq: Record<string, number> = {};
  for (const r of window) {
    freq[r.toolName] = (freq[r.toolName] ?? 0) + 1;
  }

  const sorted = Object.entries(freq).sort((a, b) => b[1] - a[1]);
  if (sorted.length < 2) return { count: 0, tools: null };

  const [topTool, topCount] = sorted[0];
  const [secondTool, secondCount] = sorted[1];
  const combinedFraction = (topCount + secondCount) / PINGPONG_WINDOW;
  if (combinedFraction < PINGPONG_DOMINANCE) return { count: 0, tools: null };

  const pairSet = new Set([topTool, secondTool]);
  const pairCalls = history.filter(r => pairSet.has(r.toolName));
  let alternations = 0;
  for (let i = 1; i < pairCalls.length; i += 1) {
    if (pairCalls[i].toolName !== pairCalls[i - 1].toolName) {
      alternations += 1;
    }
  }

  return {
    count: alternations,
    tools: [topTool, secondTool],
  };
}

function blockCall(reason: string): void {
  process.stdout.write(JSON.stringify({ decision: 'block', reason }) + '\n');
  process.exit(0);
}

/**
 * Alert the org's orchestrator agent directly via `cortextos bus send-message`,
 * fire-and-forget — mirrors hook-crash-alert.ts's notifyAgents() pattern (same
 * PATH-hardened execFile approach: PM2's spawned daemon doesn't inherit the
 * npm-link target, so a bare 'cortextos' can ENOENT — see that function's
 * comment). Best-effort: any failure is swallowed so a notify miss never
 * crashes the hook.
 *
 * Reads CTX_ORCHESTRATOR_AGENT (set on the PTY env from the org's
 * context.json — see agent-pty.ts) rather than a hardcoded recipient name,
 * so this works across orgs with differently-named orchestrators. No-ops if
 * unset (context.json missing/malformed) or if the orchestrator IS this
 * agent (an orchestrator alerting itself is a no-op, not a bug).
 *
 * This closes task_1785591582468's HARD PRE-ACTIVATION GATE for PR #55: the
 * emergency-escape alert previously only reached stderr (visible to no one
 * unless the stuck agent itself happened to notice and self-report). Wiring
 * it to the orchestrator's bus inbox means a human gets paged even when the
 * looping agent can't help itself. See hang-detector.ts's file-header
 * comment for the full masking analysis this closes path (a) of.
 */
export function notifyOrchestrator(agentName: string, message: string): void {
  const orchestrator = process.env.CTX_ORCHESTRATOR_AGENT;
  if (!orchestrator || orchestrator === agentName) return;
  const body = `[loop-detector] ${agentName} is stuck in a blocked tool-call loop — ${message}`;
  const frameworkRoot = process.env.CTX_FRAMEWORK_ROOT;
  const cliPath = frameworkRoot ? join(frameworkRoot, 'dist', 'cli.js') : null;
  try {
    if (cliPath) {
      execFile(
        process.execPath,
        [cliPath, 'bus', 'send-message', orchestrator, 'high', body],
        { timeout: 10_000 },
        () => { /* fire-and-forget */ },
      );
    } else {
      execFile(
        'cortextos',
        ['bus', 'send-message', orchestrator, 'high', body],
        { timeout: 10_000 },
        () => { /* fire-and-forget */ },
      );
    }
  } catch { /* best-effort, never throw */ }
}

export type HookAction = 'allow' | 'block' | 'escape';

export interface HookDecision {
  action: HookAction;
  nextState: LoopDetectorState;
  reason?: string;
  alertMessage?: string;
}

/**
 * Decide what to do with the next tool call.
 *
 * Pure: takes current state + the incoming call + a now timestamp, returns
 * the next state and the action ('allow' | 'block' | 'escape'). Never reads
 * stdin or fs and never exits the process — the actual hook entry-point
 * orchestrates I/O around this function.
 *
 * State machine:
 *   - allow → push call to history, reset firstBlockedAt and emergencyEscapeUsed.
 *   - block → keep history unchanged, set firstBlockedAt if not already set.
 *   - escape → keep history unchanged, set emergencyEscapeUsed. Granted exactly
 *              once per blocked window after EMERGENCY_ESCAPE_MS elapsed since
 *              firstBlockedAt. The next allowed call clears the window cleanly.
 */
export function decideHookAction(
  state: LoopDetectorState,
  toolName: string,
  argsHash: string,
  now: number,
): HookDecision {
  const recentHistory = state.history.filter(r => now - r.ts <= HISTORY_RETAIN_MS);
  const newRecord: ToolCallRecord = { toolName, argsHash, ts: now };
  const hypothetical = [...recentHistory, newRecord].slice(-HISTORY_SIZE);

  const reps = countRepetitions(hypothetical, toolName, argsHash);
  const pp = detectPingPong(hypothetical);
  const wouldBlockReason: string | null =
    reps >= REPETITION_BLOCK
      ? `Tool loop detected: "${toolName}" called ${reps} times with identical arguments in the last ${HISTORY_SIZE} calls. Stop repeating this action and try a fundamentally different approach.`
      : pp.count >= PINGPONG_BLOCK && pp.tools
        ? `Tool loop detected: "${pp.tools[0]}" and "${pp.tools[1]}" are alternating repeatedly (${pp.count} alternations in the last ${hypothetical.length} calls). Stop this back-and-forth pattern and try a fundamentally different approach.`
        : null;

  if (wouldBlockReason === null) {
    return {
      action: 'allow',
      nextState: {
        history: hypothetical,
        firstBlockedAt: null,
        emergencyEscapeUsed: false,
      },
    };
  }

  const firstBlockedAt = state.firstBlockedAt ?? now;
  const blockedDurationMs = now - firstBlockedAt;
  const emergencyEscapeUsed = state.emergencyEscapeUsed === true;
  const escapeAvailable =
    blockedDurationMs >= EMERGENCY_ESCAPE_MS && !emergencyEscapeUsed;

  if (escapeAvailable) {
    const minutesBlocked = Math.floor(blockedDurationMs / 60000);
    return {
      action: 'escape',
      nextState: {
        history: recentHistory,
        firstBlockedAt,
        emergencyEscapeUsed: true,
      },
      alertMessage: `[hook-loop-detector] Emergency escape granted after ${minutesBlocked} min blocked. One tool call allowed; subsequent calls will block again until the workflow itself changes.`,
    };
  }

  return {
    action: 'block',
    nextState: {
      history: recentHistory,
      firstBlockedAt,
      emergencyEscapeUsed,
    },
    reason: wouldBlockReason,
  };
}

async function main(): Promise<void> {
  const input = await readStdin();
  const { tool_name, tool_input } = parseHookInput(input);

  const agentName = process.env.CTX_AGENT_NAME || '';
  const ctxRoot = process.env.CTX_ROOT || join(homedir(), '.cortextos', 'default');
  const stateDir = join(ctxRoot, 'state', agentName);

  const state = loadState(stateDir);
  const argsHash = hashArgs(tool_input);
  const decision = decideHookAction(state, tool_name, argsHash, Date.now());

  saveState(stateDir, decision.nextState);

  if (decision.action === 'block' && decision.reason) {
    blockCall(decision.reason);
    return;
  }

  if (decision.action === 'escape' && decision.alertMessage) {
    process.stderr.write(decision.alertMessage + '\n');
    notifyOrchestrator(agentName, decision.alertMessage);
  }

  process.exit(0);
}

main().catch(() => process.exit(0));
