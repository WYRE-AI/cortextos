/**
 * reminder-scheduler.ts — Daemon-level live poller for persistent reminders.
 *
 * Closes the gap in task_1783983487266_03083173: getOverdueReminders()
 * (src/bus/reminders.ts) previously had exactly one caller, buildReminderBlock()
 * in agent-process.ts, which only runs from the two restart paths
 * (buildStartupPrompt / buildContinuePrompt). A reminder scheduled during a
 * continuously-running session — no restart spanning fire_at — was silently
 * skipped forever, unlike crons, which fire live via CronScheduler's 30s tick.
 *
 * ReminderScheduler is the reminder-side mirror of CronScheduler: one instance
 * per agent, ticking every 30s, injecting overdue reminders directly into the
 * agent's PTY via the same injectAgent() mechanism crons use.
 *
 * DELIVERY / DEDUP MODEL
 * -----------------------
 * A reminder can be *shown* to the agent more than once while it is still
 * `pending` (the agent hasn't run `ack-reminder` yet) — that's intentional,
 * it's what makes this an at-least-once, no-silent-drop mechanism rather than
 * a fire-and-forget one. What must NOT happen is the SAME live tick re-firing
 * the same reminder every 30 seconds forever while it waits for an ack. That
 * is what `injected_at` (src/bus/reminders.ts) exists to prevent: this
 * scheduler only ever considers reminders where `injected_at` is unset
 * (getUndeliveredOverdueReminders), and marks a reminder injected immediately
 * after a successful delivery. buildReminderBlock() marks reminders injected
 * too (same field), so a reminder shown once in a restart boot/continue
 * prompt is not redundantly re-delivered by this scheduler 30 seconds later —
 * both delivery paths share one dedup signal.
 *
 * A failed delivery (agent not running / PTY dead — injectAgent returns
 * false) does NOT mark injected_at, so the next tick retries automatically.
 * There is no retry backoff here unlike CronScheduler's fireWithRetry — the
 * natural retry cadence IS the 30s tick, and a reminder that's already
 * overdue has no "next slot" to advance to the way a cron does.
 */

import type { BusPaths } from '../types/index.js';
import { resolvePaths } from '../utils/paths.js';
import { getUndeliveredOverdueReminders, markReminderInjected, type Reminder } from '../bus/reminders.js';

export interface ReminderSchedulerOptions {
  agentName: string;
  /** Defaults to 'default' — matches resolvePaths' own default. */
  instanceId?: string;
  /** Same signature as AgentManager.injectAgent(agentName, text): boolean. */
  inject: (agentName: string, text: string) => boolean;
  logger?: (msg: string) => void;
  /** Test seam — production code should never need to override this. */
  resolvePathsFn?: (agentName: string, instanceId: string) => BusPaths;
}

export class ReminderScheduler {
  private readonly agentName: string;
  private readonly instanceId: string;
  private readonly inject: (agentName: string, text: string) => boolean;
  private readonly logger: (msg: string) => void;
  private readonly resolvePathsFn: (agentName: string, instanceId: string) => BusPaths;

  private tickHandle: ReturnType<typeof setInterval> | null = null;

  /** Same cadence as CronScheduler — one shared mental model for "live" delivery. */
  static readonly TICK_INTERVAL_MS = 30_000;

  constructor(opts: ReminderSchedulerOptions) {
    this.agentName = opts.agentName;
    this.instanceId = opts.instanceId ?? 'default';
    this.inject = opts.inject;
    this.logger = opts.logger ?? ((msg: string) => process.stdout.write(msg + '\n'));
    this.resolvePathsFn = opts.resolvePathsFn ?? resolvePaths;
  }

  start(): void {
    if (this.tickHandle !== null) {
      this.logger(`[reminder-scheduler] start() called while already running for "${this.agentName}" — ignored`);
      return;
    }
    this.tickHandle = setInterval(() => this.tick(), ReminderScheduler.TICK_INTERVAL_MS);
    this.logger(`[reminder-scheduler] started for agent "${this.agentName}"`);
  }

  stop(): void {
    if (this.tickHandle !== null) {
      clearInterval(this.tickHandle);
      this.tickHandle = null;
    }
  }

  private tick(): void {
    let paths: BusPaths;
    try {
      paths = this.resolvePathsFn(this.agentName, this.instanceId);
    } catch (err) {
      this.logger(
        `[reminder-scheduler] WARNING: failed to resolve paths for "${this.agentName}" — ` +
        `${err instanceof Error ? err.message : String(err)}`
      );
      return;
    }

    let due: Reminder[];
    try {
      due = getUndeliveredOverdueReminders(paths);
    } catch (err) {
      this.logger(
        `[reminder-scheduler] WARNING: failed to read pending-reminders.json for "${this.agentName}" — ` +
        `${err instanceof Error ? err.message : String(err)}`
      );
      return;
    }

    for (const reminder of due) {
      this.deliver(paths, reminder);
    }
  }

  private deliver(paths: BusPaths, reminder: Reminder): void {
    const text =
      `[REMINDER FIRED ${new Date().toISOString()}] (due ${reminder.fire_at}): ${reminder.prompt}\n` +
      `Run: cortextos bus ack-reminder ${reminder.id}`;

    let delivered: boolean;
    try {
      delivered = this.inject(this.agentName, text);
    } catch (err) {
      delivered = false;
      this.logger(
        `[reminder-scheduler] WARNING: inject threw for reminder "${reminder.id}" ("${this.agentName}") — ` +
        `${err instanceof Error ? err.message : String(err)}`
      );
    }

    if (!delivered) {
      this.logger(
        `[reminder-scheduler] reminder "${reminder.id}" for "${this.agentName}" not delivered this tick ` +
        `(agent not running?) — will retry next tick`
      );
      return;
    }

    try {
      markReminderInjected(paths, reminder.id);
    } catch (err) {
      // Delivered but couldn't persist the dedup marker — the next tick will
      // see it as still undelivered and re-inject. A duplicate live nudge is
      // the correct failure direction here (never a silent drop).
      this.logger(
        `[reminder-scheduler] WARNING: delivered reminder "${reminder.id}" but failed to mark it injected — ` +
        `${err instanceof Error ? err.message : String(err)}. It may be re-delivered next tick.`
      );
    }
  }
}
