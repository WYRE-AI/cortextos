import { Command } from 'commander';
import { spawnSync, execFileSync } from 'child_process';
import { existsSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { resolveAgentDir, parseQualifiedName, discoverAllAgents } from '../utils/agent-dir.js';
import { sendMessage, checkInboxWithStatus, ackInbox } from '../bus/message.js';
import { sendToCapability } from '../bus/agents.js';
import { validateAgentName, validateTaskId, validatePriority, validateCapability } from '../utils/validate.js';
import { randomDigits } from '../utils/random.js';
import { resolveMessageBody, resolveOptionalTextField, UnsafeInlineBodyError } from '../utils/resolve-message-body.js';
import { createTask, updateTask, completeTask, claimTask, readTaskAudit, checkTaskDependenciesWithStatus, compactTasks, listTasks, checkStaleTasks, checkBatchStaleness, archiveTasks, checkHumanTasks } from '../bus/task.js';
import { saveOutput } from '../bus/save-output.js';
import { logEvent } from '../bus/event.js';
import { updateHeartbeat, readAllHeartbeats, readAllHeartbeatRows } from '../bus/heartbeat.js';
import { selfRestart, hardRestart, checkGoalStaleness, checkStaleBlockers, checkDeployDrift, COMMIT_LOG_LIMIT, postActivity, broadcastActivityViaBus } from '../bus/system.js';
import { createExperiment, runExperiment, evaluateExperiment, listExperiments, listAllExperiments, gatherContext, manageCycle, loadExperimentConfig, validateExperimentBaseline, linkExperimentApproval } from '../bus/experiment.js';
import { browseCatalog, installCommunityItem, prepareSubmission, submitCommunityItem } from '../bus/catalog.js';
import { collectMetrics, parseUsageOutput, storeUsageData, checkUpstream, collectTelegramCommands, registerTelegramCommands } from '../bus/metrics.js';
import { createApproval, updateApproval } from '../bus/approval.js';
import { createReminder, listReminders, ackReminder, pruneReminders } from '../bus/reminders.js';
import { updateCronFire, parseDurationMs, readCronState } from '../bus/cron-state.js';
import { addCron, removeCron, readCrons, updateCron as updateCronDef, getCronByName, getExecutionLog } from '../bus/crons.js';
import { nextFireFromCron, computeReferenceMs } from '../daemon/cron-scheduler.js';
import { queryKnowledgeBase, ingestKnowledgeBase, deleteFromKnowledgeBase, ensureKBDirs } from '../bus/knowledge-base.js';
import { checkUsageApi, refreshOAuthToken, rotateOAuth, loadAccounts, setActiveAccount, writeTokenToAgents, ALERT_5H, ALERT_7D } from '../bus/oauth.js';
import { loadRotationState } from '../daemon/rotation-manager.js';
import { mintInstallationToken, shouldRefuseInteractivePrint, redactForJson } from '../bus/github-app.js';
import { resolvePaths } from '../utils/paths.js';
import { resolveEnv, resolveTargetAgentDir } from '../utils/env.js';
import { IPCClient } from '../daemon/ipc-server.js';
import { TelegramAPI } from '../telegram/api.js';
import { logOutboundMessage, cacheLastSent } from '../telegram/logging.js';
import type { Priority, Task, TaskStatus, EventCategory, EventSeverity, ApprovalCategory, ApprovalStatus, OrgContext, CronDefinition } from '../types/index.js';

/**
 * Check if the org requires deliverables and the task has none attached.
 * Returns an error message if the transition should be blocked, or null if allowed.
 */
function checkDeliverableRequirement(taskId: string, frameworkRoot: string, org: string, taskDir: string): string | null {
  // Reject a traversal task id before it builds the task-file path below — this
  // runs ahead of updateTask/completeTask, so it can't rely on findTaskFile's guard.
  validateTaskId(taskId);
  // Read org context to check require_deliverables setting
  const contextPath = join(frameworkRoot, 'orgs', org, 'context.json');
  if (!existsSync(contextPath)) return null;

  let ctx: OrgContext;
  try {
    ctx = JSON.parse(readFileSync(contextPath, 'utf-8'));
  } catch (err) {
    // Allowing the transition is defensible — blocking every task in an org on
    // one corrupt file is worse.  Doing it silently is not: require_deliverables
    // enforcement turns OFF org-wide with no observable other than the absence
    // of an error nobody was expecting.
    console.warn(
      `[bus] org context ${contextPath} is unreadable or corrupt ` +
      `(${err instanceof Error ? err.message : String(err)}) — require_deliverables ` +
      `enforcement is SKIPPED for this transition.`
    );
    return null;
  }

  if (!ctx.require_deliverables) return null;

  // Check if the task has outputs
  const taskFile = join(taskDir, `${taskId}.json`);
  if (!existsSync(taskFile)) return null;

  let task: Task;
  try {
    task = JSON.parse(readFileSync(taskFile, 'utf-8'));
  } catch (err) {
    // Same fail-open direction, same reason to be loud about it.
    console.warn(
      `[bus] task file ${taskFile} is unreadable or corrupt ` +
      `(${err instanceof Error ? err.message : String(err)}) — require_deliverables ` +
      `check SKIPPED for ${taskId}.`
    );
    return null;
  }

  if (!task.outputs || task.outputs.length === 0) {
    return `Cannot submit task ${taskId}: require_deliverables is enabled but this task has no file deliverables attached. Use "cortextos bus save-output ${taskId} <file>" to attach a deliverable first.`;
  }

  return null;
}

/**
 * Shared preamble for `send-message` and `send-relay`: validate `priority`
 * against the fixed priority list and resolve the message body (inline arg,
 * "-"/stdin, or --body-file) with the same fail-closed handling both commands
 * need (2026-08-15 fleet incidents — see src/utils/resolve-message-body.ts:
 * an inline body containing a surviving backtick/$( is rejected loud rather
 * than sent with silently-substituted holes in it). Exits the process on
 * either failure, matching both commands' pre-existing behavior.
 */
function resolveSendPriorityAndBody(
  priority: string,
  text: string | undefined,
  opts: { bodyFile?: string },
): { priority: Priority; text: string } {
  const validPriorities: Priority[] = ['urgent', 'high', 'normal', 'low'];
  if (!validPriorities.includes(priority as Priority)) {
    console.error(`Invalid priority '${priority}'. Must be one of: ${validPriorities.join(', ')}`);
    process.exit(1);
  }
  let resolvedText: string;
  try {
    resolvedText = resolveMessageBody({ inlineText: text, bodyFile: opts.bodyFile });
  } catch (err) {
    if (err instanceof UnsafeInlineBodyError) {
      console.error(err.message);
      process.exit(1);
    }
    throw err;
  }
  return { priority: priority as Priority, text: resolvedText };
}

export const busCommand = new Command('bus')
  .description('Bus commands for agent messaging, tasks, and events');

busCommand
  .command('send-message')
  .argument('<to>', 'Target agent')
  .argument('<priority>', 'Message priority (urgent, high, normal, low)')
  .argument('[text]', 'Message text. Omit the argument, or pass "-", to read the body from stdin — the safe way to send a body containing backticks, $(, or apostrophes byte-identical.')
  .argument('[reply-to]', 'Reply to message ID (optional positional form)')
  .option('--reply-to <id>', 'Reply to message ID')
  .option('--body-file <path>', 'Read the message body from a file instead of the shell argument or stdin — the safe way to send a body containing backticks, $(, or apostrophes byte-identical')
  .action((to: string, priority: string, text: string | undefined, replyToArg: string | undefined, opts: { replyTo?: string; bodyFile?: string }) => {
    // Accept reply-to as either positional arg or --reply-to flag (P2 fix #9)
    const effectiveReplyTo = opts.replyTo ?? replyToArg;
    const resolved = resolveSendPriorityAndBody(priority, text, opts);
    // Security (H9): Validate agent name (bare or qualified) before any filesystem access.
    // parseQualifiedName accepts both "boss" and "aaron/dev" forms, validating each segment.
    try {
      parseQualifiedName(to);
    } catch (err) {
      console.error(String(err));
      process.exit(1);
    }

    const env = resolveEnv();
    const paths = resolvePaths(env.agentName, env.instanceId, env.org, env.ctxRoot);

    // Warn if target agent doesn't exist (check project dir).
    // For qualified names (engineer/agent) also look under engineers/*/agents/.
    const { existsSync } = require('fs');
    const { join } = require('path');
    const projectRoot = env.projectRoot || env.frameworkRoot || process.cwd();
    const orgsDir = join(projectRoot, 'orgs');
    let agentExists = false;
    if (existsSync(orgsDir)) {
      const { readdirSync } = require('fs');
      try {
        for (const org of readdirSync(orgsDir)) {
          if (existsSync(resolveAgentDir(projectRoot, org, to))) {
            agentExists = true;
            break;
          }
        }
      } catch { /* skip */ }
    }
    if (!agentExists) {
      console.error(`Warning: agent '${to}' not found in project. Message will be queued but may never be read.`);
    }

    const msgId = sendMessage(paths, env.agentName, to, resolved.priority, resolved.text, effectiveReplyTo);
    try {
      logEvent(paths, env.agentName, env.org, 'message', 'agent_message_sent', 'info', JSON.stringify({ to, priority: resolved.priority, msg_id: msgId, reply_to: effectiveReplyTo ?? null }), { refreshHeartbeat: true });
    } catch { /* non-fatal */ }
    console.log(msgId);
  });

busCommand
  .command('send-relay')
  .description('Fan a message out to every enabled agent tagged with a capability instead of addressing one hardcoded agent name. First recipient to run ack-inbox on it wins -- the other tagged agents\' pending copies get cancelled. Fix for the "angela-relay" single point of failure (task_1788300871646_92090539); modeled on Hermes\'s a2a_orchestrate(mode="first") (task_1788300304747_69074594).')
  .argument('<capability>', 'Capability tag (see "capabilities" in an agent\'s config.json) -- fans out to every enabled agent carrying this tag')
  .argument('<priority>', 'Message priority (urgent, high, normal, low)')
  .argument('[text]', 'Message text. Omit the argument, or pass "-", to read the body from stdin — the safe way to send a body containing backticks, $(, or apostrophes byte-identical.')
  .argument('[reply-to]', 'Reply to message ID (optional positional form)')
  .option('--reply-to <id>', 'Reply to message ID')
  .option('--body-file <path>', 'Read the message body from a file instead of the shell argument or stdin — the safe way to send a body containing backticks, $(, or apostrophes byte-identical')
  .action((capability: string, priority: string, text: string | undefined, replyToArg: string | undefined, opts: { replyTo?: string; bodyFile?: string }) => {
    const effectiveReplyTo = opts.replyTo ?? replyToArg;
    const resolved = resolveSendPriorityAndBody(priority, text, opts);
    try {
      validateCapability(capability);
    } catch (err) {
      console.error(String(err));
      process.exit(1);
    }

    const env = resolveEnv();
    const paths = resolvePaths(env.agentName, env.instanceId, env.org, env.ctxRoot);

    let result;
    try {
      result = sendToCapability(paths, env.agentName, env.org, capability, resolved.priority, resolved.text, effectiveReplyTo);
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
      return;
    }
    try {
      logEvent(paths, env.agentName, env.org, 'message', 'agent_relay_sent', 'info', JSON.stringify({
        capability,
        priority: resolved.priority,
        recipients: result.recipients,
        fanout_id: result.fanoutId,
        reply_to: effectiveReplyTo ?? null,
      }));
    } catch { /* non-fatal */ }
    console.log(JSON.stringify({ fanout_id: result.fanoutId, recipients: result.recipients, msg_ids: result.msgIds }));
  });

busCommand
  .command('check-inbox')
  .action(() => {
    const env = resolveEnv();
    const paths = resolvePaths(env.agentName, env.instanceId, env.org, env.ctxRoot);
    const { messages, skipped } = checkInboxWithStatus(paths);
    // stdout shape is unchanged on purpose — agents and scripts parse this
    // array. The "we never looked" signal rides stderr + exit code so an
    // empty result can no longer be mistaken for a verified-empty inbox.
    console.log(JSON.stringify(messages));
    if (skipped) {
      console.error('[bus] check-inbox: could not acquire the inbox lock — the inbox was NOT read. The empty result above is not evidence the inbox is empty (stale .lock.d?).');
      process.exitCode = 1;
    }
  });

busCommand
  .command('ack-inbox')
  .argument('<id>', 'Message ID to acknowledge')
  .action((id: string) => {
    const env = resolveEnv();
    const paths = resolvePaths(env.agentName, env.instanceId, env.org, env.ctxRoot);
    ackInbox(paths, id);
    try {
      logEvent(paths, env.agentName, env.org, 'message', 'inbox_ack', 'info', JSON.stringify({ msg_id: id }), { refreshHeartbeat: true });
    } catch { /* non-fatal */ }
    console.log(`ACK'd ${id}`);
  });

busCommand
  .command('create-task')
  .argument('<title>', 'Task title')
  .option('--desc <description>', 'Task description. Pass "-" to read it from stdin instead of an inline argument.')
  .option('--desc-file <path>', 'Read the task description from a file instead of --desc — the safe way to include backticks, $(, or apostrophes byte-identical')
  .option('--assignee <agent>', 'Assigned agent')
  .option('--priority <p>', 'Priority (urgent, high, normal, low)', 'normal')
  .option('--project <name>', 'Project name')
  .option('--needs-approval', 'Require human approval before execution')
  .option('--blocked-by <ids>', 'Comma-separated task IDs that must complete before this task can progress')
  .option('--blocks <ids>', 'Comma-separated task IDs that this new task will block (symmetric reverse edge)')
  .action((title: string, opts: { desc?: string; descFile?: string; assignee?: string; priority: string; project?: string; needsApproval?: boolean; blockedBy?: string; blocks?: string }) => {
    // Fail-closed body resolution (2026-08-15) — same construction that
    // corrupts a send-message body corrupts --desc: a description is
    // free text through the identical double-quoted shell argument.
    let resolvedDesc: string | undefined;
    try {
      resolvedDesc = resolveOptionalTextField({ inlineText: opts.desc, bodyFile: opts.descFile, fileFlagName: '--desc-file' });
    } catch (err) {
      if (err instanceof UnsafeInlineBodyError) {
        console.error(err.message);
        process.exit(1);
      }
      throw err;
    }
    const env = resolveEnv();
    const paths = resolvePaths(env.agentName, env.instanceId, env.org, env.ctxRoot);
    const parseList = (raw?: string) => (raw ? raw.split(',').map(s => s.trim()).filter(Boolean) : []);
    if (opts.assignee === undefined) {
      process.stderr.write(
        `Warning: no --assignee given — task defaults to assigned_to: "${env.agentName}" (the calling agent). ` +
          'If this task is meant for someone else, pass --assignee <agent> now; there is no unassign later, ' +
          'only update-task --assignee to reroute it.\n',
      );
    }
    const taskId = createTask(paths, env.agentName, env.org, title, {
      description: resolvedDesc,
      assignee: opts.assignee,
      priority: opts.priority as Priority,
      project: opts.project,
      needsApproval: opts.needsApproval ?? false,
      blockedBy: parseList(opts.blockedBy),
      blocks: parseList(opts.blocks),
    });
    console.log(taskId);
    // Auto-notify assignee so the task is visible immediately (issue #78)
    if (opts.assignee && opts.assignee !== env.agentName) {
      const assigneePaths = resolvePaths(opts.assignee, env.instanceId, env.org, env.ctxRoot);
      const desc = opts.desc ? ` — ${opts.desc.slice(0, 120)}` : '';
      sendMessage(assigneePaths, env.agentName, opts.assignee, 'normal',
        `Task assigned: [${opts.priority}] ${title}${desc} (id: ${taskId})`);
    }
  });

/**
 * One item in a `dispatch-batch` items file: becomes one task.
 */
interface DispatchBatchItem {
  title: string;
  desc?: string;
}

/**
 * Parse and validate a dispatch-batch items file's contents.
 *
 * Validates the WHOLE batch before any task is created (see the caller) —
 * a malformed item N should never leave tasks 1..N-1 created with no batch
 * id anyone can find, which is the exact "durable but orphaned" half of the
 * gap this command exists to close.
 */
export function parseDispatchBatchItems(raw: string): DispatchBatchItem[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`items file is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error('items file must be a non-empty JSON array of {"title": "...", "desc"?: "..."} objects');
  }
  return parsed.map((item, i) => {
    if (typeof item !== 'object' || item === null || typeof (item as { title?: unknown }).title !== 'string' || (item as { title: string }).title.trim() === '') {
      throw new Error(`item ${i} is missing a non-empty string "title"`);
    }
    const desc = (item as { desc?: unknown }).desc;
    if (desc !== undefined && typeof desc !== 'string') {
      throw new Error(`item ${i}'s "desc" must be a string if present`);
    }
    return { title: (item as { title: string }).title, desc: desc as string | undefined };
  });
}

busCommand
  .command('dispatch-batch')
  .description('Create N tasks from a JSON items file, all sharing one traceable batch id — the durable alternative to describing a multi-item batch only in a bus message body, whose delivery-ack has no idea how much of the work got done before a session died (task_1787921691733_11462336).')
  .argument('<assignee>', 'Agent the whole batch is dispatched to')
  .argument('<items-file>', 'Path to a JSON file: an array of {"title": "...", "desc"?: "..."} objects. Pass "-" to read from stdin. Keep items FINE-GRAINED (one file/step per item, not one item for the whole batch) so a crash mid-batch loses at most one item, not a fraction of an in_progress one.')
  .option('--priority <p>', 'Priority applied to every item task (urgent, high, normal, low)', 'normal')
  .option('--project <name>', 'Override the auto-generated batch id (advanced — default is batch-<timestamp>-<rand>, unique and sufficient for tracing without this)')
  .action((assignee: string, itemsFile: string, opts: { priority: string; project?: string }) => {
    try {
      validateAgentName(assignee);
      validatePriority(opts.priority as Priority);
    } catch (err) {
      console.error(String(err));
      process.exit(1);
    }

    let raw: string;
    try {
      raw = itemsFile === '-' ? readFileSync(0, 'utf-8') : readFileSync(itemsFile, 'utf-8');
    } catch (err) {
      console.error(`Could not read items file '${itemsFile}': ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }

    let items: DispatchBatchItem[];
    try {
      items = parseDispatchBatchItems(raw);
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }

    const env = resolveEnv();
    const paths = resolvePaths(env.agentName, env.instanceId, env.org);
    const batchId = opts.project || `batch-${Date.now()}-${randomDigits(6)}`;

    const taskIds = items.map(item =>
      createTask(paths, env.agentName, env.org, item.title, {
        description: item.desc ?? '',
        assignee,
        priority: opts.priority as Priority,
        project: batchId,
      })
    );

    console.log(batchId);
    for (const id of taskIds) console.log(id);

    // One summary message, not N individual create-task auto-notifies — and
    // the check-before-trusting-an-ack instruction lives IN the dispatch
    // text itself (instruction-at-point-of-use), not only in a doc a
    // successor session has no particular reason to re-read.
    if (assignee !== env.agentName) {
      const assigneePaths = resolvePaths(assignee, env.instanceId, env.org);
      sendMessage(
        assigneePaths, env.agentName, assignee, 'normal',
        `Batch dispatch ${batchId}: ${taskIds.length} task(s) created (${taskIds.join(', ')}). ` +
        `Before executing on ANY of these, run \`cortextos bus list-tasks --project ${batchId} --status pending\` ` +
        `to see what is actually still outstanding — do not trust this message alone if you are a successor to a ` +
        `session that already started this batch (acking this message only confirms delivery, never how much of ` +
        `the batch got done before the prior session ended).`,
      );
    }
  });

busCommand
  .command('check-batch-staleness')
  .description('Orphan-task-watchdog for a dispatch-batch project: flag in_progress items gone stale vs. genuinely active (default 2h)')
  .argument('<batch-id>', 'The project id shared by every task in the batch (printed by dispatch-batch, or passed via its --project)')
  .option('--stale-after <duration>', 'Threshold past which an in_progress item is flagged orphaned, e.g. "2h", "30m", "1d" (default: 2h)')
  .action((batchId: string, opts: { staleAfter?: string }) => {
    let staleAfterMs: number | undefined;
    if (opts.staleAfter !== undefined) {
      staleAfterMs = parseDurationMs(opts.staleAfter);
      if (Number.isNaN(staleAfterMs)) {
        console.error(`Invalid --stale-after '${opts.staleAfter}' — expected a number followed by m/h/d/w, e.g. "2h"`);
        process.exit(1);
      }
    }
    const env = resolveEnv();
    const paths = resolvePaths(env.agentName, env.instanceId, env.org, env.ctxRoot);
    const report = staleAfterMs === undefined
      ? checkBatchStaleness(paths, batchId)
      : checkBatchStaleness(paths, batchId, staleAfterMs);
    console.log(JSON.stringify(report));
  });

busCommand
  .command('update-task')
  .argument('<id>', 'Task ID')
  .argument('[status]', 'New status (pending, in_progress, completed, blocked, cancelled) — optional when --assignee/--project/--priority/--append-desc is given')
  .option('--assignee <name>', 'Reroute the task to a different agent')
  .option('--project <name>', 'Change the task\'s project')
  .option('--priority <level>', 'Change the task\'s priority (urgent, high, normal, low)')
  .option('--append-desc <text>', 'Append text to the description with a timestamp — does NOT overwrite the original (a description cannot be edited in place; this keeps a correction visible next to the claim it corrects)')
  .option('--agent <name>', 'Agent performing the update, recorded in the audit log (defaults to CTX_AGENT_NAME)')
  .action((id: string, status: string | undefined, opts: { assignee?: string; project?: string; priority?: string; appendDesc?: string; agent?: string }) => {
    if (status === undefined && opts.assignee === undefined && opts.project === undefined && opts.priority === undefined && opts.appendDesc === undefined) {
      console.error('Nothing to update — pass a status, --assignee, --project, --priority, and/or --append-desc');
      process.exit(1);
    }
    if (status !== undefined) {
      const validStatuses: TaskStatus[] = ['pending', 'in_progress', 'completed', 'blocked', 'cancelled'];
      if (!validStatuses.includes(status as TaskStatus)) {
        console.error(`Invalid status '${status}'. Must be one of: ${validStatuses.join(', ')}`);
        process.exit(1);
      }
    }
    if (opts.priority !== undefined) {
      const validPriorities: Priority[] = ['urgent', 'high', 'normal', 'low'];
      if (!validPriorities.includes(opts.priority as Priority)) {
        console.error(`Invalid priority '${opts.priority}'. Must be one of: ${validPriorities.join(', ')}`);
        process.exit(1);
      }
    }
    const env = resolveEnv();
    const paths = resolvePaths(env.agentName, env.instanceId, env.org, env.ctxRoot);
    // Mirrors claim-task: explicit override, env fallback, hard failure when
    // neither is present. The abort is load-bearing — an empty agent value
    // widens rather than narrows elsewhere in this CLI, and defaulting here
    // would write a borrowed or empty identity into an append-only audit log
    // as though it were an observation.
    const actor = opts.agent || env.agentName;
    if (!actor) {
      console.error('ERROR: --agent or CTX_AGENT_NAME required');
      process.exit(1);
    }

    // Guard: block review/completion when deliverables are required but missing.
    // Checks both ready_for_review (approval workflow) and completed (vanilla upstream)
    // so the validator works regardless of which status set is installed.
    if ((status === 'ready_for_review' || status === 'completed') && env.org) {
      const err = checkDeliverableRequirement(id, env.frameworkRoot, env.org, paths.taskDir);
      if (err) {
        console.error(err);
        process.exit(1);
      }
    }

    try {
      updateTask(paths, id, status as TaskStatus | undefined, {
        assignee: opts.assignee,
        project: opts.project,
        priority: opts.priority as Priority | undefined,
        appendDesc: opts.appendDesc,
        actor,
      });
      if (
        status !== undefined &&
        opts.assignee === undefined &&
        opts.project === undefined &&
        opts.priority === undefined &&
        opts.appendDesc === undefined
      ) {
        // Preserve the original status-only message verbatim — scripts/
        // dashboards may already parse it.
        console.log(`Updated ${id} -> ${status}`);
      } else {
        const changes = [
          status !== undefined ? `status -> ${status}` : null,
          opts.assignee !== undefined ? `assignee -> ${opts.assignee}` : null,
          opts.project !== undefined ? `project -> ${opts.project}` : null,
          opts.priority !== undefined ? `priority -> ${opts.priority}` : null,
          opts.appendDesc !== undefined ? 'description appended' : null,
        ].filter(Boolean);
        console.log(`Updated ${id}: ${changes.join(', ')}`);
      }
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  });

busCommand
  .command('compact-tasks')
  .description('Archive completed tasks older than N days into a per-month archive-YYYY-MM.jsonl and remove them from the active list — preserves audit logs, skips tasks still needed as blockers')
  .option('--older-than <days>', 'Cutoff in days (default: 30)', '30')
  .option('--dry-run', 'Report what would be compacted without modifying anything')
  .action((opts: { olderThan: string; dryRun?: boolean }) => {
    const env = resolveEnv();
    const paths = resolvePaths(env.agentName, env.instanceId, env.org, env.ctxRoot);
    const olderThanDays = parseInt(opts.olderThan, 10);
    if (isNaN(olderThanDays) || olderThanDays < 0) {
      console.error('--older-than must be a non-negative integer');
      process.exit(1);
    }
    const report = compactTasks(paths, { olderThanDays, dryRun: opts.dryRun });
    const verb = report.dry_run ? 'would compact' : 'compacted';
    console.log(`${verb} ${report.archived.length} task${report.archived.length === 1 ? '' : 's'}, skipped ${report.skipped.length}`);
    for (const a of report.archived) console.log(`  ✓ ${a.id}  ->  ${a.archive_file}`);
    if (report.skipped.length > 0) {
      console.log(`\nSkipped (common reasons: within cutoff, still needed as blocker):`);
      for (const s of report.skipped) console.log(`  - ${s.id}  (${s.reason})`);
    }
  });

busCommand
  .command('check-deps')
  .description('Show open dependencies blocking a task — lists blocked_by entries that are not yet completed')
  .argument('<id>', 'Task ID')
  .action((id: string) => {
    const env = resolveEnv();
    const paths = resolvePaths(env.agentName, env.instanceId, env.org, env.ctxRoot);
    const { open, unresolved } = checkTaskDependenciesWithStatus(paths, id);
    if (open.length === 0) {
      if (unresolved) {
        // Do not print "ready to work" off a scan that never completed.
        console.log(`${id}: dependency state UNKNOWN — a task directory could not be read, so this is NOT an all-clear`);
        process.exitCode = 1;
        return;
      }
      console.log(`${id}: no open dependencies — ready to work`);
      return;
    }
    console.log(`${id} blocked by ${open.length} dependency${open.length === 1 ? '' : 's'}:`);
    for (const d of open) console.log(`  ${d.id}  [${d.status}]`);
  });

busCommand
  .command('task-history')
  .description("Show a task's append-only audit log (every status change, claim, and completion)")
  .argument('<id>', 'Task ID')
  .option('--json', 'Emit raw JSONL instead of formatted text')
  .action((id: string, opts: { json?: boolean }) => {
    const env = resolveEnv();
    const paths = resolvePaths(env.agentName, env.instanceId, env.org, env.ctxRoot);
    const entries = readTaskAudit(paths, id);
    if (entries.length === 0) {
      console.log(`No audit log for task ${id}`);
      return;
    }
    if (opts.json) {
      for (const e of entries) console.log(JSON.stringify(e));
      return;
    }
    console.log(`Audit log for ${id} (${entries.length} entries):`);
    for (const e of entries) {
      const transition = e.from && e.to ? `${e.from} -> ${e.to}` : e.to || '';
      const note = e.note ? ` | ${e.note}` : '';
      console.log(`  ${e.ts}  ${e.event.padEnd(8)}  ${e.agent.padEnd(16)}  ${transition}${note}`);
    }
  });

busCommand
  .command('claim-task')
  .description('Atomically claim a pending task — marks in_progress + sets assignee in one shot, rejecting if another agent already owns it')
  .argument('<id>', 'Task ID')
  .option('--agent <name>', 'Agent claiming the task (defaults to CTX_AGENT_NAME)')
  .action((id: string, opts: { agent?: string }) => {
    const env = resolveEnv();
    const paths = resolvePaths(env.agentName, env.instanceId, env.org, env.ctxRoot);
    const agent = opts.agent || env.agentName;
    if (!agent) {
      console.error('ERROR: --agent or CTX_AGENT_NAME required');
      process.exit(1);
    }
    try {
      const task = claimTask(paths, id, agent);
      console.log(`Claimed ${id} -> in_progress (assigned to ${agent})`);
      console.log(`  Title: ${task.title}`);
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  });

busCommand
  .command('complete-task')
  .argument('<id>', 'Task ID')
  .argument('[result]', 'Completion result (optional positional form)')
  .option('--result <text>', 'Completion result. Pass "-" to read it from stdin instead of an inline argument.')
  .option('--result-file <path>', 'Read the completion result from a file instead of the argument/--result — the safe way to include backticks, $(, or apostrophes byte-identical')
  .action((id: string, resultArg: string | undefined, opts: { result?: string; resultFile?: string }) => {
    // Accept result as either positional arg or --result flag (P1 fix #8)
    const inlineResult = opts.result ?? resultArg;
    // Fail-closed body resolution (2026-08-15) — same construction that
    // corrupts a send-message body corrupts a completion result: free
    // text through the identical double-quoted shell argument.
    let effectiveResult: string | undefined;
    try {
      effectiveResult = resolveOptionalTextField({ inlineText: inlineResult, bodyFile: opts.resultFile, fileFlagName: '--result-file' });
    } catch (err) {
      if (err instanceof UnsafeInlineBodyError) {
        console.error(err.message);
        process.exit(1);
      }
      throw err;
    }
    const env = resolveEnv();
    const paths = resolvePaths(env.agentName, env.instanceId, env.org, env.ctxRoot);

    // Guard: block completion when deliverables are required but missing
    if (env.org) {
      const err = checkDeliverableRequirement(id, env.frameworkRoot, env.org, paths.taskDir);
      if (err) {
        console.error(err);
        process.exit(1);
      }
    }

    try {
      completeTask(paths, id, effectiveResult);
      console.log(`Completed ${id}`);
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  });

busCommand
  .command('save-output')
  .description('Copy a file into the per-task deliverables tree and link it to the task as a file output')
  .argument('<task-id>', 'Target task ID')
  .argument('<source>', 'Source file to save (absolute or relative to cwd)')
  .option('--label <label>', 'Human-readable label for the linked output (defaults to filename)')
  .option('--move', 'Delete the source file after a successful copy')
  .option('--no-link', 'Save file without linking to task.outputs[]')
  .action((taskId: string, source: string, opts: { label?: string; move?: boolean; link?: boolean }) => {
    const noLink = opts.link === false;
    const env = resolveEnv();
    const paths = resolvePaths(env.agentName, env.instanceId, env.org, env.ctxRoot);
    try {
      const result = saveOutput(paths, {
        taskId,
        sourcePath: source,
        label: opts.label,
        move: opts.move ?? false,
        noLink,
      });
      console.log(result.targetPath);
      if (result.linked) {
        console.log(`Linked to ${taskId} as [snapshot] ${opts.label ?? result.storedPath}`);
      }
    } catch (err) {
      console.error((err as Error).message);
      process.exit(1);
    }
  });

busCommand
  .command('list-tasks')
  .option('--agent <name>', 'Filter by agent')
  .option('--status <s>', 'Filter by status')
  .option('--format <fmt>', 'Output format: json or text', 'text')
  .option('--respect-deps', 'Sort DAG-aware: unblocked tasks first, blocked tasks last')
  .option('--include-archived', 'Also include compact-tasks archive entries (reconstructed summaries — see readCompactedTasks)')
  .action((opts: { agent?: string; status?: string; format?: string; respectDeps?: boolean; includeArchived?: boolean }) => {
    const env = resolveEnv();
    const paths = resolvePaths(env.agentName, env.instanceId, env.org, env.ctxRoot);
    const tasks = listTasks(paths, {
      agent: opts.agent,
      status: opts.status as TaskStatus,
      respectDeps: opts.respectDeps ?? false,
      includeArchived: opts.includeArchived ?? false,
    });

    if (opts.format === 'json') {
      console.log(JSON.stringify(tasks, null, 2));
      return;
    }

    // Text table format
    if (tasks.length === 0) {
      console.log('  No tasks found.');
      return;
    }

    const PRIORITY_ICON: Record<string, string> = { urgent: '🔴', high: '🟠', normal: '🔵', low: '⚪' };
    const STATUS_ICON: Record<string, string> = { pending: '○', in_progress: '●', blocked: '◑', completed: '✓', done: '✓', cancelled: '✗' };

    console.log(`\n  Tasks (${tasks.length})\n`);
    // ID column is 28 chars (current format max: task_<13>_<8> = 27 + 1 headroom);
    // never substring the id — display must preserve identifier precision so
    // copy-paste from the table cannot produce a non-existent ID. Same principle
    // applied to assignee — pad-to-min-width, never truncate.
    const header = '  Status  Pri  ID                          Assignee         Title';
    const separator = '  ' + '-'.repeat(header.length - 2);
    console.log(header);
    console.log(separator);

    for (const t of tasks) {
      const statusIcon = (STATUS_ICON[t.status] || '?').padEnd(8);
      const priIcon = (PRIORITY_ICON[t.priority] || '·').padEnd(5);
      const id = t.id.padEnd(28);
      const assignee = (t.assigned_to || '-').padEnd(17);
      const title = t.title.substring(0, 50);
      console.log(`  ${statusIcon}${priIcon}${id}${assignee}${title}`);
    }
    console.log('');
  });

busCommand
  .command('log-event')
  .argument('<category>', 'Event category')
  .argument('<event>', 'Event name')
  .argument('<severity>', 'Severity (info, warning, error, critical)')
  .option('--meta <json>', 'Metadata JSON string', '{}')
  .action((category: string, event: string, severity: string, opts: { meta: string }) => {
    const validCategories: EventCategory[] = ['action', 'error', 'metric', 'milestone', 'heartbeat', 'message', 'task', 'approval'];
    if (!validCategories.includes(category as EventCategory)) {
      console.error(`Invalid category '${category}'. Must be one of: ${validCategories.join(', ')}`);
      process.exit(1);
    }
    const validSeverities: EventSeverity[] = ['info', 'warning', 'error', 'critical'];
    if (!validSeverities.includes(severity as EventSeverity)) {
      console.error(`Invalid severity '${severity}'. Must be one of: ${validSeverities.join(', ')}`);
      process.exit(1);
    }
    const env = resolveEnv();
    const paths = resolvePaths(env.agentName, env.instanceId, env.org, env.ctxRoot);
    logEvent(paths, env.agentName, env.org, category as EventCategory, event, severity as EventSeverity, opts.meta, { refreshHeartbeat: true });
    console.log(`Logged ${category}/${event} (${severity})`);
  });

busCommand
  .command('update-heartbeat')
  .argument('<status>', 'Heartbeat status message')
  .option('--task <task>', 'Current task description')
  .option('--timezone <tz>', 'Timezone for day/night mode detection')
  .option('--interval <i>', 'Loop interval from cron config')
  .option('--source <src>', 'Heartbeat source: "session" (genuine session beat, default) or "watchdog" (daemon idle-timer)', 'session')
  .action((status: string, opts: { task?: string; timezone?: string; interval?: string; source?: string }) => {
    const env = resolveEnv();
    const paths = resolvePaths(env.agentName, env.instanceId, env.org, env.ctxRoot);

    // Read display name from IDENTITY.md so agents self-report their user-facing name
    let displayName: string | undefined;
    const frameworkRoot = process.env.CTX_FRAMEWORK_ROOT || process.env.CTX_PROJECT_ROOT || '';
    if (frameworkRoot) {
      const identityPaths = [
        join(resolveAgentDir(frameworkRoot, env.org, env.agentName), 'IDENTITY.md'),
        join(frameworkRoot, 'agents', env.agentName, 'IDENTITY.md'),
      ];
      for (const idPath of identityPaths) {
        if (existsSync(idPath)) {
          try {
            const lines = readFileSync(idPath, 'utf-8').split('\n');
            // "## Name" section takes priority (user-configured display name)
            const nameIdx = lines.findIndex(l => l.trim() === '## Name');
            if (nameIdx >= 0) {
              for (let i = nameIdx + 1; i < lines.length; i++) {
                const line = lines[i].trim();
                if (!line || line.startsWith('<!--')) continue;
                if (line.startsWith('#')) break;
                displayName = line;
                break;
              }
            }
            // Fallback: first non-empty, non-comment top-level heading value
            if (!displayName) {
              const h1 = lines.find(l => l.startsWith('# ') && !l.startsWith('## '));
              if (h1) displayName = h1.replace(/^#\s+/, '').trim();
            }
          } catch {
            // Skip
          }
          break;
        }
      }
    }

    updateHeartbeat(paths, env.agentName, status, {
      org: env.org,
      timezone: opts.timezone,
      loopInterval: opts.interval,
      currentTask: opts.task,
      displayName,
      source: opts.source === 'watchdog' ? 'watchdog' : 'session',
    });
    // Auto-emit a heartbeat event so the activity feed surfaces any live agent
    // even if the agent itself forgets to call log-event. This makes the
    // dashboard "agents" list derive from heartbeats, not just explicit events.
    try {
      logEvent(paths, env.agentName, env.org, 'heartbeat', 'heartbeat', 'info', JSON.stringify({ status, task: opts.task ?? '' }), { refreshHeartbeat: true });
    } catch {
      // Non-fatal: heartbeat write already succeeded
    }
    console.log(`Heartbeat updated: ${env.agentName}`);
  });

busCommand
  .command('read-all-heartbeats')
  // Scope stated exactly: this reads ONE instance unless --all-instances is passed.
  // The previous wording, "all agents in the system", overclaimed — `~/.cortextos/`
  // holds several instances and this saw only the caller's.
  .description("Fleet heartbeat report for the caller's instance (roster UNION state/ scan). Use --all-instances to sweep every instance.")
  .option('--format <fmt>', 'Output format: json or text', 'text')
  .option('--all-instances', 'Sweep every instance under ~/.cortextos that has a roster')
  .action((opts: { format?: string; allInstances?: boolean }) => {
    const env = resolveEnv();

    const instances: string[] = opts.allInstances
      ? (() => {
          const base = join(homedir(), '.cortextos');
          try {
            return readdirSync(base, { withFileTypes: true })
              .filter(d => d.isDirectory() && existsSync(join(base, d.name, 'config', 'enabled-agents.json')))
              .map(d => d.name)
              .sort();
          } catch {
            return [env.instanceId];
          }
        })()
      : [env.instanceId];

    // Each instance's orgs come from ITS OWN roster. Inheriting the caller's org (or
    // passing none, which scans every org) mixes one instance's agents into another's
    // report — they surface as "NEVER BEATEN" rows for agents that are not its at all.
    const orgsOf = (instanceId: string): string[] | undefined => {
      if (instanceId === env.instanceId && env.org) return [env.org];
      try {
        const roster = JSON.parse(readFileSync(
          join(homedir(), '.cortextos', instanceId, 'config', 'enabled-agents.json'), 'utf-8',
        )) as Record<string, { org?: string }>;
        const found = [...new Set(Object.values(roster).map(e => e.org).filter(Boolean))] as string[];
        return found.length > 0 ? found : undefined;
      } catch {
        return undefined;
      }
    };

    const report = instances.map(instanceId => ({
      instance: instanceId,
      rows: readAllHeartbeatRows(
        // Only the caller's OWN instance may use env.ctxRoot (a possible CTX_ROOT
        // override) -- every other instance was discovered by listing real
        // homedir subdirectories above, so its root IS homedir()/.cortextos/<id>,
        // never the caller's override.
        resolvePaths(env.agentName, instanceId, env.org, instanceId === env.instanceId ? env.ctxRoot : undefined),
        orgsOf(instanceId),
      ),
    }));

    if (opts.format === 'json') {
      console.log(JSON.stringify(opts.allInstances ? report : report[0].rows, null, 2));
      return;
    }

    const STALE_MS = 2 * 60 * 60 * 1000;
    for (const { instance, rows } of report) {
      if (opts.allInstances) console.log(`\n=== instance: ${instance} ===`);
      if (rows.length === 0) {
        console.log('No agents found.');
        continue;
      }

      for (const row of rows) {
        const hb = row.heartbeat;
        const name = hb?.display_name ? `${hb.display_name} (${row.agent})` : row.agent;
        const org = row.org ?? '?';

        // The three conditions the old single-axis output could not tell apart.
        if (row.source === 'roster-only') {
          console.log(`${name} (${org}) — NEVER BEATEN — no heartbeat file${row.enabled === false ? ' [DISABLED]' : ''}`);
          continue;
        }
        if (row.source === 'state-only') {
          console.log(`${name} (${org}) — ORPHAN STATE DIR — heartbeat present but no roster entry; not a running agent`);
          if (row.nameMismatch) console.log(`  ⚠ file claims agent="${row.nameMismatch}" but lives in state/${row.agent}/`);
          continue;
        }
        if (row.unreadable || !hb) {
          console.log(`${name} (${org}) — UNREADABLE heartbeat.json (this is NOT a pass)`);
          continue;
        }

        const stale = new Date(hb.last_heartbeat) < new Date(Date.now() - STALE_MS);
        // A disabled agent is stale BY DESIGN — never label it as though it died.
        const flag = row.enabled === false ? ' [DISABLED]' : stale ? ' [STALE]' : '';
        console.log(`${name} (${org}) — ${hb.status}${flag} — last seen ${hb.last_heartbeat}`);
        if (row.nameMismatch) console.log(`  ⚠ file claims agent="${row.nameMismatch}" but lives in state/${row.agent}/`);
        if (hb.current_task) console.log(`  task: ${hb.current_task}`);
      }
    }
  });

busCommand
  .command('recall-facts')
  .description('Recall recent session facts extracted at compaction time (cross-session memory)')
  .option('--days <n>', 'How many days back to scan', '3')
  .option('--format <fmt>', 'Output format: text or json', 'text')
  .option('--agent <name>', 'Agent name (defaults to CTX_AGENT_NAME)')
  .action((opts: { days: string; format: string; agent?: string }) => {
    const env = resolveEnv();
    const agentName = opts.agent || env.agentName;
    const daysBack = Math.max(1, Math.min(30, parseInt(opts.days, 10) || 3));
    const factsDir = join(env.ctxRoot, 'state', agentName, 'memory', 'facts');

    const entries: Array<{ ts: string; session_id: string; summary: string; keywords: string[] }> = [];

    for (let d = 0; d < daysBack; d++) {
      const date = new Date(Date.now() - d * 24 * 60 * 60 * 1000);
      const dateStr = date.toISOString().slice(0, 10);
      const factsFile = join(factsDir, `${dateStr}.jsonl`);
      if (!existsSync(factsFile)) continue;
      try {
        const lines = readFileSync(factsFile, 'utf-8').split('\n').filter(l => l.trim());
        for (const line of lines) {
          try {
            entries.push(JSON.parse(line));
          } catch { /* skip corrupt lines */ }
        }
      } catch { /* skip unreadable files */ }
    }

    if (opts.format === 'json') {
      console.log(JSON.stringify(entries, null, 2));
      return;
    }

    if (entries.length === 0) {
      console.log('No session facts found. Facts are written automatically at context compaction.');
      return;
    }

    console.log(`\n  Session Memory — last ${daysBack} day(s) — ${entries.length} entries\n`);
    for (const e of entries.slice(-10)) { // Show last 10 entries
      const ts = e.ts.replace('T', ' ').replace('Z', ' UTC').slice(0, 19);
      console.log(`  [${ts}]`);
      // Print first 400 chars of summary
      const preview = e.summary.slice(0, 400).replace(/\n/g, ' ');
      console.log(`  ${preview}${e.summary.length > 400 ? '...' : ''}`);
      if (e.keywords && e.keywords.length > 0) {
        console.log(`  Keywords: ${e.keywords.slice(0, 8).join(', ')}`);
      }
      console.log();
    }
  });

busCommand
  .command('check-stale-tasks')
  .description('Find stale tasks (in_progress >2h, pending >24h, overdue)')
  .action(() => {
    const env = resolveEnv();
    const paths = resolvePaths(env.agentName, env.instanceId, env.org, env.ctxRoot);
    const report = checkStaleTasks(paths);
    console.log(JSON.stringify(report));
  });

busCommand
  .command('archive-tasks')
  .description('Archive completed tasks older than 7 days')
  .option('--dry-run', 'Show what would be archived without modifying files')
  .action((opts: { dryRun?: boolean }) => {
    const env = resolveEnv();
    const paths = resolvePaths(env.agentName, env.instanceId, env.org, env.ctxRoot);
    const report = archiveTasks(paths, opts.dryRun ?? false);
    console.log(JSON.stringify(report));
  });

busCommand
  .command('check-human-tasks')
  .description('Find stale human-assigned tasks (>24h)')
  .action(() => {
    const env = resolveEnv();
    const paths = resolvePaths(env.agentName, env.instanceId, env.org, env.ctxRoot);
    const tasks = checkHumanTasks(paths);
    console.log(JSON.stringify(tasks));
  });

busCommand
  .command('self-restart')
  .description('Immediately restart this agent via daemon IPC (same as soft-restart but targets self)')
  .option('--reason <why>', 'Reason for restart')
  .action(async (opts: { reason?: string }) => {
    const { mkdirSync, writeFileSync } = require('fs');
    const { join } = require('path');
    const env = resolveEnv();
    const paths = resolvePaths(env.agentName, env.instanceId, env.org, env.ctxRoot);
    const reason = opts.reason || 'self-restart requested';

    // Write .user-restart marker (same as soft-restart)
    const ctxRoot = env.ctxRoot;
    const stateDir = join(ctxRoot, 'state', env.agentName);
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, '.user-restart'), reason);

    // Also write to restarts.log
    selfRestart(paths, env.agentName, reason);

    // Send IPC restart-agent signal for self — makes restart immediate
    const ipc = new IPCClient(env.instanceId);
    const daemonRunning = await ipc.isDaemonRunning();
    if (daemonRunning) {
      const resp = await ipc.send({ type: 'restart-agent', agent: env.agentName, source: 'cortextos bus self-restart' });
      if (resp.success) {
        console.log(`Restarting ${env.agentName} via daemon IPC`);
      } else {
        console.error(`Daemon restart failed: ${resp.error}`);
        process.exit(1);
      }
    } else {
      console.error('ERROR: Node daemon is not running. Start it with: cortextos start');
      process.exit(1);
    }
  });

busCommand
  .command('hard-restart')
  .description('Plan a hard restart (fresh session, no --continue)')
  .option('--reason <why>', 'Reason for restart')
  .option('--handoff-doc <path>', 'Path to handoff document to inject into next session boot prompt')
  .action(async (opts: { reason?: string; handoffDoc?: string }) => {
    const { writeFileSync: fsWrite, existsSync: fsExists, mkdirSync: fsMkdir } = require('fs');
    const env = resolveEnv();
    const paths = resolvePaths(env.agentName, env.instanceId, env.org, env.ctxRoot);
    hardRestart(paths, env.agentName, opts.reason);
    if (opts.handoffDoc && fsExists(opts.handoffDoc)) {
      fsMkdir(paths.stateDir, { recursive: true });
      fsWrite(join(paths.stateDir, '.handoff-doc-path'), opts.handoffDoc + '\n', 'utf-8');
    }
    // Send IPC restart-agent so the daemon terminates and restarts this session
    // immediately. Without this the session keeps running — .force-fresh is only
    // consumed on the NEXT restart, which never comes unless the daemon is notified.
    const ipc = new IPCClient(env.instanceId);
    const daemonRunning = await ipc.isDaemonRunning();
    if (daemonRunning) {
      const resp = await ipc.send({ type: 'restart-agent', agent: env.agentName, source: 'cortextos bus hard-restart' });
      if (resp.success) {
        console.log(`Hard restart triggered for ${env.agentName} — fresh session incoming`);
      } else {
        console.error(`Daemon restart failed: ${resp.error}`);
        process.exit(1);
      }
    } else {
      console.log('Hard restart planned (daemon not running — will take effect on next start)');
    }
  });

busCommand
  .command('check-goal-staleness')
  .description('Detect agents with stale GOALS.md')
  .option('--threshold <days>', 'Staleness threshold in days', '7')
  .action((opts: { threshold: string }) => {
    const env = resolveEnv();
    const projectRoot = env.projectRoot || env.frameworkRoot || process.cwd();
    const report = checkGoalStaleness(projectRoot, parseInt(opts.threshold, 10), env.ctxRoot);
    console.log(JSON.stringify(report, null, 2));
  });

busCommand
  .command('check-stale-blockers')
  .description('Detect blocked tasks whose dependency (task or referenced PR) has already resolved')
  .option('--format <fmt>', 'Output format: json|text', 'json')
  .action((opts: { format?: string }) => {
    const env = resolveEnv();
    const report = checkStaleBlockers(env.ctxRoot);
    if (opts.format === 'text') {
      if (report.entries.length === 0) {
        console.log(`No stale blockers found (${report.summary.scanned} blocked tasks scanned).`);
        return;
      }
      for (const e of report.entries) {
        console.log(`[${e.kind}] ${e.task_id} (${e.org}, assigned: ${e.assigned_to})`);
        console.log(`  ${e.title}`);
        console.log(`  ${e.detail}`);
        console.log('');
      }
      console.log(
        `Total: ${report.entries.length} flagged (${report.summary.resolved_dependency} resolved-dependency ` +
        `of ${report.summary.resolved_dependency_eligible} eligible (has blocked_by), ` +
        `${report.summary.unverified_external_ref} needs-manual-check) out of ${report.summary.scanned} blocked tasks scanned.`,
      );
    } else {
      console.log(JSON.stringify(report, null, 2));
    }
  });

busCommand
  .command('check-deploy-drift')
  .description('Detect fleet CLI drift: unpulled origin/main commits, or dist/ built from a stale commit')
  .option('--format <fmt>', 'Output format: json|text', 'json')
  .action((opts: { format?: string }) => {
    const env = resolveEnv();
    const frameworkRoot = env.frameworkRoot || env.projectRoot || process.cwd();
    const report = checkDeployDrift(frameworkRoot);
    if (opts.format === 'text') {
      if (report.status === 'error') {
        console.log(`ERROR: ${report.error}${report.hint ? ` (${report.hint})` : ''}`);
      } else if (report.status === 'clean') {
        console.log(`Clean — local HEAD ${report.pull_drift!.local_head.slice(0, 8)} matches origin/main and dist/.`);
      } else {
        if (report.pull_drift!.behind) {
          console.log(
            `PULL DRIFT: local is ${report.pull_drift!.commits_behind} commit(s) behind origin/main ` +
            `(${report.pull_drift!.local_head.slice(0, 8)} -> ${report.pull_drift!.origin_head.slice(0, 8)}).`,
          );
          for (const line of report.pull_drift!.commit_summaries) console.log(`  ${line}`);
          if (report.pull_drift!.truncated) console.log(`  ...(${report.pull_drift!.commits_behind - COMMIT_LOG_LIMIT} more)`);
        }
        if (report.build_drift!.stale) {
          console.log(`BUILD DRIFT: ${report.build_drift!.reason}`);
        }
      }
    } else {
      console.log(JSON.stringify(report, null, 2));
    }
    if (report.status !== 'clean') {
      process.exitCode = 1;
    }
  });

busCommand
  .command('post-activity')
  .description('Post a message to the org activity channel (Telegram if configured, bus broadcast otherwise)')
  .argument('<message>', 'Message to post')
  .action(async (message: string) => {
    const env = resolveEnv();
    const orgDir = env.agentDir ? env.agentDir.replace(/\/agents\/.*$/, '') : '';
    const success = await postActivity(orgDir, env.ctxRoot, env.org, message);
    if (success) {
      console.log('Activity posted');
      return;
    }
    // No Telegram activity channel (activity-channel.env absent or incomplete):
    // fall back to a bus-native broadcast so fleet-wide activity never depends
    // on a Telegram chat id — bus-only agents must be able to broadcast too.
    const projectRoot = env.projectRoot || env.frameworkRoot || process.cwd();
    const result = broadcastActivityViaBus(projectRoot, env.ctxRoot, env.instanceId, env.org, env.agentName, message);
    try {
      const paths = resolvePaths(env.agentName, env.instanceId, env.org, env.ctxRoot);
      logEvent(paths, env.agentName, env.org, 'agent_activity', 'activity_broadcast', 'info',
        JSON.stringify({ via: 'bus', delivered: result.delivered.length, skipped: result.skipped.length }));
    } catch { /* non-fatal */ }
    if (result.delivered.length > 0) {
      const skippedNote = result.skipped.length > 0 ? ` (${result.skipped.length} skipped)` : '';
      console.log(`No Telegram activity channel configured — broadcast over the bus to ${result.delivered.length} agent(s)${skippedNote}`);
    } else {
      console.error('Failed to post activity: no Telegram activity channel and no reachable bus recipients. For the Telegram channel, create orgs/<org>/activity-channel.env with ACTIVITY_BOT_TOKEN and ACTIVITY_CHAT_ID.');
      process.exit(1);
    }
  });

busCommand
  .command('create-experiment')
  .description('Create a new experiment proposal')
  .argument('<metric>', 'Metric to measure')
  .argument('<hypothesis>', 'Hypothesis to test')
  .option('--surface <path>', 'Surface file path')
  .option('--direction <dir>', 'Direction: higher or lower', 'higher')
  .option('--window <dur>', 'Measurement window', '24h')
  .option('--kind <kind>', 'intervention or snapshot', 'intervention')
  .option('--baseline <n>', 'Baseline value to compare the measured result against (required before evaluate-experiment will accept this experiment)')
  .option('--placeholder-baseline', 'Mark --baseline as a forced placeholder (no real prior measurement existed) rather than a genuine baseline — the completed record gets flagged needs_manual_review instead of shipping a mechanical decision silently')
  .action(async (metric: string, hypothesis: string, opts: { surface?: string; direction?: string; window?: string; kind?: string; baseline?: string; placeholderBaseline?: boolean }) => {
    try { validateExperimentBaseline(opts.baseline); } catch (err) { console.error(String(err)); process.exit(1); }
    const env = resolveEnv();
    const agentDir = env.agentDir || process.cwd();
    const id = createExperiment(agentDir, env.agentName, metric, hypothesis, {
      surface: opts.surface,
      direction: opts.direction as 'higher' | 'lower',
      window: opts.window,
      kind: opts.kind as 'intervention' | 'snapshot',
      baseline: opts.baseline !== undefined ? parseFloat(opts.baseline) : undefined,
      baselineIsPlaceholder: opts.placeholderBaseline ?? false,
    });
    console.log(id);

    // If approval_required is configured, auto-create an approval
    const config = loadExperimentConfig(agentDir);
    if (config.approval_required) {
      const paths = resolvePaths(env.agentName, env.instanceId, env.org, env.ctxRoot);
      const approvalId = await createApproval(
        paths,
        env.agentName,
        env.org,
        `Run experiment: ${metric} — ${hypothesis.slice(0, 80)}`,
        'other',
        `Experiment ID: ${id}\nMetric: ${metric}\nHypothesis: ${hypothesis}`,
        env.frameworkRoot,
        env.agentDir,
      );
      linkExperimentApproval(agentDir, id, approvalId);
      console.log(`approval_required: ${approvalId}`);
    }
  });

busCommand
  .command('run-experiment')
  .description('Start running a proposed experiment')
  .argument('<id>', 'Experiment ID')
  .argument('[description]', 'Description of changes')
  .action((id: string, description?: string) => {
    const env = resolveEnv();
    const agentDir = env.agentDir || process.cwd();
    const paths = resolvePaths(env.agentName, env.instanceId, env.org, env.ctxRoot);
    try {
      const experiment = runExperiment(agentDir, id, description, paths);
      console.log(JSON.stringify(experiment, null, 2));
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  });

busCommand
  .command('evaluate-experiment')
  .description('Evaluate a running experiment with a measured value')
  .argument('<id>', 'Experiment ID')
  .argument('<value>', 'Measured value')
  .option('--score <n>', 'Score 1-10')
  .option('--justification <text>', 'Justification text')
  .action((id: string, value: string, opts: { score?: string; justification?: string }) => {
    const env = resolveEnv();
    const agentDir = env.agentDir || process.cwd();
    const experiment = evaluateExperiment(agentDir, id, parseFloat(value), {
      score: opts.score ? parseFloat(opts.score) : undefined,
      justification: opts.justification,
    });
    console.log(JSON.stringify(experiment, null, 2));
  });

/**
 * Compact one-line-per-experiment text rendering for `list-experiments --format text`.
 * Matches list-tasks/list-agents's table-column convention.
 */
function formatExperimentsText(experiments: ReturnType<typeof listExperiments>): string {
  if (experiments.length === 0) return 'No experiments found.';
  const header = ['ID', 'Agent', 'Metric', 'Status', 'Decision'];
  // Experiment records are read straight off disk (JSON.parse with no schema
  // validation — see listExperiments) so a hand-edited or partially-written
  // file can be missing a field the type says is required. Coerce anything
  // that isn't a non-empty string to '-' rather than letting `.length` below
  // throw on undefined; JSON output is untouched (the raw objects, not these
  // rendered rows, are what --format json prints).
  const cell = (v: unknown): string => (typeof v === 'string' && v.length > 0) ? v : '-';
  const rows = experiments.map(e => [cell(e.id), cell(e.agent), cell(e.metric), cell(e.status), cell(e.decision)]);
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map(r => r[i].length)));
  const pad = (s: string, w: number) => s.padEnd(w);
  const line = (cols: string[]) => cols.map((c, i) => pad(c, widths[i])).join('  ');
  return [
    `Experiments (${experiments.length})`,
    '',
    line(header),
    widths.map(w => '-'.repeat(w)).join('  '),
    ...rows.map(line),
  ].join('\n');
}

busCommand
  .command('list-experiments')
  .description('List experiments with optional filters. With no --agent, scans fleet-wide across every agent (like read-all-heartbeats) rather than just the caller.')
  .option('--agent <name>', 'Filter by agent')
  .option('--status <s>', 'Filter by status')
  .option('--metric <m>', 'Filter by metric')
  .option('--format <fmt>', 'Output format: json or text (matches list-tasks/list-agents)', 'json')
  .action((opts: { agent?: string; status?: string; metric?: string; format?: string }) => {
    const env = resolveEnv();
    const format = opts.format === 'text' ? 'text' : 'json';
    const render = (experiments: ReturnType<typeof listExperiments>) => {
      console.log(format === 'text' ? formatExperimentsText(experiments) : JSON.stringify(experiments, null, 2));
    };

    if (opts.agent) {
      const agentDir = env.frameworkRoot
        ? resolveAgentDir(env.frameworkRoot, env.org, opts.agent)
        : (env.agentDir || process.cwd());
      render(listExperiments(agentDir, {
        agent: opts.agent,
        status: opts.status,
        metric: opts.metric,
      }));
      return;
    }

    // task_1785723303692: no --agent given — silently scoping to the caller's
    // own agentDir here (as this used to) means a "list every experiment"
    // scan silently returns a subset with no error. Iterate the whole fleet
    // instead, same discovery source list-agents/checkGoalStaleness use.
    if (!env.frameworkRoot) {
      render(listExperiments(env.agentDir || process.cwd(), { status: opts.status, metric: opts.metric }));
      return;
    }
    render(listAllExperiments(env.frameworkRoot, env.ctxRoot, {
      status: opts.status,
      metric: opts.metric,
    }));
  });

busCommand
  .command('gather-context')
  .description('Gather experiment context for an agent')
  .option('--agent <name>', 'Agent name')
  .option('--format <fmt>', 'Output format: json or markdown', 'json')
  .action((opts: { agent?: string; format?: string }) => {
    const env = resolveEnv();
    const agentName = opts.agent || env.agentName;
    const agentDir = opts.agent && env.frameworkRoot
      ? resolveAgentDir(env.frameworkRoot, env.org, opts.agent)
      : (env.agentDir || process.cwd());
    const context = gatherContext(agentDir, agentName, { format: opts.format as 'json' | 'markdown' });
    console.log(JSON.stringify(context, null, 2));
  });

busCommand
  .command('manage-cycle')
  .description('Manage experiment cycles')
  .argument('<action>', 'Action: create, modify, remove, list')
  .argument('<agent>', 'Agent name')
  .option('--metric <name>', 'Metric name')
  .option('--metric-type <type>', 'Metric type: quantitative or qualitative')
  .option('--surface <path>', 'Surface path (file to experiment on)')
  .option('--direction <dir>', 'Direction: higher or lower')
  .option('--window <dur>', 'Measurement window (how long before evaluating)')
  .option('--measurement <method>', 'How to measure the metric')
  .option('--loop-interval <dur>', 'Cron frequency for the experiment loop')
  .option('--enabled <bool>', 'Enable or pause the cycle (true/false)')
  .option('--cycle <name>', 'Cycle name')
  .action((action: string, agent: string, opts: { metric?: string; metricType?: string; surface?: string; direction?: string; window?: string; measurement?: string; loopInterval?: string; enabled?: string; cycle?: string }) => {
    const env = resolveEnv();
    // Cycles live in the TARGET agent's experiments/config.json — the file
    // the autoresearch skill reads in that agent's session. Writing to the
    // caller's dir instead silently created a second registry the target
    // never reads.
    let agentDir: string | null = null;
    try {
      agentDir = resolveTargetAgentDir(env, agent);
    } catch (err) {
      console.error((err as Error).message);
      process.exit(1);
    }
    if (!agentDir && agent === env.agentName) {
      agentDir = env.agentDir || process.cwd();
    }
    if (!agentDir) {
      console.error(`Cannot resolve agent directory for '${agent}'. Cycles are stored in the target agent's experiments/config.json — check the agent name.`);
      process.exit(1);
    }
    if (opts.direction && opts.direction !== 'higher' && opts.direction !== 'lower') {
      console.error(`Invalid --direction '${opts.direction}'. Must be 'higher' or 'lower'`);
      process.exit(1);
    }
    if (opts.metricType && opts.metricType !== 'quantitative' && opts.metricType !== 'qualitative') {
      console.error(`Invalid --metric-type '${opts.metricType}'. Must be 'quantitative' or 'qualitative'`);
      process.exit(1);
    }
    const cycles = manageCycle(agentDir, action as 'create' | 'modify' | 'remove' | 'list', {
      agent,
      name: opts.cycle,
      metric: opts.metric,
      metric_type: opts.metricType as 'quantitative' | 'qualitative' | undefined,
      surface: opts.surface,
      direction: opts.direction as 'higher' | 'lower',
      window: opts.window,
      measurement: opts.measurement,
      loop_interval: opts.loopInterval,
      enabled: opts.enabled !== undefined ? opts.enabled === 'true' : undefined,
    });
    console.log(JSON.stringify(cycles, null, 2));
  });

busCommand
  .command('browse-catalog')
  .description('Browse community catalog for items')
  .option('--type <type>', 'Filter by type (skill, agent, org)')
  .option('--tag <tag>', 'Filter by tag')
  .option('--search <query>', 'Search by name or description')
  .action((opts: { type?: string; tag?: string; search?: string }) => {
    const env = resolveEnv();
    const frameworkRoot = env.frameworkRoot || env.projectRoot || process.cwd();
    const result = browseCatalog(frameworkRoot, env.ctxRoot, {
      type: opts.type,
      tag: opts.tag,
      search: opts.search,
    });
    console.log(JSON.stringify(result, null, 2));
  });

busCommand
  .command('install-community-item')
  .description('Install a community catalog item')
  .argument('<name>', 'Item name to install')
  .option('--dry-run', 'Show what would be installed without modifying files')
  .action((name: string, opts: { dryRun?: boolean }) => {
    const env = resolveEnv();
    const frameworkRoot = env.frameworkRoot || env.projectRoot || process.cwd();
    const result = installCommunityItem(frameworkRoot, env.ctxRoot, name, {
      dryRun: opts.dryRun,
      agentDir: env.agentDir,
    });
    console.log(JSON.stringify(result, null, 2));
  });

busCommand
  .command('prepare-submission')
  .description('Prepare a skill/agent/org for community submission with PII scanning')
  .argument('<type>', 'Item type (skill, agent, org)')
  .argument('<source-path>', 'Source directory path')
  .argument('<name>', 'Item name')
  .option('--dry-run', 'Scan without keeping staged files')
  .action((type: string, sourcePath: string, name: string, opts: { dryRun?: boolean }) => {
    const env = resolveEnv();
    const result = prepareSubmission(env.ctxRoot, type, sourcePath, name, {
      dryRun: opts.dryRun,
    });
    console.log(JSON.stringify(result, null, 2));
  });

busCommand
  .command('submit-community-item')
  .description('Submit a prepared item to the community catalog')
  .argument('<name>', 'Item name')
  .argument('<type>', 'Item type (skill, agent, org)')
  .argument('<description>', 'Item description')
  .option('--dry-run', 'Show what would be submitted')
  .option('--author <author>', 'Author name or handle for attribution')
  .option('--contribute', 'Create branch, push to origin, and open a PR against upstream')
  .action((name: string, type: string, description: string, opts: { dryRun?: boolean; author?: string; contribute?: boolean }) => {
    const env = resolveEnv();
    const frameworkRoot = env.frameworkRoot || env.projectRoot || process.cwd();
    const result = submitCommunityItem(frameworkRoot, env.ctxRoot, name, type, description, {
      dryRun: opts.dryRun,
      author: opts.author,
      contribute: opts.contribute,
    });
    console.log(JSON.stringify(result, null, 2));
  });

busCommand
  .command('collect-metrics')
  .description('Collect and aggregate system metrics across all agents')
  .action(() => {
    const env = resolveEnv();
    const report = collectMetrics(env.ctxRoot, env.org || undefined);
    console.log(JSON.stringify(report, null, 2));
  });

busCommand
  .command('scrape-usage')
  .description('Parse Claude Code /usage output and store usage data')
  .argument('<agent>', 'Agent name')
  .argument('<output>', 'Usage output text to parse')
  .action((agent: string, output: string) => {
    const env = resolveEnv();
    const data = parseUsageOutput(output, agent);
    storeUsageData(env.ctxRoot, data);
    console.log(JSON.stringify(data, null, 2));
  });

busCommand
  .command('check-upstream')
  .description('Check canonical repo for framework updates')
  .option('--apply', 'Merge upstream changes (requires user approval)')
  .action((opts: { apply?: boolean }) => {
    const env = resolveEnv();
    const frameworkRoot = env.frameworkRoot || env.projectRoot || process.cwd();
    const result = checkUpstream(frameworkRoot, { apply: opts.apply });
    console.log(JSON.stringify(result, null, 2));
  });

busCommand
  .command('register-telegram-commands')
  .description('Register skills as Telegram bot commands')
  .argument('<bot-token>', 'Telegram bot token')
  .argument('<scan-dirs...>', 'Directories to scan for skills')
  .action(async (botToken: string, scanDirs: string[]) => {
    const commands = collectTelegramCommands(scanDirs);
    const result = await registerTelegramCommands(botToken, commands);
    console.log(JSON.stringify(result, null, 2));
  });

busCommand
  .command('send-telegram')
  .description('Send a message to a Telegram chat')
  .argument('<chat-id>', 'Telegram chat ID')
  .argument('[message]', 'Message text (supports Telegram Markdown unless --plain-text is set). Omit the argument, or pass "-", to read the body from stdin — the safe way to send a body containing backticks, $(, or apostrophes byte-identical.')
  .option('--image <path>', 'Send a photo with caption')
  .option('--file <path>', 'Send a document/file with caption (any file type)')
  .option('--plain-text', 'Skip Telegram Markdown parsing entirely. Use this when the message contains unescaped _, *, backtick, or [ that would otherwise trip the Markdown parser. Without this flag, sendMessage still retries once with parse_mode disabled on a parse-entity error — so it is purely an opt-in to save the retry roundtrip.', false)
  .option('--body-file <path>', 'Read the message body from a file instead of the shell argument or stdin — the safe way to send a body containing backticks, $(, or apostrophes byte-identical')
  .action(async (chatId: string, message: string | undefined, opts: { image?: string; file?: string; plainText?: boolean; bodyFile?: string }) => {
    // Fail-closed body resolution (2026-08-15 fleet incidents — see
    // src/utils/resolve-message-body.ts): --body-file/stdin are the safe
    // default path; an inline body containing a surviving backtick/$( is
    // rejected loud rather than sent with silently-substituted holes in it.
    try {
      message = resolveMessageBody({ inlineText: message, bodyFile: opts.bodyFile });
    } catch (err) {
      if (err instanceof UnsafeInlineBodyError) {
        console.error(err.message);
        process.exit(1);
      }
      throw err;
    }
    // Codex agents emit literal '\n'/'\t' inside single-quoted bash where bash
    // does not expand escapes, so they arrive at argv as 2-char literals and
    // Telegram renders them as visible text. Normalize before send + log.
    message = message.replace(/\\n/g, '\n').replace(/\\t/g, '\t');
    // Resolve bot token: agent .env first, then process.env
    const env = resolveEnv();
    let botToken = '';

    // 1. Check agent .env (most specific)
    if (env.agentDir) {
      const { readFileSync, existsSync } = require('fs');
      const { join } = require('path');
      const agentEnv = join(env.agentDir, '.env');
      if (existsSync(agentEnv)) {
        const content = readFileSync(agentEnv, 'utf-8');
        const match = content.match(/^BOT_TOKEN=(.+)$/m);
        if (match && match[1].trim()) botToken = match[1].trim();
      }
    }

    // 2. Fall back to process env
    if (!botToken) {
      botToken = process.env.BOT_TOKEN || '';
    }

    if (!botToken) {
      console.error('Error: BOT_TOKEN not configured. Set it in your agent .env file or as an environment variable to enable Telegram.');
      process.exit(1);
    }

    const api = new TelegramAPI(botToken);
    try {
      let sentMessageId = 0;
      if (opts.image) {
        const result = await api.sendPhoto(chatId, opts.image, message);
        sentMessageId = result?.result?.message_id ?? 0;
      } else if (opts.file) {
        const result = await api.sendDocument(chatId, opts.file, message);
        sentMessageId = result?.result?.message_id ?? 0;
      } else {
        const result = await api.sendMessage(chatId, message, undefined, {
          parseMode: opts.plainText ? null : 'HTML',
        });
        sentMessageId = result?.result?.message_id ?? 0;
      }

      // Log outbound and cache last-sent for context injection
      const env = resolveEnv();
      if (env.agentName && env.ctxRoot) {
        logOutboundMessage(env.ctxRoot, env.agentName, chatId, message, sentMessageId, {
          parseMode: opts.plainText ? 'none' : 'html',
        });
        cacheLastSent(env.ctxRoot, env.agentName, chatId, message);
        // Auto-emit activity event so dashboard sees every Telegram send,
        // even from agents that never call log-event directly.
        try {
          const paths = resolvePaths(env.agentName, env.instanceId, env.org, env.ctxRoot);
          const preview = message.length > 120 ? message.slice(0, 120) + '…' : message;
          logEvent(paths, env.agentName, env.org, 'message', 'telegram_sent', 'info', JSON.stringify({ chat_id: chatId, message_id: sentMessageId, preview }), { refreshHeartbeat: true });
        } catch { /* non-fatal */ }
      }

      console.log('Message sent');
    } catch (err: any) {
      console.error(`Failed to send: ${err.message || err}`);
      process.exit(1);
    }
  });

busCommand
  .command('react-telegram')
  .description("Set the bot's reaction on a Telegram message (single emoji ack)")
  .argument('<chat-id>', 'Telegram chat ID')
  .argument('<message-id>', 'ID of the message to react to')
  .argument('[emoji]', 'Reaction emoji (default: 👍). Pass an empty string to clear.', '👍')
  .action(async (chatId: string, messageIdRaw: string, emoji: string) => {
    const messageId = Number(messageIdRaw);
    if (!Number.isFinite(messageId) || messageId <= 0) {
      console.error(`Invalid message-id '${messageIdRaw}'. Must be a positive integer.`);
      process.exit(1);
    }

    // Resolve bot token: agent .env first, then process.env (same flow as
    // send-telegram so the agent identity / personality of the reaction
    // matches the agent that owns the conversation).
    const env = resolveEnv();
    let botToken = '';
    if (env.agentDir) {
      const { readFileSync, existsSync } = require('fs');
      const { join } = require('path');
      const agentEnv = join(env.agentDir, '.env');
      if (existsSync(agentEnv)) {
        const content = readFileSync(agentEnv, 'utf-8');
        const match = content.match(/^BOT_TOKEN=(.+)$/m);
        if (match && match[1].trim()) botToken = match[1].trim();
      }
    }
    if (!botToken) botToken = process.env.BOT_TOKEN || '';
    if (!botToken) {
      console.error('Error: BOT_TOKEN not configured. Set it in your agent .env file or as an environment variable to enable Telegram.');
      process.exit(1);
    }

    const api = new TelegramAPI(botToken);
    try {
      // Empty string clears the reaction; otherwise send a single-emoji array.
      // Telegram limits bots to one reaction per message; we treat that as the
      // primitive here. Multi-emoji is a future feature if/when needed.
      const emojis = emoji === '' ? [] : [emoji];
      await api.setMessageReaction(chatId, messageId, emojis);
      console.log(emojis.length > 0 ? `Reacted ${emoji}` : 'Reaction cleared');
    } catch (err: any) {
      console.error(`Failed to react: ${err.message || err}`);
      process.exit(1);
    }
  });

busCommand
  .command('create-approval')
  .description('Request human approval for a high-stakes action')
  .argument('<title>', 'What you are requesting approval for')
  .argument('<category>', 'Category: external-comms, financial, deployment, data-deletion, other')
  .argument('[context]', 'Additional context')
  .action(async (title: string, category: string, context?: string) => {
    const validCategories: ApprovalCategory[] = ['external-comms', 'financial', 'deployment', 'data-deletion', 'other'];
    if (!validCategories.includes(category as ApprovalCategory)) {
      console.error(`Invalid category '${category}'. Must be one of: ${validCategories.join(', ')}`);
      process.exit(1);
    }
    const env = resolveEnv();
    const paths = resolvePaths(env.agentName, env.instanceId, env.org, env.ctxRoot);
    // await — createApproval fan-out posts to the activity channel, which
    // must complete before the CLI process exits or the post silently
    // never sends. env.frameworkRoot is passed so the activity-channel
    // orgDir resolves to where activity-channel.env actually lives (the
    // framework repo path, NOT the runtime state path — see
    // src/bus/approval.ts:postApprovalToActivityChannel for the history).
    const id = await createApproval(paths, env.agentName, env.org, title, category as ApprovalCategory, context || '', env.frameworkRoot, env.agentDir);
    console.log(id);
  });

busCommand
  .command('update-approval')
  .description('Resolve an approval request')
  .argument('<id>', 'Approval ID')
  .argument('<status>', 'Resolution: approved or denied')
  .argument('[note]', 'Resolution note')
  .action((id: string, status: string, note?: string) => {
    const validStatuses: ApprovalStatus[] = ['approved', 'rejected'];
    if (!validStatuses.includes(status as ApprovalStatus)) {
      console.error(`Invalid status '${status}'. Must be one of: approved, rejected`);
      process.exit(1);
    }
    const env = resolveEnv();
    const paths = resolvePaths(env.agentName, env.instanceId, env.org, env.ctxRoot);
    updateApproval(paths, id, status as ApprovalStatus, note);
    console.log(`Approval ${id} -> ${status}`);
  });

// ---------------------------------------------------------------------------
// Knowledge Base commands
// ---------------------------------------------------------------------------

// kb-query's <question> is free-form text and can legitimately start with '-'
// (a markdown bullet line copied verbatim is the common case). Commander parses
// a leading-dash positional as an unrecognized option before the action handler
// ever runs, so the shielding has to happen on argv itself, pre-parse. Exported
// so index.ts can apply it right before program.parse(); derives the "is this
// actually one of kb-query's own flags" check from the command's own registered
// options rather than a hand-maintained list, so it can't drift from the
// .option() calls below (see task_1786910207793_59268544).
export const KB_QUERY_DASH_SENTINEL = ' kb-query-literal-dash ';

export function shieldKbQueryLeadingDash(argv: string[]): string[] {
  const idx = argv.indexOf('kb-query');
  if (idx === -1) return argv;
  const next = argv[idx + 1];
  if (!next || !next.startsWith('-') || next === '--') return argv;

  const kbQueryCmd = busCommand.commands.find((c) => c.name() === 'kb-query');
  const knownFlags = new Set<string>(['-h', '--help']);
  for (const o of kbQueryCmd?.options ?? []) {
    if (o.short) knownFlags.add(o.short);
    if (o.long) knownFlags.add(o.long);
  }
  if (knownFlags.has(next)) return argv;

  const patched = argv.slice();
  patched[idx + 1] = KB_QUERY_DASH_SENTINEL + next;
  return patched;
}

busCommand
  .command('kb-query')
  .description('Query the knowledge base (RAG search)')
  .argument('<question>', 'Question or search query')
  .option('--org <org>', 'Organization name')
  .option('--agent <name>', 'Agent name (for private scope)')
  .option('--scope <s>', 'Scope: shared, private, or all', 'all')
  .option('--top-k <n>', 'Number of results', '5')
  .option('--threshold <f>', 'Minimum similarity score (0-1)', '0.5')
  .option('--json', 'Output raw JSON')
  .action((rawQuestion: string, opts: { org?: string; agent?: string; scope?: string; topK?: string; threshold?: string; json?: boolean }) => {
    // A query starting with '-' (e.g. a markdown bullet line) already survived
    // commander's parser by the time we're here, thanks to shieldKbQueryLeadingDash
    // below stripping it back down to the literal text — see task_1786910207793_59268544.
    const question = rawQuestion.startsWith(KB_QUERY_DASH_SENTINEL)
      ? rawQuestion.slice(KB_QUERY_DASH_SENTINEL.length)
      : rawQuestion;
    const env = resolveEnv();
    const org = opts.org || env.org;
    if (!org) {
      console.error('ERROR: --org or CTX_ORG required');
      process.exit(1);
    }

    const result = queryKnowledgeBase(
      resolvePaths(env.agentName, env.instanceId, org, env.ctxRoot),
      question,
      {
        org,
        agent: opts.agent || env.agentName,
        scope: (opts.scope as 'shared' | 'private' | 'all') || 'all',
        topK: parseInt(opts.topK || '5', 10),
        threshold: parseFloat(opts.threshold || '0.5'),
        frameworkRoot: env.frameworkRoot || process.cwd(),
        instanceId: env.instanceId,
      },
    );

    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    if (result.results.length === 0) {
      console.log(`No results found for: "${question}"`);
      return;
    }

    console.log(`\n  Knowledge Base Results (${result.results.length}/${result.total})\n`);
    for (let i = 0; i < result.results.length; i++) {
      const r = result.results[i];
      console.log(`  [${i + 1}] Score: ${r.score.toFixed(3)} | ${r.source_file}`);
      console.log(`      ${r.content.substring(0, 200).replace(/\n/g, ' ')}...`);
      console.log('');
    }
  });

busCommand
  .command('kb-ingest')
  .description('Ingest files or directories into the knowledge base')
  .argument('<paths...>', 'Files or directories to ingest')
  .option('--org <org>', 'Organization name')
  .option('--agent <name>', 'Agent name (for private scope)')
  .option('--scope <s>', 'Scope: shared or private', 'shared')
  .option('--force', 'Re-ingest even if already indexed')
  .action((paths: string[], opts: { org?: string; agent?: string; scope?: string; force?: boolean }) => {
    const env = resolveEnv();
    const org = opts.org || env.org;
    if (!org) {
      console.error('ERROR: --org or CTX_ORG required');
      process.exit(1);
    }

    ensureKBDirs(env.instanceId, env.frameworkRoot, org);

    ingestKnowledgeBase(paths, {
      org,
      agent: opts.agent || env.agentName,
      scope: (opts.scope as 'shared' | 'private') || 'shared',
      force: opts.force,
      frameworkRoot: env.frameworkRoot || process.cwd(),
      instanceId: env.instanceId,
    });
  });

busCommand
  .command('kb-delete')
  .description('Delete a previously-ingested source file from the knowledge base')
  .argument('<path>', 'Source file path that was ingested')
  .option('--org <org>', 'Organization name')
  .option('--agent <name>', 'Agent name (for private scope)')
  .option('--scope <s>', 'Scope: shared or private', 'shared')
  .action((sourcePath: string, opts: { org?: string; agent?: string; scope?: string }) => {
    const env = resolveEnv();
    const org = opts.org || env.org;
    if (!org) {
      console.error('ERROR: --org or CTX_ORG required');
      process.exit(1);
    }

    deleteFromKnowledgeBase(sourcePath, {
      org,
      agent: opts.agent || env.agentName,
      scope: (opts.scope as 'shared' | 'private') || 'shared',
      frameworkRoot: env.frameworkRoot || process.cwd(),
      instanceId: env.instanceId,
    });
  });

busCommand
  .command('kb-collections')
  .description('List knowledge base collections and document counts')
  .option('--org <org>', 'Organization name')
  .action((opts: { org?: string }) => {
    const env = resolveEnv();
    const org = opts.org || env.org;
    if (!org) {
      console.error('ERROR: --org or CTX_ORG required');
      process.exit(1);
    }

    const { execFileSync } = require('child_process');
    const { existsSync, readFileSync } = require('fs');
    const { join: pjoin } = require('path');
    const { homedir: hdir } = require('os');

    const frameworkRoot = env.frameworkRoot || process.cwd();
    const instanceId = env.instanceId;
    const kbRoot = pjoin(hdir(), '.cortextos', instanceId, 'orgs', org, 'knowledge-base');
    const chromaDir = pjoin(kbRoot, 'chromadb');
    const isWin = process.platform === 'win32';
    const venvBin = isWin ? 'Scripts' : 'bin';
    const pythonExe = isWin ? 'python.exe' : 'python3';
    const pythonPath = pjoin(frameworkRoot, 'knowledge-base', 'venv', venvBin, pythonExe);
    const mmragPath = pjoin(frameworkRoot, 'knowledge-base', 'scripts', 'mmrag.py');

    // Load .env and secrets.env (same as bash `source`)
    const envFiles = [
      pjoin(frameworkRoot, '.env'),
      pjoin(frameworkRoot, 'orgs', org, 'secrets.env'),
    ];
    const extraVars: Record<string, string> = {};
    for (const ef of envFiles) {
      if (existsSync(ef)) {
        for (const line of readFileSync(ef, 'utf-8').split('\n')) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith('#')) continue;
          const idx = trimmed.indexOf('=');
          if (idx > 0) {
            let val = trimmed.slice(idx + 1);
            if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
              val = val.slice(1, -1);
            }
            extraVars[trimmed.slice(0, idx)] = val;
          }
        }
      }
    }

    if (!existsSync(chromaDir)) {
      console.log('No collections found. Run kb-ingest first.');
      process.exit(0);
    }

    const envVars: Record<string, string | undefined> = {
      ...process.env,
      ...extraVars,
      CTX_ORG: org,
      CTX_INSTANCE_ID: instanceId,
      CTX_FRAMEWORK_ROOT: frameworkRoot,
      MMRAG_DIR: kbRoot,
      MMRAG_CHROMADB_DIR: chromaDir,
      MMRAG_CONFIG: pjoin(kbRoot, 'config.json'),
    };
    try {
      execFileSync(pythonPath, [mmragPath, 'collections'], {
        stdio: 'inherit',
        env: envVars,
      });
    } catch {
      // python printed error already
      process.exit(1);
    }
  });

// ---------------------------------------------------------------------------
// Hook subcommands — cross-platform replacements for hook-*.sh bash scripts
// These are invoked by Claude Code settings.json hooks on all platforms.
// ---------------------------------------------------------------------------

function runHook(hookName: string): void {
  const hookPath = join(__dirname, `hooks/${hookName}.js`);
  const result = spawnSync(process.execPath, [hookPath], { stdio: 'inherit' });
  process.exit(result.status ?? 0);
}

// ---------------------------------------------------------------------------
// Telegram utility commands — parity with bash edit-message / answer-callback
// ---------------------------------------------------------------------------

busCommand
  .command('edit-message')
  .description('Edit an existing Telegram message text and optionally update inline keyboard')
  .argument('<chat-id>', 'Telegram chat ID')
  .argument('<message-id>', 'Message ID to edit')
  .argument('<new-text>', 'Replacement text (Telegram Markdown)')
  .argument('[reply-markup]', 'Optional JSON inline keyboard markup (pass "null" to clear)')
  .action(async (chatId: string, messageId: string, newText: string, replyMarkup?: string) => {
    const env = resolveEnv();
    let botToken = '';
    if (env.agentDir) {
      const { readFileSync, existsSync } = require('fs');
      const agentEnv = require('path').join(env.agentDir, '.env');
      if (existsSync(agentEnv)) {
        const match = readFileSync(agentEnv, 'utf-8').match(/^BOT_TOKEN=(.+)$/m);
        if (match?.[1]?.trim()) botToken = match[1].trim();
      }
    }
    if (!botToken) botToken = process.env.BOT_TOKEN || '';
    if (!botToken) {
      console.error('Error: BOT_TOKEN not configured. Set it in your agent .env file or as an environment variable to enable Telegram.');
      process.exit(1);
    }

    const api = new TelegramAPI(botToken);
    let markup: object | undefined;
    if (replyMarkup && replyMarkup !== 'null') {
      try { markup = JSON.parse(replyMarkup); } catch { console.error('Invalid reply-markup JSON'); process.exit(1); }
    } else {
      markup = { inline_keyboard: [] }; // clear keyboard
    }

    try {
      await api.editMessageText(parseInt(chatId, 10), parseInt(messageId, 10), newText, markup);
      console.log('Message edited');
    } catch (err: any) {
      console.error(`Failed to edit message: ${err.message || err}`);
      process.exit(1);
    }
  });

busCommand
  .command('answer-callback')
  .description('Answer a Telegram callback query to dismiss button loading state')
  .argument('<callback-query-id>', 'Callback query ID from Telegram update')
  .argument('[toast-text]', 'Optional toast notification text', 'Got it')
  .action(async (callbackQueryId: string, toastText: string) => {
    const env = resolveEnv();
    let botToken = '';
    if (env.agentDir) {
      const { readFileSync, existsSync } = require('fs');
      const agentEnv = require('path').join(env.agentDir, '.env');
      if (existsSync(agentEnv)) {
        const match = readFileSync(agentEnv, 'utf-8').match(/^BOT_TOKEN=(.+)$/m);
        if (match?.[1]?.trim()) botToken = match[1].trim();
      }
    }
    if (!botToken) botToken = process.env.BOT_TOKEN || '';
    if (!botToken) {
      console.error('Error: BOT_TOKEN not configured. Set it in your agent .env file or as an environment variable to enable Telegram.');
      process.exit(1);
    }

    const api = new TelegramAPI(botToken);
    try {
      await api.answerCallbackQuery(callbackQueryId, toastText);
      console.log('Callback answered');
    } catch (err: any) {
      console.error(`Failed to answer callback: ${err.message || err}`);
      process.exit(1);
    }
  });

// ---------------------------------------------------------------------------
// Agent discovery and skill discovery
// ---------------------------------------------------------------------------

busCommand
  .command('list-agents')
  .description('Discover all agents in the system with their status and roles')
  .option('--org <org>', 'Filter by organization')
  .option('--status <filter>', 'Filter by status: running|all', 'all')
  .option('--format <fmt>', 'Output format: json|text', 'json')
  .action(async (opts: { org?: string; status?: string; format?: string }) => {
    const { existsSync, readdirSync, readFileSync } = require('fs');
    const { join } = require('path');
    const env = resolveEnv();
    const ctxRoot = env.ctxRoot;
    const frameworkRoot = env.frameworkRoot || process.cwd();

    // Collect agents from enabled-agents.json + filesystem scan (shared with
    // any other fleet-wide scan — see discoverAllAgents's docblock).
    const agentMap: Record<string, { org: string; enabled: boolean }> = {};
    for (const a of discoverAllAgents(frameworkRoot, ctxRoot)) {
      agentMap[a.name] = { org: a.org, enabled: a.enabled };
    }

    // Determine running agents via IPC daemon.
    const runningAgents = new Set<string>();
    const ipc = new IPCClient(env.instanceId);
    try {
      const resp = await ipc.send({ type: 'status', source: 'cortextos bus' });
      if (resp.success && Array.isArray(resp.data)) {
        for (const a of resp.data as Array<{ name: string; status: string }>) {
          if (a.status === 'running') runningAgents.add(a.name);
        }
      }
    } catch {
      // Daemon not running — no running agent data available
    }

    const results = [];
    for (const [name, info] of Object.entries(agentMap)) {
      if (opts.org && info.org !== opts.org) continue;

      const running = runningAgents.has(name);
      if (opts.status === 'running' && !running) continue;

      // Read role from IDENTITY.md
      let role = '';
      const agentDir = info.org
        ? resolveAgentDir(frameworkRoot, info.org, name)
        : join(frameworkRoot, 'agents', name);
      const identityFile = join(agentDir, 'IDENTITY.md');
      if (existsSync(identityFile)) {
        const content = readFileSync(identityFile, 'utf-8');
        const m = content.match(/^## Role\s*\n(.+)/m);
        if (m) role = m[1].trim();
      }

      // Read heartbeat
      const hbFile = join(ctxRoot, 'state', name, 'heartbeat.json');
      let lastHeartbeat = '', currentTask = '', mode = '';
      if (existsSync(hbFile)) {
        try {
          const hb = JSON.parse(readFileSync(hbFile, 'utf-8'));
          lastHeartbeat = hb.last_heartbeat ?? '';
          currentTask = hb.current_task ?? '';
          mode = hb.mode ?? '';
        } catch { /* skip */ }
      }

      results.push({ name, org: info.org, role, enabled: info.enabled, running, last_heartbeat: lastHeartbeat, current_task: currentTask, mode });
    }

    if (opts.format === 'text') {
      console.log(`Agents in system:\n`);
      for (const a of results) {
        const status = a.running ? 'RUNNING' : 'stopped';
        console.log(`  ${a.name} (${a.org || 'root'}) [${status}]`);
        if (a.role) console.log(`    Role: ${a.role}`);
        if (a.current_task) console.log(`    Working on: ${a.current_task}`);
        console.log('');
      }
      console.log(`Total: ${results.length} agents`);
    } else {
      console.log(JSON.stringify(results, null, 2));
    }
  });

busCommand
  .command('list-skills')
  .description('Discover available skills for the current agent')
  .option('--format <fmt>', 'Output format: json|text', 'json')
  .action((opts: { format?: string }) => {
    const { existsSync, readdirSync, readFileSync } = require('fs');
    const { join } = require('path');
    const env = resolveEnv();
    const frameworkRoot = env.frameworkRoot || process.cwd();
    const agentDir = env.agentDir || process.cwd();

    // Read template from config.json
    let template = '';
    const configFile = join(agentDir, 'config.json');
    if (existsSync(configFile)) {
      try { template = JSON.parse(readFileSync(configFile, 'utf-8')).template ?? ''; } catch { /* skip */ }
    }

    // Parse YAML frontmatter from SKILL.md
    function parseSkillFrontmatter(filePath: string): { name: string; description: string } | null {
      try {
        const content = readFileSync(filePath, 'utf-8');
        const lines = content.split('\n');
        let inFrontmatter = false;
        let name = '', description = '';
        for (const line of lines) {
          if (line.trim() === '---') {
            if (inFrontmatter) break;
            inFrontmatter = true;
            continue;
          }
          if (!inFrontmatter) continue;
          const nm = line.match(/^name:\s*['"]?(.+?)['"]?\s*$/);
          if (nm) name = nm[1];
          const dm = line.match(/^description:\s*['"]?(.+?)['"]?\s*$/);
          if (dm) description = dm[1];
        }
        return name ? { name, description } : null;
      } catch { return null; }
    }

    type SkillInfo = { name: string; description: string; path: string; source: string };

    // Scan a skills directory, returns map of name -> skill info
    function scanSkillsDir(dir: string, source: string): Map<string, SkillInfo> {
      const map = new Map<string, SkillInfo>();
      if (!existsSync(dir)) return map;
      for (const entry of readdirSync(dir)) {
        const skillFile = join(dir, entry, 'SKILL.md');
        if (!existsSync(skillFile)) continue;
        const parsed = parseSkillFrontmatter(skillFile);
        if (parsed) map.set(parsed.name, { ...parsed, path: skillFile, source });
      }
      return map;
    }

    // Merge in priority order: framework < template < agent (agent wins)
    const merged = new Map<string, SkillInfo>();
    for (const [k, v] of scanSkillsDir(join(frameworkRoot, '.claude', 'skills'), 'framework')) merged.set(k, v);
    if (template) {
      for (const [k, v] of scanSkillsDir(join(frameworkRoot, 'templates', template, '.claude', 'skills'), `template:${template}`)) merged.set(k, v);
    }
    for (const [k, v] of scanSkillsDir(join(agentDir, '.claude', 'skills'), 'agent')) merged.set(k, v);

    const skills = Array.from(merged.values()).sort((a, b) => a.name.localeCompare(b.name));

    if (opts.format === 'text') {
      console.log(`Available skills for ${env.agentName}:\n`);
      for (const s of skills) {
        console.log(`  ${s.name} (${s.source})`);
        if (s.description) console.log(`    ${s.description}`);
        console.log('');
      }
      console.log(`Total: ${skills.length} skills`);
    } else {
      console.log(JSON.stringify(skills, null, 2));
    }
  });

// ---------------------------------------------------------------------------
// Agent coordination: notify-agent, soft-restart, send-mobile-reply
// ---------------------------------------------------------------------------

busCommand
  .command('notify-agent')
  .description('Send urgent signal to another agent for immediate delivery via fast-checker')
  .argument('<agent>', 'Target agent name')
  .argument('<message>', 'Urgent message text')
  .action((targetAgent: string, message: string) => {
    const { mkdirSync, writeFileSync } = require('fs');
    const { join } = require('path');
    const env = resolveEnv();
    const paths = resolvePaths(env.agentName, env.instanceId, env.org, env.ctxRoot);
    const ctxRoot = env.ctxRoot;

    // Write urgent signal file that fast-checker checks on every poll
    const signalDir = join(ctxRoot, 'state', targetAgent);
    mkdirSync(signalDir, { recursive: true });
    const signal = {
      from: env.agentName,
      message,
      timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    };
    writeFileSync(join(signalDir, '.urgent-signal'), JSON.stringify(signal));

    // Also send via normal message bus for persistence
    try {
      sendMessage(paths, env.agentName, targetAgent, 'urgent', message);
    } catch { /* signal already written */ }

    console.log(`Signal sent to ${targetAgent}`);
  });

busCommand
  .command('soft-restart')
  .description('Gracefully restart another agent by writing the restart marker then sending /exit')
  .argument('<agent>', 'Target agent name to restart')
  .argument('[reason]', 'Reason for restart', 'user request via soft-restart')
  .action(async (targetAgent: string, reason: string) => {
    const { mkdirSync, writeFileSync } = require('fs');
    const { join } = require('path');
    const env = resolveEnv();
    const ctxRoot = env.ctxRoot;

    // Step 1: Write .user-restart marker BEFORE triggering exit
    const stateDir = join(ctxRoot, 'state', targetAgent);
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, '.user-restart'), reason);
    console.log(`Wrote .user-restart marker for ${targetAgent}: ${reason}`);

    // Step 2: Send restart via IPC daemon (cross-platform — named pipe on Windows, socket on Unix).
    const ipc = new IPCClient(env.instanceId);
    const daemonRunning = await ipc.isDaemonRunning();

    if (daemonRunning) {
      const resp = await ipc.send({ type: 'restart-agent', agent: targetAgent, source: 'cortextos bus soft-restart' });
      if (resp.success) {
        console.log(`Restarted ${targetAgent} via daemon IPC`);
      } else {
        console.error(`Daemon restart failed: ${resp.error}`);
        process.exit(1);
      }
    } else {
      console.error('ERROR: Node daemon is not running. Start it with: cortextos start');
      process.exit(1);
    }
  });

busCommand
  .command('soft-restart-all')
  .description('Soft-restart all enabled agents in the org with optional stagger delay')
  .option('--stagger <seconds>', 'Seconds between each agent restart', '5')
  .option('--reason <why>', 'Reason for restart', 'soft-restart-all requested')
  .action(async (opts: { stagger: string; reason: string }) => {
    const { mkdirSync, writeFileSync, readFileSync, existsSync } = require('fs');
    const { join } = require('path');
    const env = resolveEnv();
    const ctxRoot = env.ctxRoot;
    const staggerMs = parseInt(opts.stagger, 10) * 1000;

    // Read enabled agents from config
    const enabledFile = join(ctxRoot, 'config', 'enabled-agents.json');
    if (!existsSync(enabledFile)) {
      console.error('ERROR: enabled-agents.json not found at', enabledFile);
      process.exit(1);
    }
    const enabledAgents: Record<string, { enabled: boolean; org?: string }> =
      JSON.parse(readFileSync(enabledFile, 'utf-8'));

    // Filter to enabled agents in this org (if org set)
    const targets = Object.entries(enabledAgents)
      .filter(([, cfg]) => cfg.enabled !== false)
      .filter(([, cfg]) => !env.org || !cfg.org || cfg.org === env.org)
      .map(([name]) => name);

    if (targets.length === 0) {
      console.log('No enabled agents found for org:', env.org || '(all)');
      process.exit(0);
    }

    const ipc = new IPCClient(env.instanceId);
    const daemonRunning = await ipc.isDaemonRunning();
    if (!daemonRunning) {
      console.error('ERROR: Node daemon is not running. Start it with: cortextos start');
      process.exit(1);
    }

    console.log(`Restarting ${targets.length} agent(s) with ${opts.stagger}s stagger: ${targets.join(', ')}`);

    for (let i = 0; i < targets.length; i++) {
      const agent = targets[i];
      if (i > 0) {
        await new Promise(resolve => setTimeout(resolve, staggerMs));
      }
      // Write .user-restart marker
      const stateDir = join(ctxRoot, 'state', agent);
      mkdirSync(stateDir, { recursive: true });
      writeFileSync(join(stateDir, '.user-restart'), opts.reason);

      // Send IPC restart signal
      const resp = await ipc.send({ type: 'restart-agent', agent, source: 'cortextos bus soft-restart-all' });
      if (resp.success) {
        console.log(`[${i + 1}/${targets.length}] Restarted ${agent}`);
      } else {
        console.error(`[${i + 1}/${targets.length}] Failed to restart ${agent}: ${resp.error}`);
      }
    }

    console.log('soft-restart-all complete.');
  });

busCommand
  .command('send-mobile-reply')
  .description('Reply to a mobile app user message and ACK the inbox message')
  .argument('<agent>', 'Agent name sending the reply')
  .argument('<reply>', 'Reply text')
  .argument('[msg-id]', 'Inbox message ID to ACK')
  .action((agent: string, reply: string, msgId?: string) => {
    // Same literal '\n'/'\t' normalize as send-telegram (codex agent fix).
    reply = reply.replace(/\\n/g, '\n').replace(/\\t/g, '\t');
    const { mkdirSync, appendFileSync } = require('fs');
    const { join } = require('path');
    const env = resolveEnv();
    const ctxRoot = env.ctxRoot;

    // Write to outbound-messages.jsonl so iOS app chat history picks it up
    const logDir = join(ctxRoot, 'logs', agent);
    mkdirSync(logDir, { recursive: true });
    const entry = JSON.stringify({
      timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
      agent,
      text: reply,
      message_id: `mobile-reply-${Date.now()}`,
      type: 'text',
    });
    appendFileSync(join(logDir, 'outbound-messages.jsonl'), entry + '\n');

    // ACK the original inbox message
    if (msgId) {
      const paths = resolvePaths(agent, env.instanceId, env.org, env.ctxRoot);
      try { ackInbox(paths, msgId); } catch { /* best effort */ }
    }

    console.log('Replied to mobile user');
  });

// ---------------------------------------------------------------------------
// list-approvals — was missing from CLI, only available via dashboard
// ---------------------------------------------------------------------------

const APPROVAL_STATUSES = ['pending', 'approved', 'rejected'] as const;

/** Every org directory under CTX_ROOT — mirrors dashboard syncAll() behaviour. */
function listOrgDirs(instanceId: string, ctxRoot?: string): string[] {
  const { readdirSync, existsSync } = require('fs');
  const { join } = require('path');
  const { homedir } = require('os');
  const orgsDir = join(ctxRoot || join(homedir(), '.cortextos', instanceId), 'orgs');
  return existsSync(orgsDir)
    ? readdirSync(orgsDir, { withFileTypes: true })
        .filter((d: { isDirectory(): boolean }) => d.isDirectory())
        .map((d: { name: string }) => d.name)
    : [];
}

busCommand
  .command('list-approvals')
  .description('List pending approval requests (--status/--all also reach resolved ones)')
  .option('--format <fmt>', 'Output format: json|text', 'json')
  .option('--status <status>', `Filter by status: ${APPROVAL_STATUSES.join('|')}`)
  .option('--all', 'Include resolved approvals, not just pending', false)
  .option('--all-orgs', 'Scan all orgs under CTX_ROOT (matches dashboard view)', false)
  .action((opts: { format?: string; status?: string; all?: boolean; allOrgs?: boolean }) => {
    const { listApprovals, resolveListStatus } = require('../bus/approval.js');
    const env = resolveEnv();

    // Reject an unknown status loudly. Silently returning [] would be
    // indistinguishable from "no approvals have that status" — the same
    // false-absence this command was fixed to stop producing.
    if (opts.status && !(APPROVAL_STATUSES as readonly string[]).includes(opts.status)) {
      console.error(
        `Unknown status '${opts.status}'. Valid: ${APPROVAL_STATUSES.join(', ')}`,
      );
      process.exitCode = 1;
      return;
    }

    const effectiveStatus = resolveListStatus(opts.status, opts.all);

    let approvals: unknown[] = [];

    if (opts.allOrgs) {
      for (const org of listOrgDirs(env.instanceId, env.ctxRoot)) {
        const orgPaths = resolvePaths(env.agentName, env.instanceId, org, env.ctxRoot);
        approvals = approvals.concat(listApprovals(orgPaths, effectiveStatus));
      }
    } else {
      const paths = resolvePaths(env.agentName, env.instanceId, env.org, env.ctxRoot);
      approvals = listApprovals(paths, effectiveStatus);
    }

    if (opts.format === 'text') {
      const label = effectiveStatus ? `${effectiveStatus} ` : '';
      if (approvals.length === 0) { console.log(`No ${label}approvals`); return; }
      for (const a of approvals as Array<{ id: string; title: string; category: string; status: string; requesting_agent: string; created_at: string; resolved_at?: string | null; resolved_by?: string | null; description?: string; org?: string }>) {
        console.log(`[${a.id}] ${a.title}`);
        console.log(`  Status: ${a.status} | Category: ${a.category} | Agent: ${a.requesting_agent} | Org: ${a.org ?? env.org} | Created: ${a.created_at}`);
        if (a.resolved_at) console.log(`  Resolved: ${a.resolved_at}${a.resolved_by ? ` — ${a.resolved_by}` : ''}`);
        if (a.description) console.log(`  Context: ${a.description}`);
        console.log('');
      }
      console.log(`Total: ${approvals.length} ${label}approval(s)`);
    } else {
      console.log(JSON.stringify(approvals, null, 2));
    }
  });

// ---------------------------------------------------------------------------
// get-approval — point lookup across pending/ AND resolved/.
//
// The recovery path for "what happened to the approval I filed?". updateApproval
// notifies the requesting agent by inbox exactly once; an agent that restarts
// past that message previously had no way to retrieve the decision, because
// every CLI read path looked only at pending/ and a decided approval has moved
// to resolved/. An agent knows its own approval id, so a point lookup — not a
// list — is what actually closes that hole.
// ---------------------------------------------------------------------------

busCommand
  .command('get-approval')
  .argument('<approval-id>', 'Approval id (e.g. approval_1786668730_wllgx)')
  .description('Show one approval and its decision, searching pending and resolved')
  .option('--format <fmt>', 'Output format: json|text', 'json')
  .option('--all-orgs', 'Search all orgs under CTX_ROOT', false)
  .action((approvalId: string, opts: { format?: string; allOrgs?: boolean }) => {
    const { getApproval } = require('../bus/approval.js');
    const env = resolveEnv();

    const orgs = opts.allOrgs ? listOrgDirs(env.instanceId, env.ctxRoot) : [env.org];
    let found: { id: string; title: string; category: string; status: string; requesting_agent: string; created_at: string; updated_at?: string; resolved_at?: string | null; resolved_by?: string | null; description?: string; org?: string } | null = null;
    for (const org of orgs) {
      found = getApproval(resolvePaths(env.agentName, env.instanceId, org, env.ctxRoot), approvalId);
      if (found) break;
    }

    // Absent from BOTH buckets is the only real "does not exist". Say so on
    // stderr and exit non-zero so a caller cannot mistake it for a result.
    if (!found) {
      console.error(
        `Approval ${approvalId} not found in pending or resolved` +
        (opts.allOrgs ? ' (searched all orgs)' : ` for org '${env.org}' — retry with --all-orgs`),
      );
      process.exitCode = 1;
      return;
    }

    if (opts.format === 'text') {
      console.log(`[${found.id}] ${found.title}`);
      console.log(`  Status: ${found.status}`);
      console.log(`  Category: ${found.category} | Agent: ${found.requesting_agent} | Org: ${found.org ?? env.org}`);
      console.log(`  Created: ${found.created_at}`);
      if (found.resolved_at) console.log(`  Resolved: ${found.resolved_at}`);
      if (found.resolved_by) console.log(`  Decision note: ${found.resolved_by}`);
      if (found.description) console.log(`  Context: ${found.description}`);
    } else {
      console.log(JSON.stringify(found, null, 2));
    }
  });

// ---------------------------------------------------------------------------
// Reminder commands — persistent cron state that survives hard-restarts (#69)
// ---------------------------------------------------------------------------

busCommand
  .command('create-reminder')
  .argument('<fire-at>', 'When to fire, ISO 8601 UTC (e.g. 2026-04-05T08:00:00Z)')
  .argument('<prompt>', 'Text to inject into boot prompt when overdue')
  .description('Create a persistent reminder that survives hard-restarts')
  .action((fireAt: string, prompt: string) => {
    const env = resolveEnv();
    const paths = resolvePaths(env.agentName, env.instanceId, env.org, env.ctxRoot);
    const reminder = createReminder(paths, fireAt, prompt);
    console.log(reminder.id);
  });

busCommand
  .command('list-reminders')
  .option('--all', 'Include acked reminders', false)
  .option('--format <fmt>', 'Output format: json or text', 'text')
  .description('List pending (or all) reminders')
  .action((opts: { all?: boolean; format?: string }) => {
    const env = resolveEnv();
    const paths = resolvePaths(env.agentName, env.instanceId, env.org, env.ctxRoot);
    const reminders = listReminders(paths, { all: opts.all });

    if (opts.format === 'json') {
      console.log(JSON.stringify(reminders, null, 2));
      return;
    }

    if (reminders.length === 0) {
      console.log('No pending reminders');
      return;
    }

    const now = Date.now();
    for (const r of reminders) {
      const overdue = Date.parse(r.fire_at) <= now;
      const overdueTag = overdue ? ' [OVERDUE]' : '';
      console.log(`[${r.id}]${overdueTag}`);
      console.log(`  fire_at: ${r.fire_at}  status: ${r.status}`);
      console.log(`  prompt:  ${r.prompt}`);
      console.log('');
    }
  });

busCommand
  .command('ack-reminder')
  .argument('<id>', 'Reminder ID to acknowledge')
  .description('Mark a reminder as handled')
  .action((id: string) => {
    const env = resolveEnv();
    const paths = resolvePaths(env.agentName, env.instanceId, env.org, env.ctxRoot);
    ackReminder(paths, id);
    console.log(`ACK'd reminder ${id}`);
  });

busCommand
  .command('prune-reminders')
  .option('--days <n>', 'Retain acked reminders for N days', '7')
  .description('Delete acked reminders older than N days')
  .action((opts: { days?: string }) => {
    const env = resolveEnv();
    const paths = resolvePaths(env.agentName, env.instanceId, env.org, env.ctxRoot);
    const pruned = pruneReminders(paths, parseInt(opts.days ?? '7', 10));
    console.log(`Pruned ${pruned} acked reminder(s)`);
  });

busCommand
  .command('update-cron-fire')
  .argument('<cron-name>', 'Name of the cron as defined in config.json')
  .option('--interval <interval>', 'Expected interval, e.g. "6h", "24h", "30m"')
  .description('Record that a named cron just fired (enables daemon gap detection for dead zones)')
  .action((cronName: string, opts: { interval?: string }) => {
    const env = resolveEnv();
    const paths = resolvePaths(env.agentName, env.instanceId, env.org, env.ctxRoot);
    updateCronFire(paths.stateDir, cronName, opts.interval);
    console.log(`Recorded fire for cron "${cronName}"`);
  });

// ---------------------------------------------------------------------------
// External Persistent Cron Management (Subtask 1.4)
// ---------------------------------------------------------------------------

/**
 * Validate a schedule string — either an interval shorthand ("6h", "30m") or
 * a 5-field cron expression ("0 8 * * *").  Returns the normalised schedule
 * string, or throws an Error with a human-readable message on failure.
 */
function validateSchedule(raw: string): string {
  const trimmed = raw.trim();
  // Detect format by counting whitespace-separated tokens
  const tokens = trimmed.split(/\s+/);
  if (tokens.length === 1) {
    // Interval shorthand: must match parseDurationMs
    if (isNaN(parseDurationMs(trimmed))) {
      throw new Error(
        `Invalid interval '${trimmed}'. Expected formats: "6h", "30m", "1d", "2w".`
      );
    }
    return trimmed;
  }
  if (tokens.length === 5) {
    // 5-field cron expression: validate by computing a next fire time
    const probe = nextFireFromCron(trimmed, Date.now());
    if (isNaN(probe)) {
      throw new Error(
        `Invalid cron expression '${trimmed}'. Expected 5-field cron ("0 8 * * *", "*/30 * * * *", etc.).`
      );
    }
    return trimmed;
  }
  throw new Error(
    `Invalid schedule '${trimmed}'. Use an interval ("6h") or a 5-field cron expression ("0 8 * * *").`
  );
}

/**
 * Validate an IANA timezone string (e.g. "America/New_York"). Returns the
 * string unchanged on success, or throws an Error with a human-readable
 * message on failure. Delegates to Intl.DateTimeFormat, which throws
 * RangeError on any string it doesn't recognise as a real IANA zone.
 */
function validateTimezone(raw: string): string {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: raw });
  } catch {
    throw new Error(
      `Invalid timezone '${raw}'. Expected an IANA timezone name (e.g. "America/New_York", "UTC", "Asia/Tokyo").`
    );
  }
  return raw;
}

/**
 * Check whether an agent exists in the current framework root.
 * Returns false if the framework root is unknown (graceful degradation).
 */
function agentExistsInFramework(agentName: string, frameworkRoot: string): boolean {
  if (!frameworkRoot) return true; // can't check — allow
  const { existsSync: fsExists, readdirSync: fsReaddir } = require('fs');
  const { join: pjoin } = require('path');
  const orgsDir = pjoin(frameworkRoot, 'orgs');
  if (!fsExists(orgsDir)) return true; // no orgs dir — allow
  try {
    for (const org of fsReaddir(orgsDir)) {
      // resolveAgentDir handles both bare names and qualified "engineer/agent" names.
      if (fsExists(resolveAgentDir(frameworkRoot, org, agentName))) return true;
    }
  } catch { /* ignore */ }
  return false;
}

/**
 * Format an ISO timestamp for display (shortens to "YYYY-MM-DD HH:mm UTC").
 */
function fmtTs(iso: string | undefined): string {
  if (!iso) return '-';
  return iso.replace('T', ' ').slice(0, 16) + ' UTC';
}

/**
 * Send a reload-crons IPC signal to the daemon (non-blocking, best-effort).
 * Silently swallows errors — the daemon will pick up changes on its next tick.
 */
async function signalCronReload(agentName: string, instanceId: string): Promise<void> {
  try {
    const ipc = new IPCClient(instanceId);
    await ipc.send({ type: 'reload-crons', agent: agentName, source: 'cortextos bus cron-cmd' });
  } catch { /* non-fatal — scheduler picks up file change on next 30s tick */ }
}

busCommand
  .command('add-cron')
  .description('Add a new persistent cron for an agent')
  .argument('<agent>', 'Agent name')
  .argument('<name>', 'Cron name (unique per agent, slug format recommended)')
  .argument('<interval>', 'Schedule: interval ("6h", "30m", "1d") or 5-field cron expr ("0 8 * * *")')
  .argument('<prompt...>', 'Prompt text injected when the cron fires (all remaining words joined)')
  .option('--desc <description>', 'Human-readable description (optional)')
  .option('--timezone <tz>', 'IANA timezone for a cron-expression schedule (default: UTC). No effect on interval schedules.')
  .option('--goal <condition>', 'Verifiable completion condition registered via /goal, injected as its own standalone submission immediately before this cron fires (optional)')
  .action(async (agent: string, name: string, interval: string, promptWords: string[], opts: { desc?: string; timezone?: string; goal?: string }) => {
    // Validate agent name format
    try { validateAgentName(agent); } catch (err) { console.error(String(err)); process.exit(1); }

    const env = resolveEnv();

    // Validate agent exists in framework
    if (!agentExistsInFramework(agent, env.frameworkRoot)) {
      console.error(`Error: agent '${agent}' not found in framework. Check orgs/*/agents/ directory.`);
      process.exit(1);
    }

    // Validate schedule
    let schedule: string;
    try { schedule = validateSchedule(interval); } catch (err) { console.error(String(err)); process.exit(1); }

    // Validate timezone (optional)
    let timezone: string | undefined;
    if (opts.timezone !== undefined) {
      try { timezone = validateTimezone(opts.timezone); } catch (err) { console.error(String(err)); process.exit(1); }
    }

    const prompt = promptWords.join(' ');
    const cron: CronDefinition = {
      name,
      prompt,
      schedule,
      enabled: true,
      created_at: new Date().toISOString(),
      ...(opts.desc ? { description: opts.desc } : {}),
      ...(timezone ? { timezone } : {}),
      ...(opts.goal ? { goal: opts.goal } : {}),
    };

    try {
      addCron(agent, cron);
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }

    await signalCronReload(agent, env.instanceId);
    console.log(`Added cron '${name}' for ${agent}`);
  });

busCommand
  .command('remove-cron')
  .description('Remove a persistent cron from an agent')
  .argument('<agent>', 'Agent name')
  .argument('<name>', 'Cron name to remove')
  .action(async (agent: string, name: string) => {
    try { validateAgentName(agent); } catch (err) { console.error(String(err)); process.exit(1); }

    const removed = removeCron(agent, name);
    if (!removed) {
      console.error(`Error: cron '${name}' not found for agent '${agent}'.`);
      process.exit(1);
    }

    const env = resolveEnv();
    await signalCronReload(agent, env.instanceId);
    console.log(`Removed cron '${name}' from ${agent}`);
  });

busCommand
  .command('list-crons')
  .description('List all persistent crons configured for an agent')
  .argument('<agent>', 'Agent name')
  .option('--json', 'Emit raw JSON instead of a formatted table')
  .action((agent: string, opts: { json?: boolean }) => {
    try { validateAgentName(agent); } catch (err) { console.error(String(err)); process.exit(1); }

    const crons = readCrons(agent);

    // BUG 1 fix: merge cron-state.json's `last_fire` records into the displayed
    // last-fire timestamp. The daemon writes fire timestamps to two surfaces:
    //   - crons.json `last_fired_at` (via cron-scheduler.updateCron)
    //   - cron-state.json `last_fire` (via bus update-cron-fire from agent skills)
    // For a single source of truth in the CLI, take the most recent of the two.
    const env = resolveEnv();
    const paths = resolvePaths(agent, env.instanceId, env.org, env.ctxRoot);
    const stateRecords = readCronState(paths.stateDir).crons;
    const fireByName = new Map<string, string>();
    for (const rec of stateRecords) fireByName.set(rec.name, rec.last_fire);

    const mostRecent = (a?: string, b?: string): string | undefined => {
      if (!a) return b;
      if (!b) return a;
      return new Date(a).getTime() >= new Date(b).getTime() ? a : b;
    };

    if (opts.json) {
      const enriched = crons.map(c => ({
        ...c,
        last_fired_at: mostRecent(c.last_fired_at, fireByName.get(c.name)),
      }));
      console.log(JSON.stringify(enriched, null, 2));
      return;
    }

    if (crons.length === 0) {
      console.log(`No crons configured for ${agent}`);
      return;
    }

    // Compute next_fire_at for each cron so the table is informative. Uses
    // the same shared candidate-max reference computation (computeReferenceMs)
    // the live scheduler's loadCrons() uses — see its docblock — so a
    // never-fired cron anchors on created_at instead of showing a misleading
    // recomputed-every-query "now+interval" (task_1785589264937).
    const now = Date.now();
    const rows = crons.map(c => {
      const lastFire = mostRecent(c.last_fired_at, fireByName.get(c.name));
      let nextFire = '-';
      const refMs = computeReferenceMs({
        createdAt: c.created_at,
        lastFiredAt: c.last_fired_at,
        lastFireAttemptedAt: c.last_fire_attempted_at,
        stateFire: fireByName.get(c.name),
      }, now);
      const dms = parseDurationMs(c.schedule);
      if (!isNaN(dms)) {
        nextFire = fmtTs(new Date(refMs + dms).toISOString());
      } else {
        const nf = nextFireFromCron(c.schedule, refMs, c.timezone);
        if (!isNaN(nf)) nextFire = fmtTs(new Date(nf).toISOString());
      }
      const promptPreview = c.prompt.length > 60 ? c.prompt.slice(0, 57) + '...' : c.prompt;
      return {
        name: c.name,
        schedule: c.schedule,
        enabled: c.enabled ? 'yes' : 'no',
        last_fire: fmtTs(lastFire),
        next_fire: nextFire,
        prompt: promptPreview,
      };
    });

    // Column widths
    const nameW = Math.max(4, ...rows.map(r => r.name.length));
    const schedW = Math.max(8, ...rows.map(r => r.schedule.length));
    const enW = 7;
    const lastW = 18;
    const nextW = 18;

    const pad = (s: string, w: number) => s.padEnd(w);
    const sep = '-'.repeat(nameW + schedW + enW + lastW + nextW + 63 + 5);

    console.log(`\nCrons for ${agent} (${rows.length})\n`);
    console.log(`  ${pad('Name', nameW)}  ${pad('Schedule', schedW)}  ${pad('Enabled', enW)}  ${pad('Last Fire', lastW)}  ${pad('Next Fire', nextW)}  Prompt`);
    console.log(`  ${sep}`);
    for (const r of rows) {
      console.log(`  ${pad(r.name, nameW)}  ${pad(r.schedule, schedW)}  ${pad(r.enabled, enW)}  ${pad(r.last_fire, lastW)}  ${pad(r.next_fire, nextW)}  ${r.prompt}`);
    }
    console.log('');
  });

busCommand
  .command('update-cron')
  .description('Update fields of an existing persistent cron')
  .argument('<agent>', 'Agent name')
  .argument('<name>', 'Cron name to update')
  .option('--interval <i>', 'New schedule (interval or cron expression)')
  .option('--cron-expr <e>', 'Alias for --interval (5-field cron expression)')
  .option('--prompt <p>', 'New prompt text')
  .option('--enabled <bool>', 'Enable (true) or disable (false) the cron')
  .option('--desc <d>', 'New description')
  .option('--timezone <tz>', 'IANA timezone for a cron-expression schedule (default: UTC)')
  .option('--goal <condition>', 'Verifiable /goal completion condition, injected as its own standalone submission before this cron fires. Pass an empty string to clear it.')
  .action(async (agent: string, name: string, opts: { interval?: string; cronExpr?: string; prompt?: string; enabled?: string; desc?: string; timezone?: string; goal?: string }) => {
    try { validateAgentName(agent); } catch (err) { console.error(String(err)); process.exit(1); }

    const rawSchedule = opts.interval ?? opts.cronExpr;
    if (!rawSchedule && opts.prompt === undefined && opts.enabled === undefined && opts.desc === undefined && opts.timezone === undefined && opts.goal === undefined) {
      console.error('Error: at least one of --interval, --cron-expr, --prompt, --enabled, --desc, --timezone, or --goal is required.');
      process.exit(1);
    }

    const patch: Partial<CronDefinition> = {};

    if (rawSchedule !== undefined) {
      try { patch.schedule = validateSchedule(rawSchedule); } catch (err) { console.error(String(err)); process.exit(1); }
    }
    if (opts.prompt !== undefined) {
      patch.prompt = opts.prompt;
    }
    if (opts.enabled !== undefined) {
      if (opts.enabled !== 'true' && opts.enabled !== 'false') {
        console.error(`Error: --enabled must be 'true' or 'false', got '${opts.enabled}'.`);
        process.exit(1);
      }
      patch.enabled = opts.enabled === 'true';
    }
    if (opts.desc !== undefined) {
      patch.description = opts.desc;
    }
    if (opts.timezone !== undefined) {
      try { patch.timezone = validateTimezone(opts.timezone); } catch (err) { console.error(String(err)); process.exit(1); }
    }
    if (opts.goal !== undefined) {
      // Empty string clears an existing goal — updateCron's Partial<CronDefinition>
      // patch would otherwise have no way to remove a previously-set field.
      patch.goal = opts.goal === '' ? undefined : opts.goal;
    }

    let ok: boolean;
    try {
      ok = updateCronDef(agent, name, patch);
    } catch (err) {
      // updateCron rejects an empty prompt. Report it the way every other
      // validation failure in this command reports — one line, exit 1 — rather
      // than an unhandled stack trace.
      console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
    if (!ok) {
      console.error(`Error: cron '${name}' not found for agent '${agent}'.`);
      process.exit(1);
    }

    const env = resolveEnv();
    await signalCronReload(agent, env.instanceId);
    console.log(`Updated cron '${name}' for ${agent}`);
  });

busCommand
  .command('test-cron-fire')
  .description('Fire a cron immediately for testing (injects prompt into agent PTY via daemon IPC)')
  .argument('<agent>', 'Agent name')
  .argument('<name>', 'Cron name to fire')
  .action(async (agent: string, name: string) => {
    try { validateAgentName(agent); } catch (err) { console.error(String(err)); process.exit(1); }

    const cron = getCronByName(agent, name);
    if (!cron) {
      console.error(`Error: cron '${name}' not found for agent '${agent}'.`);
      process.exit(1);
    }

    const env = resolveEnv();
    const ipc = new IPCClient(env.instanceId);

    const daemonRunning = await ipc.isDaemonRunning();
    if (!daemonRunning) {
      console.error('Error: daemon is not running. Start it with: cortextos start');
      process.exit(1);
    }

    const resp = await ipc.send({
      type: 'fire-cron',
      agent,
      data: { name: cron.name, prompt: cron.prompt },
      source: 'cortextos bus test-cron-fire',
    });

    if (!resp.success) {
      console.error(`Error: ${resp.error}`);
      process.exit(1);
    }

    console.log(`Fired cron '${name}' for ${agent}`);
  });

busCommand
  .command('get-cron-log')
  .description('Display cron execution log entries for an agent')
  .argument('<agent>', 'Agent name')
  .argument('[name]', 'Cron name to filter by (optional — omit to show all crons)')
  .option('--limit <n>', 'Maximum number of entries to show (default: 50)', '50')
  .option('--json', 'Emit raw JSON array instead of a formatted table')
  .action((agent: string, name: string | undefined, opts: { limit?: string; json?: boolean }) => {
    try { validateAgentName(agent); } catch (err) { console.error(String(err)); process.exit(1); }

    const limit = parseInt(opts.limit ?? '50', 10);
    if (isNaN(limit) || limit < 0) {
      console.error(`Error: --limit must be a non-negative integer, got '${opts.limit}'.`);
      process.exit(1);
    }

    const entries = getExecutionLog(agent, name, limit);

    if (opts.json) {
      console.log(JSON.stringify(entries, null, 2));
      return;
    }

    if (entries.length === 0) {
      if (name !== undefined) {
        console.log(`No log entries for cron '${name}' on ${agent}`);
      } else {
        console.log(`No log entries for ${agent}`);
      }
      return;
    }

    // Human-readable table: ts | cron | status | attempt | duration | error
    const pad = (s: string, w: number) => s.padEnd(w);
    const header = `  ${pad('Timestamp', 20)}  ${pad('Cron', 22)}  ${pad('Status', 7)}  ${pad('Att', 3)}  ${pad('ms', 7)}  Error`;
    const sep = '-'.repeat(header.length);

    console.log(`\nExecution log for ${agent}${name ? ` / ${name}` : ''} (${entries.length} entries)\n`);
    console.log(header);
    console.log(`  ${sep}`);

    for (const e of entries) {
      const ts = e.ts.replace('T', ' ').slice(0, 19) + 'Z';
      const status = e.status;
      const att = String(e.attempt);
      const ms = String(e.duration_ms);
      const error = e.error ?? '';
      const cronPad = pad(e.cron.length > 22 ? e.cron.slice(0, 19) + '...' : e.cron, 22);
      console.log(
        `  ${pad(ts, 20)}  ${cronPad}  ${pad(status, 7)}  ${pad(att, 3)}  ${pad(ms, 7)}  ${error}`
      );
    }
    console.log('');
  });

// ---------------------------------------------------------------------------
// migrate-crons — Subtask 2.2: Manual one-shot migration command
// ---------------------------------------------------------------------------

busCommand
  .command('migrate-crons')
  .description('Migrate crons from config.json to crons.json for one or all agents')
  .argument('[agent]', 'Agent name to migrate (omit to migrate all enabled agents)')
  .option('--force', 'Re-run migration even if the marker file already exists')
  .action(async (agentArg: string | undefined, opts: { force?: boolean }) => {
    const { migrateCronsForAgent: migrateSingle, migrateAllAgents: migrateAll } = await import('../daemon/cron-migration.js');
    const env = resolveEnv();
    const ctxRoot = env.ctxRoot;
    const frameworkRoot = env.frameworkRoot || process.cwd();

    const log = (msg: string) => console.log(msg);
    const migOpts = { force: opts.force ?? false, log };

    if (agentArg) {
      // Single-agent migration
      try { parseQualifiedName(agentArg); } catch (err) { console.error(String(err)); process.exit(1); }

      // Resolve config.json path via filesystem scan.
      // resolveAgentDir handles both bare names and qualified "engineer/agent" names.
      const { existsSync: fsExists, readdirSync: fsReaddir } = require('fs') as typeof import('fs');
      const orgsDir = join(frameworkRoot, 'orgs');
      let configPath: string | undefined;
      if (fsExists(orgsDir)) {
        try {
          for (const org of fsReaddir(orgsDir, { withFileTypes: true }).filter((d: import('fs').Dirent) => d.isDirectory()).map((d: import('fs').Dirent) => d.name)) {
            const candidate = join(resolveAgentDir(frameworkRoot, org, agentArg), 'config.json');
            if (fsExists(candidate)) { configPath = candidate; break; }
          }
        } catch { /* ignore scan errors */ }
      }

      if (!configPath) {
        console.error(`Error: agent '${agentArg}' not found in framework. Check orgs/*/agents/ and orgs/*/engineers/*/agents/ directories.`);
        process.exit(1);
      }

      const result = migrateSingle(agentArg, configPath, ctxRoot, migOpts);

      switch (result.status) {
        case 'skipped-already-migrated':
          console.log(`Skipped ${agentArg}: already migrated (use --force to re-run)`);
          break;
        case 'no-config':
          console.log(`Skipped ${agentArg}: no config.json found`);
          break;
        case 'no-crons':
          console.log(`Skipped ${agentArg}: config.json has no crons — empty crons.json written`);
          break;
        case 'migrated':
          console.log(
            `Migrated ${agentArg}: ${result.cronsMigrated} cron(s) migrated` +
            (result.cronsSkipped?.length ? `, ${result.cronsSkipped.length} skipped (${result.cronsSkipped.join(', ')})` : '')
          );
          break;
      }
    } else {
      // All-agents migration
      const summary = migrateAll(frameworkRoot, ctxRoot, migOpts);

      const migrated = summary.results.filter(r => r.status === 'migrated').length;
      const skippedAlready = summary.results.filter(r => r.status === 'skipped-already-migrated').length;
      const noConfig = summary.results.filter(r => r.status === 'no-config').length;
      const noCrons = summary.results.filter(r => r.status === 'no-crons').length;

      console.log(`\nMigration summary:`);
      console.log(`  Agents processed    : ${summary.processed}`);
      console.log(`  Agents migrated     : ${migrated} (${summary.totalCronsMigrated} crons)`);
      console.log(`  Already migrated    : ${skippedAlready}`);
      console.log(`  No config.json      : ${noConfig}`);
      console.log(`  No crons in config  : ${noCrons}`);
    }
  });

// ---------------------------------------------------------------------------
// upgrade-cron-teaching — Subtask 2.4: scan agent workspace for stale
// CronCreate / /loop / config.json cron-registration teaching that predates
// the external-persistent-crons migration.  Scan-only by default; --apply
// performs only the safe literal substitutions known not to depend on
// surrounding context.
// ---------------------------------------------------------------------------

busCommand
  .command('upgrade-cron-teaching')
  .description('Scan agent workspace files for stale CronCreate/loop/config.json cron teaching')
  .argument('[agent]', 'Agent name to scan (omit to scan all agents under orgs/)')
  .option('--apply', 'Perform safe literal substitutions in place (does not rewrite CronCreate references)')
  .option('--json', 'Emit JSON instead of human-readable text')
  .action(async (
    agentArg: string | undefined,
    opts: { apply?: boolean; json?: boolean },
  ) => {
    const { scanAgentDir, groupMatchesByFile } =
      await import('../utils/cron-teaching-scanner.js');
    const env = resolveEnv();
    const frameworkRoot = env.frameworkRoot || process.cwd();

    const { existsSync: fsExists, readdirSync: fsReaddir } =
      require('fs') as typeof import('fs');

    // Resolve agent name (bare or qualified) to its absolute workspace dir.
    // Uses the imported resolveAgentDir which handles "engineer/agent" forms.
    function agentDirFor(agent: string): string | undefined {
      const orgsDir = join(frameworkRoot, 'orgs');
      if (!fsExists(orgsDir)) return undefined;
      try {
        for (const entry of fsReaddir(orgsDir, { withFileTypes: true })) {
          if (!entry.isDirectory()) continue;
          const candidate = resolveAgentDir(frameworkRoot, entry.name, agent);
          if (fsExists(candidate)) return candidate;
        }
      } catch {
        // ignore scan errors
      }
      return undefined;
    }

    // List every agent dir under orgs/ORG/agents/.
    function listAllAgents(): { agent: string; dir: string }[] {
      const orgsDir = join(frameworkRoot, 'orgs');
      const out: { agent: string; dir: string }[] = [];
      if (!fsExists(orgsDir)) return out;
      try {
        for (const orgEntry of fsReaddir(orgsDir, { withFileTypes: true })) {
          if (!orgEntry.isDirectory()) continue;
          const agentsRoot = join(orgsDir, orgEntry.name, 'agents');
          if (!fsExists(agentsRoot)) continue;
          for (const a of fsReaddir(agentsRoot, { withFileTypes: true })) {
            if (a.isDirectory() && !a.name.startsWith('.')) {
              out.push({ agent: a.name, dir: join(agentsRoot, a.name) });
            }
          }
        }
      } catch {
        // ignore scan errors
      }
      return out;
    }

    type Report = {
      agent: string;
      result: ReturnType<typeof scanAgentDir>;
    };

    const reports: Report[] = [];
    if (agentArg) {
      try { parseQualifiedName(agentArg); } catch (err) { console.error(String(err)); process.exit(1); }
      const dir = agentDirFor(agentArg);
      if (!dir) {
        console.error(`Error: agent '${agentArg}' not found under ${join(frameworkRoot, 'orgs')}/*/agents/ or orgs/*/engineers/*/agents/`);
        process.exit(1);
      }
      reports.push({ agent: agentArg, result: scanAgentDir(dir, { apply: opts.apply }) });
    } else {
      for (const { agent, dir } of listAllAgents()) {
        reports.push({ agent, result: scanAgentDir(dir, { apply: opts.apply }) });
      }
    }

    if (opts.json) {
      console.log(JSON.stringify(
        reports.map((r) => ({
          agent: r.agent,
          agentDir: r.result.agentDir,
          scannedFiles: r.result.scannedFiles,
          skippedSentinelFiles: r.result.skippedSentinelFiles,
          appliedSubstitutions: r.result.appliedSubstitutions,
          matches: r.result.matches,
        })),
        null,
        2,
      ));
      const totalMatches = reports.reduce((sum, r) => sum + r.result.matches.length, 0);
      process.exit(totalMatches === 0 ? 0 : 1);
    }

    let totalMatches = 0;
    let totalApplied = 0;
    for (const { agent, result } of reports) {
      totalMatches += result.matches.length;
      totalApplied += result.appliedSubstitutions;

      if (result.matches.length === 0 && result.appliedSubstitutions === 0) {
        console.log(`✓ ${agent}: no stale cron-teaching references (${result.scannedFiles.length} files scanned)`);
        continue;
      }

      console.log(`\n${agent}: ${result.matches.length} stale reference(s) in ${result.scannedFiles.length} files`);
      if (result.skippedSentinelFiles.length > 0) {
        console.log(`  (skipped ${result.skippedSentinelFiles.length} sentinel-marked file(s): ${result.skippedSentinelFiles.map((f) => f.replace(result.agentDir + '/', '')).join(', ')})`);
      }
      const grouped = groupMatchesByFile(result.matches);
      for (const [file, matches] of grouped) {
        const rel = file.replace(result.agentDir + '/', '');
        console.log(`\n  ${rel}`);
        for (const m of matches) {
          console.log(`    L${m.line} [${m.pattern}]: ${m.excerpt}`);
          console.log(`      → ${m.suggestion}`);
        }
      }
      if (result.appliedSubstitutions > 0) {
        console.log(`\n  Applied ${result.appliedSubstitutions} safe substitution(s) in place.`);
      }
    }

    console.log(`\nSummary: ${totalMatches} stale reference(s) across ${reports.length} agent(s)` +
      (opts.apply ? `, ${totalApplied} substitution(s) applied.` : '.'));
    if (totalMatches > 0 && !opts.apply) {
      console.log(`Run with --apply to substitute the safe-rewritable patterns. CronCreate / /loop references must be updated manually.`);
    }
    process.exit(totalMatches === 0 ? 0 : 1);
  });

busCommand
  .command('hook-context-status')
  .description('StatusLine hook: writes context window % to state/context_status.json')
  .action(() => runHook('hook-context-status'));

busCommand
  .command('hook-ask-telegram')
  .description('PreToolUse hook: forward AskUserQuestion to Telegram (cross-platform)')
  .action(() => runHook('hook-ask-telegram'));

busCommand
  .command('hook-permission-telegram')
  .description('PermissionRequest hook: send approve/deny request to Telegram (cross-platform)')
  .action(() => runHook('hook-permission-telegram'));

busCommand
  .command('hook-planmode-telegram')
  .description('ExitPlanMode hook: send plan for review to Telegram (cross-platform)')
  .action(() => runHook('hook-planmode-telegram'));

busCommand
  .command('hook-compact-telegram')
  .description('PreCompact hook: notify user via Telegram when context compaction starts (#18)')
  .action(() => runHook('hook-compact-telegram'));

busCommand
  .command('hook-idle-flag')
  .description('Stop hook: writes last_idle.flag timestamp so fast-checker knows agent finished its turn')
  .action(() => runHook('hook-idle-flag'));

busCommand
  .command('hook-loop-detector')
  .description('PreToolUse hook: detects and blocks repeated tool loops (same-args repetition + ping-pong alternation)')
  .action(() => runHook('hook-loop-detector'));

busCommand
  .command('hook-activity-beat')
  .description('PreToolUse hook: writes last_activity.flag on every tool call — mid-turn liveness proof for hang-detector class 3')
  .action(() => runHook('hook-activity-beat'));

busCommand
  .command('hook-subagent-priming')
  .description('PreToolUse hook (matcher: Agent): appends the benign-date-notice priming line to every subagent prompt via updatedInput')
  .action(() => runHook('hook-subagent-priming'));

// --- OAuth token rotation commands ---

busCommand
  .command('check-usage-api')
  .description('Fetch Claude OAuth utilization from Anthropic usage API (3-min TTL cache)')
  .option('--account <name>', 'Check specific account (default: active account)')
  .option('--force', 'Bypass cache and fetch fresh data')
  .option('--json', 'Output as JSON')
  .action(async (opts: { account?: string; force?: boolean; json?: boolean }) => {
    const env = resolveEnv();
    try {
      const result = await checkUsageApi(env.ctxRoot, { force: opts.force, account: opts.account });
      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        const cached = result.cached ? ' (cached)' : '';
        const warn5h = result.five_hour_utilization >= ALERT_5H ? ' ⚠️' : '';
        const warn7d = result.seven_day_utilization >= ALERT_7D ? ' ⚠️' : '';
        console.log(`Account: ${result.account}${cached}`);
        console.log(`5h utilization:  ${pct(result.five_hour_utilization)}${warn5h}`);
        console.log(`7d utilization:  ${pct(result.seven_day_utilization)}${warn7d}`);
        console.log(`Fetched at: ${result.fetched_at}`);
      }
    } catch (err) {
      console.error(`Error: ${err}`);
      process.exit(1);
    }
  });

busCommand
  .command('refresh-oauth-token')
  .description('Refresh OAuth token for an account using its refresh_token (one-time use — writes atomically)')
  .option('--account <name>', 'Account to refresh (default: active account)')
  .action(async (opts: { account?: string }) => {
    const env = resolveEnv();
    try {
      const result = await refreshOAuthToken(env.ctxRoot, opts.account);
      const expiresIn = Math.round((result.expires_at - Date.now()) / 1000 / 60);
      console.log(`Refreshed account: ${result.account}`);
      console.log(`New token expires in: ${expiresIn} minutes`);
    } catch (err) {
      console.error(`Error: ${err}`);
      process.exit(1);
    }
  });

busCommand
  .command('rotate-oauth')
  .description('Rotate to the next OAuth account if utilization thresholds are met')
  .option('--force', 'Force rotation regardless of utilization')
  .option('--agent <name>', 'Only update this agent\'s .env (default: all agents in org)')
  .option('--reason <text>', 'Reason for rotation (logged)')
  .option('--json', 'Output as JSON')
  .action(async (opts: { force?: boolean; agent?: string; reason?: string; json?: boolean }) => {
    const env = resolveEnv();
    if (!env.frameworkRoot) {
      console.error('CTX_FRAMEWORK_ROOT is required for rotate-oauth');
      process.exit(1);
    }
    try {
      const result = await rotateOAuth(env.ctxRoot, env.frameworkRoot, env.org, {
        force: opts.force,
        agent: opts.agent,
        reason: opts.reason,
      });
      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
      } else if (result.rotated) {
        console.log(`Rotated: ${result.from} → ${result.to}`);
        console.log(`Reason: ${result.reason}`);
      } else {
        console.log(`No rotation needed: ${result.reason}`);
      }
    } catch (err) {
      console.error(`Error: ${err}`);
      process.exit(1);
    }
  });

busCommand
  .command('set-oauth-account <name>')
  .description('Switch to a SPECIFIC OAuth account and propagate its token to agent .env files. Unlike rotate-oauth (which picks the first candidate that passes preflight), this goes exactly where you tell it — use it when an account is known-dead and you have chosen the replacement yourself.')
  .option('--agent <name>', 'Only update this agent\'s .env (default: all agents in org)')
  .option('--reason <text>', 'Reason for the switch (logged to rotation_log)')
  .option('--json', 'Output as JSON')
  .action(async (name: string, opts: { agent?: string; reason?: string; json?: boolean }) => {
    const env = resolveEnv();
    if (!env.frameworkRoot) {
      console.error('CTX_FRAMEWORK_ROOT is required for set-oauth-account');
      process.exit(1);
    }
    try {
      const store = loadAccounts(env.ctxRoot);
      if (!store) throw new Error('No accounts.json found');
      const from = store.active;

      // No preflight by design: the operator has named the target explicitly,
      // and the only signal available for setup-tokens is a one-word inference
      // ping that passes even on accounts with no usable capacity.
      setActiveAccount(env.ctxRoot, name, {
        reason: opts.reason || `manual switch to ${name}`,
        from,
      });

      // Re-read rather than reuse `store`: the daemon's rotation manager may
      // have refreshed this account's token between our load and the flip, and
      // propagating a stale token to every agent .env fails silently. Mirrors
      // rotateOAuth's `finalStore` read for the same reason.
      const token = loadAccounts(env.ctxRoot)!.accounts[name].access_token;
      writeTokenToAgents(env.frameworkRoot, env.org, token, opts.agent);

      const result = { switched: true, from, to: name, agent: opts.agent ?? 'all' };
      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(`Active OAuth account: ${from} → ${name}`);
        console.log(`Token written to: ${opts.agent ?? `all agents in org "${env.org}"`}`);
      }
    } catch (err) {
      console.error(`Error: ${err}`);
      process.exit(1);
    }
  });

busCommand
  .command('gh-app-token')
  .description('Mint a fresh ~1h GitHub App installation token (replaces the shared personal PAT for gh CLI calls). Requires GITHUB_APP_ID + GITHUB_APP_PRIVATE_KEY in env (e.g. via cortex-secret run --context conduit).')
  .option('--org <login>', 'Org the App is installed on', 'wyre-technology')
  .option('--json', 'Output token metadata (expires_at/org/installation_id) as JSON — the token itself is never included, since --json output is commonly captured into logs/CI')
  .option('--force', 'Print the token even when stdout is an interactive terminal')
  .action(async (opts: { org: string; json?: boolean; force?: boolean }) => {
    const appId = process.env.GITHUB_APP_ID;
    const privateKey = process.env.GITHUB_APP_PRIVATE_KEY;
    if (!appId || !privateKey) {
      console.error('GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY must be set (e.g. cortex-secret run --context conduit -- cortextos bus gh-app-token)');
      process.exit(1);
    }
    if (shouldRefuseInteractivePrint(Boolean(process.stdout.isTTY), Boolean(opts.force))) {
      console.error('Refusing to print the token to an interactive terminal (it would land in your visible session/scrollback).');
      console.error('Capture it instead: GH_TOKEN=$(cortextos bus gh-app-token) — or pass --force to print anyway.');
      process.exit(1);
    }
    try {
      const result = await mintInstallationToken(appId, privateKey, opts.org);
      if (opts.json) {
        console.log(JSON.stringify(redactForJson(result), null, 2));
      } else {
        // Token only on stdout so `GH_TOKEN=$(cortextos bus gh-app-token)` just works.
        console.log(result.token);
        console.error(`Expires: ${result.expires_at} (org: ${result.org}, installation: ${result.installation_id})`);
      }
    } catch (err) {
      console.error(`Error: ${err}`);
      process.exit(1);
    }
  });

busCommand
  .command('list-oauth-accounts')
  .description('List all OAuth accounts and their utilization')
  .action((opts: Record<string, unknown>) => {
    const env = resolveEnv();
    const store = loadAccounts(env.ctxRoot);
    if (!store) {
      console.log('No accounts.json found at state/oauth/accounts.json');
      return;
    }
    const rotState = loadRotationState(env.ctxRoot);
    for (const [name, acct] of Object.entries(store.accounts)) {
      const active = name === store.active ? ' (active)' : '';
      const disabled = acct.disabled ? ' (disabled)' : '';
      const expiry = new Date(acct.expires_at).toISOString();
      const warn5h = acct.five_hour_utilization >= ALERT_5H ? ' ⚠️' : '';
      const warn7d = acct.seven_day_utilization >= ALERT_7D ? ' ⚠️' : '';
      console.log(`${name}${active}${disabled}`);
      console.log(`  5h: ${pct(acct.five_hour_utilization)}${warn5h}  7d: ${pct(acct.seven_day_utilization)}${warn7d}  expires: ${expiry}`);
      // Surfaces the daemon's own rotation-manager state — previously only
      // readable by hand-catting state/oauth/rotation-state.json. An
      // observation, not just a verdict: WHEN it was seen and HOW, so it's
      // auditable rather than a bare "exhausted" boolean going stale silently.
      const exh = rotState.exhausted[name];
      if (exh) {
        console.log(`  EXHAUSTED: observed ${new Date(exh.observedAt).toISOString()} (via ${exh.source}), `
          + `retry-eligible ${new Date(exh.resetAt).toISOString()}`);
      }
    }
    const orphaned = Object.keys(rotState.exhausted).filter(n => !(n in store.accounts));
    if (orphaned.length) {
      // No leading indent, unlike the per-account lines above — this is a
      // fleet-level note, not an attribute of whichever account happened to
      // print last (murph's review, PR #138).
      console.log(`WARN: exhaustion marks for accounts no longer in accounts.json (should self-prune on next rotation attempt): ${orphaned.join(', ')}`);
    }
    const blockedAgents = Object.keys(rotState.limitBlocked);
    if (blockedAgents.length || rotState.alertedHalt) {
      console.log(`fleet: blocked=[${blockedAgents.join(', ')}] alertedHalt=${rotState.alertedHalt} `
        + `retryAt=${rotState.retryAt ? new Date(rotState.retryAt).toISOString() : 'none'}`);
    }
  });

busCommand
  .command('tui-stream')
  .description('Stream Claude Code TUI tool activity to the event log and optionally Telegram')
  .option('--session <name>', 'tmux session name (defaults to CTX_AGENT_NAME)')
  .option('--interval <ms>', 'Poll interval in milliseconds', '2000')
  .option('--telegram', 'Forward high-signal events to Telegram chat', false)
  .option('--dry-run', 'Print events to stdout instead of logging', false)
  .action(async (opts: { session?: string; interval: string; telegram: boolean; dryRun: boolean }) => {
    const env = resolveEnv();
    const paths = resolvePaths(env.agentName, env.instanceId, env.org, env.ctxRoot);
    const sessionName = opts.session || env.agentName;
    const pollMs = Math.max(500, parseInt(opts.interval, 10) || 2000);

    // High-signal patterns: tool calls that indicate real work
    const HIGH_SIGNAL = [
      /^[├│└].*Tool:\s*(Bash|Edit|Write|Read|Glob|Grep|WebFetch|WebSearch|Agent)/i,
      /^[├│└].*Running bash command/i,
      /^[├│└].*Editing file/i,
      /^[├│└].*Writing file/i,
      /^[├│└].*Reading file/i,
      /error|Error|ERROR/,
      /✓.*completed|✗.*failed/i,
      /Permission (request|denied|approved)/i,
    ];

    const TOOL_LINE = /^[├│└▶◆●]|^(Tool|Bash|Edit|Write|Read|Glob|Grep|Agent):/i;

    let prevOutput = '';
    let telegramApi: any = null;
    let chatId: string | undefined;

    // Set up Telegram if requested
    if (opts.telegram) {
      const { TelegramAPI } = await import('../telegram/api.js');
      const agentDir = process.env.CTX_AGENT_DIR || process.cwd();
      const envPath = join(agentDir, '.env');
      if (existsSync(envPath)) {
        const envContent = readFileSync(envPath, 'utf-8');
        const botTokenMatch = envContent.match(/^BOT_TOKEN=(.+)$/m);
        const chatIdMatch = envContent.match(/^CHAT_ID=(.+)$/m);
        if (botTokenMatch && chatIdMatch) {
          telegramApi = new TelegramAPI(botTokenMatch[1].trim());
          chatId = chatIdMatch[1].trim();
        }
      }
    }

    const logLine = (msg: string) => {
      if (opts.dryRun) {
        console.log(msg);
      }
    };

    let lastTelegramSent = 0;
    const TELEGRAM_COOLDOWN_MS = 10000; // max 1 Telegram message per 10s

    logLine(`[tui-stream] Watching tmux session: ${sessionName} (poll: ${pollMs}ms)`);

    // Poll loop
    while (true) {
      try {
        // Capture current tmux pane content
        let currentOutput = '';
        try {
          const result = execFileSync('tmux', ['capture-pane', '-t', sessionName, '-p'], {
            encoding: 'utf-8',
            stdio: ['ignore', 'pipe', 'ignore'],
          });
          currentOutput = result;
        } catch {
          // Session not found or tmux not available — wait and retry
          await sleepMs(pollMs * 5);
          continue;
        }

        // Diff: find new lines appended since last poll
        const prevLines = prevOutput.split('\n');
        const currLines = currentOutput.split('\n');
        const newLines = currLines.length > prevLines.length
          ? currLines.slice(prevLines.length - 1)
          : currLines.filter(l => !prevOutput.includes(l));

        prevOutput = currentOutput;

        if (newLines.length === 0) {
          await sleepMs(pollMs);
          continue;
        }

        // Filter to tool-call lines only
        const toolLines = newLines.filter(l => {
          const t = l.trim();
          return t.length > 0 && (TOOL_LINE.test(t) || t.startsWith('●') || t.startsWith('◆'));
        });

        for (const line of toolLines) {
          const trimmed = line.trim().slice(0, 200);
          const isHighSignal = HIGH_SIGNAL.some(re => re.test(trimmed));

          // Log to event bus
          if (!opts.dryRun) {
            try {
              logEvent(paths, env.agentName, env.org, 'agent_activity' as any, 'tool_call', 'info', {
                line: trimmed,
                session: sessionName,
                high_signal: isHighSignal,
              }, { refreshHeartbeat: true });
            } catch { /* Never fail the stream */ }
          } else {
            logLine(`[event] ${trimmed}`);
          }

          // Forward high-signal events to Telegram (rate-limited)
          if (isHighSignal && opts.telegram && telegramApi && chatId) {
            const now = Date.now();
            if (now - lastTelegramSent >= TELEGRAM_COOLDOWN_MS) {
              lastTelegramSent = now;
              try {
                await telegramApi.sendMessage(chatId, `[${env.agentName}] ${trimmed}`);
              } catch { /* Never fail the stream */ }
            }
          }
        }
      } catch {
        // Continue on any error
      }

      await sleepMs(pollMs);
    }
  });

// --- fix-agent-settings ---

busCommand
  .command('fix-agent-settings')
  .description('Patch all agent settings.json files: add missing allowlist tools and statusLine hook')
  .option('--dry-run', 'Show what would be changed without writing')
  .action((opts: { dryRun?: boolean }) => {
    const { existsSync: fsExists, readdirSync: fsReaddir, readFileSync: fsRead, writeFileSync: fsWrite } = require('fs');
    const env = resolveEnv();
    const frameworkRoot = env.frameworkRoot || process.cwd();
    const orgsDir = join(frameworkRoot, 'orgs');

    const REQUIRED_ALLOW = [
      'Bash', 'Read', 'Edit', 'Write',
      'Glob', 'Grep',
      'WebFetch', 'WebSearch',
      'ToolSearch', 'CronCreate', 'CronList', 'CronDelete',
      'Skill', 'Agent',
    ];
    const STATUS_LINE = {
      type: 'command',
      command: 'cortextos bus hook-context-status',
      refreshInterval: 5,
      timeout: 2,
    };

    if (!fsExists(orgsDir)) {
      console.error('orgs/ directory not found at', orgsDir);
      process.exit(1);
    }

    let patched = 0;
    let skipped = 0;

    for (const org of fsReaddir(orgsDir)) {
      const agentsDir = join(orgsDir, org, 'agents');
      if (!fsExists(agentsDir)) continue;
      for (const agent of fsReaddir(agentsDir)) {
        const settingsPath = join(agentsDir, agent, '.claude', 'settings.json');
        if (!fsExists(settingsPath)) continue;

        let settings: any;
        try { settings = JSON.parse(fsRead(settingsPath, 'utf-8')); }
        catch { console.warn(`  SKIP ${agent}: could not parse settings.json`); skipped++; continue; }

        const changes: string[] = [];

        // Check allow list
        const current: string[] = settings?.permissions?.allow ?? [];
        const missing = REQUIRED_ALLOW.filter(t => !current.includes(t));
        if (missing.length > 0) changes.push(`allow: +[${missing.join(', ')}]`);

        // Check statusLine
        if (!settings.statusLine) changes.push('statusLine: add hook-context-status');

        if (changes.length === 0) {
          console.log(`  OK   ${agent}: already up to date`);
          skipped++;
          continue;
        }

        if (opts.dryRun) {
          console.log(`  DRY  ${agent}: would apply [${changes.join('; ')}]`);
          patched++;
        } else {
          settings.permissions = settings.permissions ?? {};
          settings.permissions.allow = [...current, ...missing];
          settings.statusLine = STATUS_LINE;
          fsWrite(settingsPath, JSON.stringify(settings, null, 2) + '\n', 'utf-8');
          console.log(`  FIX  ${agent}: applied [${changes.join('; ')}]`);
          patched++;
        }
      }
    }

    const verb = opts.dryRun ? 'Would patch' : 'Patched';
    console.log(`\n${verb} ${patched} agent(s). ${skipped} already up to date or skipped.`);
    if (!opts.dryRun && patched > 0) {
      console.log('\nRestart affected agents to apply the new settings:');
      console.log('  cortextos restart <agent-name>');
    }
  });

function sleepMs(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function pct(v: number): string {
  return `${Math.round(v * 100)}%`;
}
