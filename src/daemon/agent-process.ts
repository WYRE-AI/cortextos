import { appendFileSync, existsSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'fs';
import { join, sep } from 'path';
import { homedir } from 'os';
import type { AgentConfig, AgentStatus, CtxEnv } from '../types/index.js';
import { AgentPTY, isBinaryAvailable } from '../pty/agent-pty.js';
import { CodexAppServerPTY } from '../pty/codex-app-server-pty.js';
import { HermesPTY, hermesDbExists } from '../pty/hermes-pty.js';
import { OpencodePTY, opencodeSessionExists } from '../pty/opencode-pty.js';
import { MessageDedup, injectMessage as injectMessageIntoPty } from '../pty/inject.js';
import type { TelegramAPI } from '../telegram/api.js';
import { ensureDir } from '../utils/atomic.js';
import { writeCortextosEnv } from '../utils/env.js';
import { getOverdueReminders, markReminderInjected } from '../bus/reminders.js';
import { writeAgentPid } from '../utils/agent-pidfile.js';
import { resolvePaths } from '../utils/paths.js';
import { tryAcquireRestartLock, releaseRestartLock, isRestartInFlight } from './restart-lock.js';

type LogFn = (msg: string) => void;

// See the organic rate-limit exit block in handleExit() for why this is
// deliberately narrower than the 16KB image-poison capture it slices from.
const RATE_LIMIT_EXIT_TAIL_BYTES = 4096;

// Binary-unavailable retry tiers. See binaryUnavailableRetryDelayMs().
// Fast tier covers an in-flight install (the 2026-08-04 outage was ~12min);
// the slow tier is for a runtime that is broken rather than mid-update.
const BINARY_UNAVAILABLE_FAST_MS = 30_000;
const BINARY_UNAVAILABLE_FAST_WINDOW_MS = 15 * 60_000;
const BINARY_UNAVAILABLE_SLOW_MS = 5 * 60_000;

/**
 * Manages a single agent's lifecycle.
 * Replaces agent-wrapper.sh for one agent.
 */
export class AgentProcess {
  readonly name: string;
  private env: CtxEnv;
  private config: AgentConfig;
  private pty: AgentPTY | CodexAppServerPTY | null = null;
  private sessionTimer: ReturnType<typeof setTimeout> | null = null;
  private crashCount: number = 0;
  private maxCrashesPerDay: number = 10;
  // CrashLoopPauser (instar-inspired): sliding-window crash detection.
  // Timestamps of recent crashes within the configured window. If the
  // window fills, the agent auto-pauses instead of retrying with backoff.
  private crashTimestamps: number[] = [];
  private crashWindowMs: number = 0;
  private crashWindowMax: number = 0;
  // Binary-unavailable outage tracking (see binaryUnavailableRetryDelayMs).
  // Timestamps, not an attempt counter, so no reset has to stay in sync with
  // start() — a long enough gap is itself the signal that the outage ended.
  private binaryUnavailableSince: number = 0;
  private lastBinaryUnavailableAt: number = 0;
  private sessionStart: Date | null = null;
  private status: AgentStatus['status'] = 'stopped';
  private stopping: boolean = false;
  // BUG-040 fix: persists across stop() return until handleExit clears it.
  // Required because BUG-032's CRLF + 5s wait can cause graceful shutdown to
  // exceed the 5s Promise.race timeout in stop(), which would otherwise reset
  // `stopping=false` BEFORE the PTY actually exits, then handleExit would fire
  // with stopping=false and trigger spurious crash recovery (a partial regression
  // of BUG-011). stopRequested survives the timeout and is only cleared either
  // by handleExit when an intentional exit fires, or by start() at the beginning
  // of a new lifecycle.
  private stopRequested: boolean = false;
  // BUG-040 fix: monotonic generation counter incremented on each successful
  // start(). Each PTY's onExit closure captures the generation at spawn time
  // and bails out if the generation doesn't match — i.e. a NEW PTY has been
  // spawned since this old one was created. Without this guard, a late exit
  // from an old PTY can race past stopRequested and trigger crash recovery on
  // the new agent.
  private lifecycleGeneration: number = 0;
  // BUG-011 fix: stop() awaits this promise (resolved by the onExit handler in start())
  // to guarantee the PTY exit has fired before stopping=false is reset. Without
  // this, the exit handler can fire after stopping=false and trigger spurious
  // crash recovery for an agent we just stopped intentionally.
  private exitPromise: Promise<void> | null = null;
  private resolveExit: (() => void) | null = null;
  private dedup: MessageDedup;
  private log: LogFn;
  private onStatusChange: ((status: AgentStatus) => void) | null = null;
  // Issue #330: held here so CodexAppServerPTY can be re-wired across session refresh
  // (each start() recreates the PTY, but the Telegram handle persists).
  private telegramApi: TelegramAPI | null = null;
  private telegramChatId: string | null = null;
  // Limit-rotation wiring: secondary raw-output consumer re-applied on every
  // AgentPTY (re)spawn (session refresh recreates the PTY, like the Telegram
  // handle above).
  private outputChunkHandler: ((data: string) => void) | null = null;
  // Issue #392: tracks whether the most recently built startup prompt consumed
  // a handoff doc marker. start() reads this after spawn to decide whether the
  // daemon should fire runtime-owned lifecycle Telegram directly.
  private lastSpawnWasHandoff = false;
  // task_1785180731919: stdout.log's byte size at THIS lifecycle's start().
  // stdout.log is append-only across restarts, so without this, the organic
  // rate-limit exit check in handleExit() could match a banner left over from
  // a PREVIOUS lifecycle — a fast repeat crash-loop (dies again before
  // writing new output) would keep seeing the same stale banner and evade
  // max_crashes_per_day indefinitely. Bounds the check to bytes actually
  // written by the lifecycle that just exited.
  private stdoutLogSizeAtStart: number = 0;

  constructor(name: string, env: CtxEnv, config: AgentConfig, log?: LogFn) {
    this.name = name;
    this.env = env;
    this.config = config;
    if (config.max_crashes_per_day !== undefined) {
      this.maxCrashesPerDay = config.max_crashes_per_day;
    }
    if (config.crash_window?.seconds) {
      this.crashWindowMs = config.crash_window.seconds * 1000;
      this.crashWindowMax = config.crash_window.max_crashes ?? 3;
    }
    this.dedup = new MessageDedup();
    this.log = log || ((msg) => console.log(`[${name}] ${msg}`));
  }

  /**
   * Start the agent. Spawns Claude Code in a PTY.
   */
  async start(): Promise<void> {
    if (this.status === 'running') {
      this.log('Already running');
      return;
    }

    // Apply startup delay
    const delay = this.config.startup_delay || 0;
    if (delay > 0) {
      this.log(`Startup delay: ${delay}s`);
      await sleep(delay * 1000);
    }

    // Write .cortextos-env for backward compat (D6)
    if (this.env.agentDir) {
      writeCortextosEnv(this.env.agentDir, this.env);
    }

    // #19b: record restart-time as an expected-beat anchor. Every start() — fresh
    // OR --continue — is a restart the hang-detector's bootstrap sensor needs to
    // know about, so it can flag "restarted N ago, no session beat since" even
    // when no cron has fired yet (evaluateHang's fire-anchored sensor can't see
    // that gap; see hang-detector.ts evaluateBootstrapHang).
    this.writeRestartTime();

    // Determine start mode
    const mode = this.shouldContinue() ? 'continue' : 'fresh';
    const prompt = mode === 'fresh'
      ? this.buildStartupPrompt()
      : this.buildContinuePrompt();

    this.log(`Starting in ${mode} mode`);
    this.status = 'starting';

    // BUG-040 fix: clear any stale stop request from a previous lifecycle
    // (e.g. if the previous stop() timed out before the PTY actually exited).
    // We're starting fresh — the new PTY has no pending stop.
    this.stopRequested = false;
    // BUG-040 fix: bump generation. The onExit closure below captures THIS
    // value and uses it to detect "I'm an old PTY whose exit fired after a
    // new lifecycle began" — in which case it bails out without touching
    // handleExit, preventing spurious crash recovery on the new agent.
    const myGeneration = ++this.lifecycleGeneration;

    // Create PTY — runtime-specific subclass handles binary, args, bootstrap detection
    const logPath = join(this.env.ctxRoot, 'logs', this.name, 'stdout.log');
    ensureDir(join(this.env.ctxRoot, 'logs', this.name));
    this.log(`Log path: ${logPath}`);
    // task_1785180731919: record where THIS lifecycle's output begins, so
    // handleExit's organic rate-limit check can't match a banner left over
    // from a previous lifecycle. See the field doc above.
    try {
      this.stdoutLogSizeAtStart = existsSync(logPath) ? statSync(logPath).size : 0;
    } catch {
      this.stdoutLogSizeAtStart = 0;
    }
    this.pty = this.config.runtime === 'hermes'
      ? new HermesPTY(this.env, this.config, logPath)
      : this.config.runtime === 'opencode'
        ? new OpencodePTY(this.env, this.config, logPath)
        : this.config.runtime === 'codex-app-server'
          ? new CodexAppServerPTY(this.env, this.config, logPath)
          : new AgentPTY(this.env, this.config, logPath);

    // Limit-rotation: re-apply the output-chunk handler on every PTY creation
    // (this ternary is the SINGLE creation site — sessionRefresh delegates to
    // stop()+start()). Guarded: CodexAppServerPTY has no onOutputChunk;
    // HermesPTY inherits it from AgentPTY.
    if (this.pty instanceof AgentPTY && this.outputChunkHandler) {
      this.pty.onOutputChunk = this.outputChunkHandler;
    }

    // Issue #330: re-wire the Telegram handle on every start() (session refresh
    // creates a fresh CodexAppServerPTY). Only CodexAppServerPTY uses this — Claude / Hermes
    // typing indicators flow through fast-checker.
    if (this.config.runtime === 'codex-app-server' && this.telegramApi && this.telegramChatId) {
      (this.pty as CodexAppServerPTY).setTelegramHandle(this.telegramApi, this.telegramChatId);
    }

    // BUG-011 fix: create a fresh exit signal for this run. resolveExit is
    // called from the onExit handler below; stop() awaits exitPromise to
    // guarantee the exit handler has fired before clearing stopping.
    this.exitPromise = new Promise<void>((resolve) => {
      this.resolveExit = resolve;
    });

    // Handle exit
    this.pty.onExit((exitCode, signal) => {
      // BUG-040 fix: if the lifecycle has moved on (a new start() incremented
      // the generation since this PTY was spawned), this is an old PTY's late
      // exit. Ignore it entirely — we don't want it to trigger handleExit on
      // the current PTY's state.
      if (myGeneration !== this.lifecycleGeneration) {
        this.log(`Ignoring late exit from previous lifecycle gen ${myGeneration} (current: ${this.lifecycleGeneration})`);
        return;
      }
      this.log(`Exited with code ${exitCode} signal ${signal}`);
      this.handleExit(exitCode);
      // Signal anyone awaiting this PTY's exit (e.g. stop() — BUG-011 fix)
      this.resolveExit?.();
      this.resolveExit = null;
    });

    try {
      await this.pty.spawn(mode, prompt);
      // Codex exec-per-turn race: the new PTY's onExit can fire BEFORE this
      // line if `codex exec` completes its prompt quickly (CodexAppServerPTY's spawn
      // resolves once exec is launched, but the process may exit moments
      // later as it finishes the bootstrap turn). handleExit() nulls
      // this.pty and schedules crash recovery — we must not claim 'running'
      // or call getPid() on null in that window.
      if (!this.pty) {
        this.log('PTY exited during spawn — handleExit will recover');
        return;
      }
      this.status = 'running';
      this.sessionStart = new Date();
      this.log(`Running (pid: ${this.pty.getPid()})`);

      // Record the live PTY pid HERE, at the one point every agent start
      // passes through — not at the caller. AgentManager used to do it, but it
      // is only one of five callers of start(): the other four are restart
      // paths inside this class (session-refresh, image-poison, rate-limit,
      // generic crash recovery), which respawn the PTY with a NEW pid and
      // wrote nothing. So the record was correct exactly once, on the
      // daemon-managed first spawn, and went stale on every self-restart —
      // including the rate-limit restart, i.e. precisely during the incidents
      // where establishing liveness matters most.
      //
      // Best-effort by design: a pidfile is an optimization for reconcile and
      // must never be able to fail a spawn.
      try {
        const spawnedPid = this.pty.getPid();
        if (spawnedPid) {
          writeAgentPid(
            join(this.env.ctxRoot, 'state', this.name),
            this.name,
            spawnedPid,
            process.pid,
          );
        }
      } catch (err) {
        this.log(`pidfile write failed (non-fatal): ${err}`);
      }

      // Issue #392 / opencode parity — per-runtime msg1/msg2 rules live on
      // maybeSendRuntimeLifecycleNotification's doc block.
      this.maybeSendRuntimeLifecycleNotification();

      // Start session timer
      this.startSessionTimer();

      this.notifyStatusChange();
    } catch (err) {
      this.log(`Failed to start: ${err}`);
      this.status = 'crashed';
      this.notifyStatusChange();
    }
  }

  /**
   * Stop the agent gracefully.
   */
  async stop(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    // BUG-040 fix: stopRequested persists ACROSS stop()'s return until
    // handleExit clears it. This is the safety net for the case where the
    // PTY exits later than the Promise.race timeout below.
    this.stopRequested = true;
    this.log('Stopping...');
    this.clearSessionTimer();

    // Capture and null out pty BEFORE any awaits so handleExit() during graceful
    // shutdown doesn't race with us and trigger crash recovery or a double-kill.
    const pty = this.pty;
    this.pty = null;
    // Capture the exit promise before any awaits — we'll wait on this AFTER
    // pty.kill() to guarantee the exit handler has run before stopping=false.
    const exitPromise = this.exitPromise;

    if (pty) {
      try {
        if (this.config.runtime === 'hermes') {
          // Hermes REPL exit: Ctrl+D is the clean exit signal.
          // Hermes has a double-tap guard on Ctrl+C (accidental exit protection),
          // so we use Ctrl+D which exits cleanly on the first press.
          pty.write('\x04'); // Ctrl+D
          await sleep(3000);
        } else if (this.config.runtime === 'codex-app-server') {
          // Codex uses an exec-per-turn model — there is no persistent REPL
          // between turns, so /exit + sleep below are no-ops on CodexAppServerPTY
          // (write() just buffers). The only meaningful stop step is
          // pty.kill(), which terminates the in-flight `codex exec` (if any)
          // and flips _alive=false. Skipping the 6s Claude-REPL dance makes
          // `bus hard-restart` feel responsive instead of appearing to do
          // nothing for several seconds.
        } else if (this.config.runtime === 'opencode') {
          // OpenCode runs as a TUI. It does not use Claude Code's `/exit`
          // command contract, so stop with Ctrl-C and then let the shared
          // liveness check below kill the PTY if it is still running.
          pty.write('\x03'); // Ctrl-C
          await sleep(1000);
        } else {
          // BUG-032 fix: use CRLF (not lone CR) so Claude Code's REPL actually
          // recognizes the /exit line as a complete command, AND wait long
          // enough (5s, was 3s) for the child to flush + exit cleanly. Without
          // these the child often dies from SIGHUP (exit code 129) when the
          // PTY is torn down before /exit has been processed. PR #11's
          // BUG-011 fix already ensured the daemon doesn't misinterpret 129
          // as a real crash, but the underlying graceful-shutdown sequence
          // still wasn't graceful — this PR makes it so.
          pty.write('\x03'); // Ctrl-C
          await sleep(1000);
          pty.write('/exit\r\n');
          await sleep(5000);
        }
      } catch {
        // Ignore write errors during shutdown
      }
      // BUG-032 follow-up: only kill the PTY if the process is still alive.
      // After /exit + 5s wait, the child has usually exited cleanly. Calling
      // pty.kill() on an already-exited PTY tears down the file descriptor,
      // which can send SIGHUP (exit code 129) to a process that was in the
      // middle of flushing. Polling first eliminates the remaining SIGHUP risk.
      if (pty.isAlive()) {
        try {
          pty.kill();
        } catch {
          // PTY may have exited between the check and the kill — ignore
        }
      }

      // BUG-011 fix: AWAIT the exit handler before resolving stop().
      // BUG-040 fix: bumped timeout from 5s to 15s to give the PTY plenty of
      // time to exit cleanly even when BUG-032's slow graceful shutdown stacks
      // on top of pty.kill() lag. The functional correctness no longer depends
      // on this timeout (stopRequested handles late exits), but a generous
      // timeout reduces "Ignoring late exit from previous lifecycle" log noise.
      if (exitPromise) {
        await Promise.race([exitPromise, sleep(15000)]);
      }
    }

    this.stopping = false;
    // NOTE: this.stopRequested is intentionally NOT cleared here. It is
    // cleared by handleExit when the intentional exit fires (or by start()
    // when a new lifecycle begins). See BUG-040 fix in handleExit().
    this.status = 'stopped';
    this.notifyStatusChange();
    this.log('Stopped');
  }

  /**
   * Restart with --continue (session refresh).
   *
   * Delegates to stop() + start() so it inherits the BUG-011 race fix
   * automatically. This also eliminates a separate bug in the previous
   * inline implementation where the OLD pty's exit handler could fire
   * AFTER the NEW pty was set up, nulling out the wrong reference.
   * `start()` will pick up `continue` mode automatically because the
   * conversation directory still has .jsonl files (shouldContinue() is true).
   */
  async sessionRefresh(): Promise<void> {
    // Cross-path restart-in-flight lock (2026-07-13 storm fix, revised): this is the
    // SINGLE choke point for restart. Originally the lock was checked at each CALLER
    // (fast-checker.ts's forceHangRestart/forceContextRestart, agent-manager.ts's
    // restartAgent) — but a FOURTH caller was missed: the session-time-cap rollover
    // timer (scheduleCheck, below) calls sessionRefresh() directly too, completely
    // bypassing those gated call-sites. Confirmed via the actual incident markers
    // that THIS untracked caller is what raced boss+forge (same-second timestamps).
    // Gating HERE instead covers every current and future caller of sessionRefresh()
    // by construction — no call-site can forget to check it, because none of them
    // call stop()/start() directly; they all go through this one method.
    //
    // agent-manager.ts's restartAgent does NOT call sessionRefresh() (it does
    // stopAgent+startAgent directly) and keeps its own separate lock acquire/release
    // — this gate has no effect on that path, they only share the same LOCK FILE.
    const paths = resolvePaths(this.name, this.env.instanceId, this.env.org, this.env.ctxRoot);
    const lock = tryAcquireRestartLock(paths.stateDir, 'session-refresh');
    if (!lock.acquired) {
      this.log(`Session refresh SKIPPED for ${this.name} — ${lock.reason}`);
      return;
    }
    try {
      this.log('Session refresh (--continue restart)');
      // Write .session-refresh marker so the SessionEnd crash-alert hook
      // (src/hooks/hook-crash-alert.ts) classifies the imminent PTY exit as a
      // session refresh rather than a crash. The hook's marker handler +
      // quiet-suppression set + message switch were all wired for this type,
      // but no writer existed — every --continue rollover at the session-time
      // cap surfaced as a false-positive 'crash' on chief/analyst + the
      // crashes.log file.
      try {
        writeFileSync(
          join(paths.stateDir, '.session-refresh'),
          'session-time-cap rollover\n',
          'utf-8',
        );
      } catch (err) {
        this.log(`Failed to write .session-refresh marker: ${err}`);
      }
      await this.stop();
      await this.start();
      this.log('Session refreshed');
    } finally {
      // Release promptly once stop()+start() have both completed (unlike
      // fast-checker.ts's actuators, which used to release right after
      // TRIGGERING — now moot there since they no longer acquire directly, but
      // preserved here as the correct point: the new session is up by now).
      releaseRestartLock(paths.stateDir);
    }
  }

  /**
   * Inject a message into the agent's PTY — structured outcome.
   *
   * Distinguishes NOT_RUNNING (agent registered but no live PTY) from
   * DEDUPED (content collapsed against the in-process MessageDedup window)
   * from RESTARTING (a restart is in flight — see below).
   * See issue #346 — the first two used to surface as a bare `false` and
   * got mistaken for "agent not found" by operators investigating
   * restart/cron failures.
   *
   * RESTARTING check (silent-message-drop fix): `this.status === 'running'`
   * is true for the entire window between a restart being DECIDED
   * (sessionRefresh acquiring the restart-in-flight lock) and the PTY
   * actually tearing down inside stop() — status only flips off 'running'
   * partway through that teardown. A caller (fast-checker.ts's pollCycle)
   * that sees `ok: true` here ACKs the message as delivered — moving it
   * inbox -> inflight -> processed permanently — even though the bytes
   * just written may land in a PTY that's about to die with nothing left
   * to ever read them. That's genuine silent loss, not just a delay: the
   * message never stays in inflight/ long enough for the 5-minute
   * stale-inflight sweep to notice and redeliver it. Checking
   * isRestartInFlight() here closes that window: fast-checker sees a
   * failed injection (this new RESTARTING code, not NOT_RUNNING) and does
   * NOT ack, so the message stays safely in inflight/ and gets swept back
   * to the new session once the restart completes.
   */
  injectMessageDetailed(content: string): { ok: true } | { ok: false; code: 'NOT_RUNNING' | 'DEDUPED' | 'RESTARTING'; message: string } {
    if (!this.pty || this.status !== 'running') {
      return { ok: false, code: 'NOT_RUNNING', message: `agent "${this.name}" is registered but not running (status: ${this.status})` };
    }

    const paths = resolvePaths(this.name, this.env.instanceId, this.env.org, this.env.ctxRoot);
    if (isRestartInFlight(paths.stateDir)) {
      return { ok: false, code: 'RESTARTING', message: `agent "${this.name}" has a restart in flight — injection deferred to avoid a silent drop` };
    }

    if (this.dedup.isDuplicate(content)) {
      this.log('Dedup: skipping duplicate message');
      return { ok: false, code: 'DEDUPED', message: `inject for "${this.name}" deduped — content matches MessageDedup hash window` };
    }

    if ('injectMessage' in this.pty && typeof this.pty.injectMessage === 'function') {
      this.pty.injectMessage(content);
    } else {
      // CodexAppServerPTY intentionally models stdin writes itself and does not
      // inherit AgentPTY. Feed it through the same write path used historically.
      injectMessageIntoPty((data) => this.pty?.write(data), content);
    }
    return { ok: true };
  }

  /**
   * Inject a message into the agent's PTY (back-compat boolean wrapper).
   * New callers that need to distinguish DEDUPED from NOT_RUNNING should use
   * `injectMessageDetailed()` instead.
   */
  injectMessage(content: string): boolean {
    return this.injectMessageDetailed(content).ok;
  }

  /**
   * Check if the agent has bootstrapped (ready for messages).
   */
  isBootstrapped(): boolean {
    return this.pty?.getOutputBuffer().isBootstrapped() ?? false;
  }

  /**
   * Get current agent status.
   */
  getStatus(): AgentStatus {
    return {
      name: this.name,
      status: this.status,
      pid: this.pty?.getPid() || undefined,
      uptime: this.sessionStart
        ? Math.floor((Date.now() - this.sessionStart.getTime()) / 1000)
        : undefined,
      sessionStart: this.sessionStart?.toISOString(),
      crashCount: this.crashCount,
      model: this.config.model,
    };
  }

  /**
   * The live PTY process id, or undefined if not currently running.
   * Used by AgentManager to persist a pidfile and to probe registry-vs-reality
   * liveness during start/stop reconcile.
   */
  getPid(): number | undefined {
    return this.pty?.getPid() ?? undefined;
  }

  /**
   * Release this process's resources WITHOUT killing anything — used by the
   * start-path reconcile to drop a registry entry whose PTY is ALREADY CONFIRMED
   * DEAD. A normal stop() runs the graceful-shutdown dance and can reach
   * pty.kill() up to ~6s later (gated only by node-pty's `_alive` flag); if the
   * dead pid were recycled inside that window, that signal could hit an
   * unrelated process. dispose() NEVER signals a pid, so — combined with evict
   * only ever firing on a confirmed-dead pid — it is structurally impossible for
   * the evict path to kill a live/wrong process. We simply drop our reference to
   * the (dead) PTY; node-pty releases its fd on GC.
   */
  dispose(): void {
    this.clearSessionTimer();
    this.stopRequested = true;
    this.stopping = false;
    this.pty = null;
    this.status = 'stopped';
  }

  /**
   * Register a status change handler.
   */
  onStatusChanged(handler: (status: AgentStatus) => void): void {
    this.onStatusChange = handler;
  }

  /**
   * Wire the agent's Telegram bot handle. Used by CodexAppServerPTY (issue #330) to
   * fire sendChatAction directly from the JSONL stream. Safe to call before
   * or after start() — the handle is re-applied on every PTY (re)spawn.
   */
  setTelegramHandle(api: TelegramAPI, chatId: string): void {
    this.telegramApi = api;
    this.telegramChatId = chatId;
    if (this.config.runtime === 'codex-app-server' && this.pty) {
      (this.pty as CodexAppServerPTY).setTelegramHandle(api, chatId);
    }
  }

  /** Secondary PTY output consumer (survives session refresh re-spawns). */
  setOutputChunkHandler(cb: (data: string) => void): void {
    this.outputChunkHandler = cb;
    if (this.pty instanceof AgentPTY) this.pty.onOutputChunk = cb;
  }

  /**
   * Write raw data to the agent's PTY.
   * Used for TUI navigation (key sequences).
   */
  write(data: string): void {
    if (this.pty) {
      this.pty.write(data);
    }
  }

  /**
   * Get the output buffer for reading agent output.
   */
  getOutputBuffer() {
    return this.pty?.getOutputBuffer();
  }

  /**
   * Get the agent directory (where config.json and .env live).
   */
  getAgentDir(): string {
    return this.env.agentDir;
  }

  /**
   * Get the current agent config (live reference — fields may be updated in-place).
   */
  getConfig(): AgentConfig {
    return this.config;
  }

  /**
   * Get the org this agent belongs to (e.g. for oauth.ts's rotateOAuth, which
   * writes rotated tokens to every agent's .env under orgs/<org>/agents/*).
   */
  getOrg(): string {
    return this.env.org;
  }

  // --- Private methods ---

  /**
   * Read the tail of this agent's stdout.log without loading the whole file.
   * Used by handleExit() to inspect recent output for known-crash signatures
   * (e.g. the image-poison API 400 pattern) so it can decide whether the
   * exit is a real crash or a recoverable upstream artifact.
   *
   * `sinceByte` (default 0) is an optional lower bound on the read: the tail
   * never starts before this byte offset, even if that means reading fewer
   * than `maxBytes`. Used by the organic rate-limit exit check to bound the
   * read to bytes THIS lifecycle wrote (stdoutLogSizeAtStart) — byte-precise
   * on purpose (reads the exact range via Buffer, same as the rest of this
   * method) rather than reading the full tail and then slicing the decoded
   * string: JS string indices are UTF-16 code units, not bytes, so slicing a
   * decoded string by a byte-count length can read further back than
   * intended once the log contains multibyte UTF-8 output, silently
   * defeating the lifecycle bound. If the file has since been rotated
   * (OutputBuffer.push()'s 50MB rotation renames it and starts a fresh,
   * smaller one) so `sinceByte` now exceeds the current file size, that
   * bound is treated as stale and reset to 0 rather than excluding the
   * entire new file.
   *
   * Returns an empty string if the log doesn't exist, can't be read, or the
   * bounded range is empty.
   */
  private tailStdoutLog(maxBytes: number, sinceByte: number = 0): string {
    const logPath = join(this.env.ctxRoot, 'logs', this.name, 'stdout.log');
    try {
      if (!existsSync(logPath)) return '';
      const stats = statSync(logPath);
      // OutputBuffer.push() rotates stdout.log (renames to .1, starts a
      // fresh smaller file) once it crosses MAX_LOG_BYTES. If that happened
      // since sinceByte was recorded, the current file is now SMALLER than
      // that offset — treating it as a valid lower bound would wrongly
      // exclude everything in the new file. Detect the rotation (current
      // size < recorded offset) and fall back to reading from byte 0 of the
      // new file instead.
      const effectiveSinceByte = sinceByte > stats.size ? 0 : sinceByte;
      const start = Math.max(effectiveSinceByte, stats.size - maxBytes, 0);
      const len = stats.size - start;
      if (len <= 0) return '';
      // Synchronous read of the tail; small and bounded so the cost is fine
      // even in the exit handler.
      const fd = require('fs').openSync(logPath, 'r');
      try {
        const buf = Buffer.alloc(len);
        const read = require('fs').readSync(fd, buf, 0, len, start);
        return buf.toString('utf-8', 0, read);
      } finally {
        require('fs').closeSync(fd);
      }
    } catch {
      return '';
    }
  }

  /**
   * Match the API 400 image-poison signature in recent stdout.
   *
   * Two variants observed in Anthropic's Messages API responses:
   *   `API Error: 400 messages.N.content.M.image.source.base64.data: Image format image/<fmt> not supported`
   *   `API Error: 400 ... image.source.base64.data: ...`
   *
   * Matching the prefix `image.source.base64` is robust to wording changes
   * in Anthropic's error string; matching `image format image/<fmt>` is the
   * confirmed exact wording today and gives a second signal. Either is enough.
   */
  private detectImagePoisonCrash(recentOutput: string): boolean {
    if (!recentOutput) return false;
    if (recentOutput.includes('API Error: 400') && recentOutput.includes('image.source.base64')) {
      return true;
    }
    if (/image format image\/[a-z]+ not supported/i.test(recentOutput)) {
      return true;
    }
    return false;
  }

  /**
   * Does recent output show an ACTUAL Anthropic/Claude Code rate-limit
   * condition, as opposed to prose that merely mentions rate limits,
   * quotas, or usage limits? Deliberately narrower than the shared
   * hasRateLimitSignature() in rate-limit-detector.ts (used by
   * fast-checker.ts's hang-check and hook-crash-alert.ts's SessionEnd
   * classification) — those live-alert paths can afford the shared
   * predicate's broader recall because a false positive there only costs a
   * missed page. This method gates whether handleExit's organic rate-limit
   * exit exemption bypasses the crash counter, so ordinary prose
   * mentioning "rate limit" or "usage limit" (which this codebase's own
   * source and docs legitimately contain) must NOT match. It requires one
   * of:
   *   - the literal Anthropic API error.type tokens (overloaded_error,
   *     rate_limit_error) or an explicit "API Error"+429 banner
   *   - Claude Code's own confirmed CLI usage-limit banner text — "You've
   *     hit your weekly/5-hour limit" or "You've used N% of your ... limit"
   *     — verified against tests/unit/pty/rate-limit-detector.test.ts and
   *     tests/unit/daemon/fast-checker.test.ts, not guessed. This is
   *     second-person, direct-address CLI status phrasing that ordinary
   *     third-person prose about rate limits does not use, so it stays
   *     narrow without missing the primary real-world organic-exit case
   *     (Claude Code exiting after printing this exact banner).
   */
  private hasRateLimitExitBanner(text: string): boolean {
    if (!text) return false;
    const normalized = text.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').toLowerCase();
    // Require the "API Error" context marker alongside the JSON error.type
    // tokens, not a bare substring match — the same convention
    // detectImagePoisonCrash() already relies on ("API Error: 400" +
    // "image.source.base64"). Without it, this codebase's OWN source and
    // test files (rate-limit-detector.ts, this very method, hook-crash-alert
    // tests) legitimately contain the literal strings "overloaded_error" and
    // "rate_limit_error" — an agent that crashes for an unrelated reason
    // shortly after printing any of that (e.g. a grep/cat/diff of those
    // files) would otherwise get misclassified as exempt.
    const hasApiErrorContext = normalized.includes('api error');
    if (hasApiErrorContext && (
      normalized.includes('overloaded_error') ||
      normalized.includes('rate_limit_error') ||
      /\b429\b/.test(normalized)
    )) {
      return true;
    }
    if (/you['’]ve hit your (weekly|usage|5-hour|5h)\s*limit/.test(normalized)) {
      return true;
    }
    if (/you['’]ve used \d+% of your (weekly|usage|5-hour|5h)?\s*limit/.test(normalized)) {
      return true;
    }
    return false;
  }

  /**
   * Write the `.force-fresh` marker that AgentProcess.shouldContinue() reads
   * on the next start() to force a fresh Claude Code session (no --continue).
   * Used by the image-poison auto-recovery in handleExit().
   */
  private armForceFresh(reason: string): void {
    try {
      const stateDir = join(this.env.ctxRoot, 'state', this.name);
      ensureDir(stateDir);
      const markerPath = join(stateDir, '.force-fresh');
      writeFileSync(markerPath, `${new Date().toISOString()} ${reason}\n`, 'utf-8');
    } catch (err) {
      this.log(`Failed to arm .force-fresh marker: ${err}`);
    }
  }

  /**
   * #19b: write the `.restart-time` marker FastChecker's bootstrap-hang sensor
   * (evaluateBootstrapHang) reads as its restart anchor. Written unconditionally
   * on every start() — the marker means "a restart happened here", not "this was
   * a fresh session" — so both continue and fresh modes write it.
   */
  private writeRestartTime(): void {
    try {
      const stateDir = join(this.env.ctxRoot, 'state', this.name);
      ensureDir(stateDir);
      writeFileSync(join(stateDir, '.restart-time'), `${new Date().toISOString()}\n`, 'utf-8');
    } catch (err) {
      this.log(`Failed to write .restart-time marker: ${err}`);
    }
  }

  /**
   * The binary this agent's PTY execs, mirroring the runtime switch in start().
   * Kept in sync with that ternary — the two are the only places runtime maps
   * to a concrete executable.
   */
  private agentBinaryName(): string {
    if (this.config.runtime === 'hermes') return 'hermes';
    if (this.config.runtime === 'codex-app-server') return 'codex';
    return 'claude';
  }

  /**
   * How long to wait before re-spawning an agent whose binary is missing.
   *
   * Called only from handleExit()'s binary-unavailable branch. The retry does
   * NOT count against max_crashes_per_day, so this loop is the agent's only
   * route back to life — the delay is an availability trade-off, not a tuning
   * constant. Too short and the daemon spins against a torn-down install; too
   * long and the fleet stays dark after the installer already finished,
   * missing cron fires and inbox messages the whole time.
   *
   * Two tiers, keyed on how long the binary has been gone:
   *
   *   - First BINARY_UNAVAILABLE_FAST_WINDOW_MS of an outage: poll every 30s.
   *     A real install window is minutes (the 2026-08-04 outage was ~12), so
   *     this is the case that actually happens, and 30s keeps the agent's
   *     downtime within a minute of the binary reappearing. A failed exec
   *     costs ~1ms, so the polling itself is free.
   *   - After that: back off to 5min. An outage this long is no longer an
   *     in-flight install — it's a broken or removed runtime needing a human.
   *     Slowing down bounds restarts.log growth (30s forever would append
   *     ~2,880 lines/agent/day) without ever giving up, since nothing else
   *     would bring the agent back if we did.
   *
   * Outage age is derived from timestamps rather than an attempt counter so
   * there is no reset to keep in sync with start(): a gap longer than the slow
   * tier means the previous outage ended and recovery already happened, so the
   * next failure starts a fresh outage at the fast tier.
   */
  private binaryUnavailableRetryDelayMs(): number {
    const now = Date.now();
    const gapSinceLast = now - this.lastBinaryUnavailableAt;
    if (gapSinceLast > BINARY_UNAVAILABLE_SLOW_MS * 2) {
      this.binaryUnavailableSince = now;
    }
    this.lastBinaryUnavailableAt = now;

    const outageAge = now - this.binaryUnavailableSince;
    return outageAge < BINARY_UNAVAILABLE_FAST_WINDOW_MS
      ? BINARY_UNAVAILABLE_FAST_MS
      : BINARY_UNAVAILABLE_SLOW_MS;
  }

  private handleExit(exitCode: number): void {
    // Capture last 16KB of the agent's stdout BEFORE nulling pty.
    // Used by the image-poison auto-recovery check below — reads the log
    // file so this works even if the PTY buffer has already been GC'd.
    const recentOutput = this.tailStdoutLog(16384);

    this.pty = null;
    this.clearSessionTimer();

    // When the cortextos daemon is shut down by PM2, SIGTERM propagates to
    // the whole process group and reaches each PTY's Claude Code child
    // BEFORE the daemon's stopAll() loop has a chance to call stopAgent() on
    // it. Those children exit cleanly (code 0) but arrive at handleExit with
    // stopRequested=false, which used to classify the exit as a crash and
    // inflate .crash_count_today by one per agent, per PM2 restart.
    //
    // agent-manager.ts:stopAll() already writes a `.daemon-stop` marker in
    // every agent's state dir at the START of its shutdown loop for an
    // unrelated reason (SessionEnd crash-alert hook). We reuse that marker
    // here as the authoritative "the daemon is going down" signal. If the
    // marker exists AND is recent (written within the last 60s), any PTY
    // exit is a shutdown casualty, not a real crash — swallow it.
    //
    // The 60s window guards against a stale marker from a previous shutdown
    // that wasn't cleaned up: we do NOT want an old marker to silently mask
    // a genuine crash days later. handleExit does NOT delete the marker —
    // cleanup stays with agent-manager / hook-crash-alert per the existing
    // separation of concerns.
    if (this.isDaemonShuttingDown()) {
      return;
    }

    // BUG-040 fix: check stopRequested instead of (only) stopping. The
    // stopping flag is cleared inside stop() after a 15s timeout window —
    // which means a slow PTY shutdown can fire handleExit AFTER stopping is
    // already false, leading to spurious crash recovery. stopRequested is
    // set by stop() at the START of the shutdown sequence and persists across
    // stop()'s return until handleExit clears it (right here). This guarantees
    // that the FIRST exit after a stop() call is treated as intentional, no
    // matter how delayed it is.
    //
    // Also keep the legacy `stopping` check for in-progress detection during
    // the (most common) case where the exit fires while stop() is still
    // awaiting. Either flag short-circuits crash recovery.
    if (this.stopRequested || this.stopping) {
      this.stopRequested = false;
      return;
    }

    // Image-poison auto-recovery (companion to PR #446's photo-injection fix).
    // Checked FIRST so a poisoned-context crash neither trips the crash-loop
    // window nor charges the daily counter — it is an upstream artifact, not
    // an agent malfunction.
    //
    // Claude Code crashes with `API Error: 400 messages.N.content.M.image.source.base64.data:
    // Image format image/<fmt> not supported` when conversation history holds a
    // base64-encoded image whose claimed media_type does not match the actual
    // bytes. The poison is permanent: every `--continue` restart reloads the
    // same conversation history and re-hits the same 400, so the agent
    // crash-loops until it exhausts max_crashes_per_day and the daemon halts.
    //
    // This block covers agents that ALREADY have a poisoned context: detect
    // the 400 signature in the recent stdout, write `.force-fresh` so the next
    // start discards the saved conversation, and respawn WITHOUT charging the
    // crash counter. (The photo-suppression source fix from #446 was superseded
    // by the Track-2 byte-sniff mime reconciliation; this recovery block is the
    // independent resilience half and stands on its own.)
    //
    // Exit is always code 0 in this failure mode (Claude Code surfaces the
    // 400 to the user then exits cleanly), so we gate on both exit code and
    // the error signature to avoid false positives that would skip a real
    // crash counter increment.
    if (exitCode === 0 && this.detectImagePoisonCrash(recentOutput)) {
      this.log('Image-poison crash detected (API 400, unsupported image format). Arming .force-fresh and restarting without counting against max_crashes_per_day.');
      this.armForceFresh('image-poison auto-recovery');
      this.appendCrashToRestartsLog(exitCode, 5000, 'IMAGE_POISON_RECOVERY');
      this.status = 'crashed';
      this.notifyStatusChange();
      setTimeout(() => {
        if (this.status === 'crashed') {
          this.start().catch(err => this.log(`Image-poison restart failed: ${err}`));
        }
      }, 5000);
      return;
    }

    // Organic rate-limit exit exemption (task_1785180731919, S1 follow-up).
    // The daemon's OWN proactive rate-limit rotation (fast-checker.ts's
    // hang-restart path) already goes through sessionRefresh()'s stop()
    // BEFORE start(), which sets stopRequested — so a daemon-INITIATED
    // rate-limit restart is already exempted above, before this point ever
    // runs. The residual gap this covers: Claude Code itself dying on a
    // 429/rate-limit signature ORGANICALLY, racing ahead of the hang
    // detector's poll cycle. That is an upstream API-availability condition
    // outside the agent's control — structurally the same shape as the
    // image-poison case above — and should not burn a crash-counter slot.
    //
    // Unlike image-poison, this is NOT gated on exitCode === 0: Claude
    // Code's exit code on a 429 isn't a confirmed fixed value the way the
    // image-poison 400's clean exit(0) is, and the two other call sites for
    // this exact signature — fast-checker.ts's live restart-decision path
    // and hook-crash-alert.ts's SessionEnd classification — both already key
    // purely off hasRateLimitSignature(), not exit code. Matching that here
    // keeps all three call sites on one predicate.
    //
    // Also does NOT arm .force-fresh: a rate limit is a transient API-supply
    // condition, not a poisoned conversation — the next restart resumes
    // normally via --continue, same as any other recoverable restart.
    //
    // This call site is higher-stakes than the other two
    // hasRateLimitSignature() consumers (fast-checker.ts's hang-check,
    // hook-crash-alert.ts's SessionEnd classification): those only affect
    // whether an alert pages, so a false positive there just means a human
    // doesn't get woken up for something real — recoverable. Here a false
    // positive lets a genuinely crash-looping agent evade
    // max_crashes_per_day entirely, so this uses two independent, deliberately
    // NARROWER checks instead of reusing the shared predicate outright:
    //
    // 1. Read via tailStdoutLog(RATE_LIMIT_EXIT_TAIL_BYTES, stdoutLogSizeAtStart)
    //    — a fresh, byte-precise read bounded on BOTH sides, not a slice of
    //    the already-decoded `recentOutput` string. stdout.log is
    //    append-only across restarts — without the lifecycle bound, a fast
    //    repeat crash-loop (dies again before writing much new output) would
    //    keep matching the SAME stale banner from a previous lifecycle and
    //    evade the counter indefinitely. Without the byte cap, a banner from
    //    minutes-ago-but-still-this-lifecycle (Claude Code hit a limit,
    //    retried, recovered, then crashed later for an unrelated reason)
    //    would wrongly exempt that later, unrelated crash — image-poison
    //    doesn't have this problem because its signature IS what kills the
    //    process, always the last thing printed; a rate-limit banner has no
    //    such guarantee. A prior version of this fix computed the byte
    //    window separately and did `recentOutput.slice(-window)` — broken,
    //    because JS string indices are UTF-16 code units, not bytes, so a
    //    byte-count slice on a decoded string can read further back than
    //    intended once multibyte UTF-8 output is involved, silently
    //    defeating the lifecycle bound. tailStdoutLog's own byte-range read
    //    doesn't have this problem.
    // 2. hasRateLimitExitBanner() (below), not the shared hasRateLimitSignature().
    //    The shared predicate is tuned for live-alert paths and matches
    //    plain English phrases ("rate limit", "usage limit", "quota
    //    exceeded") that ordinary task output can legitimately contain —
    //    including THIS codebase's own source and docs (rate-limit-detector.ts's
    //    own signature list, this very comment). An agent whose recent work
    //    happens to discuss rate limits could otherwise get any unrelated
    //    crash silently exempted. This call site requires an actual
    //    API-error-shaped token, or Claude Code's own confirmed usage-limit
    //    banner text, instead.
    const rateLimitTail = this.tailStdoutLog(RATE_LIMIT_EXIT_TAIL_BYTES, this.stdoutLogSizeAtStart);
    if (this.hasRateLimitExitBanner(rateLimitTail)) {
      this.log('Organic rate-limit exit detected (429/rate-limit signature in recent output). Restarting without counting against max_crashes_per_day.');
      this.appendCrashToRestartsLog(exitCode, 5000, 'RATE_LIMIT_RECOVERY');
      this.status = 'crashed';
      this.notifyStatusChange();
      setTimeout(() => {
        if (this.status === 'crashed') {
          this.start().catch(err => this.log(`Rate-limit restart failed: ${err}`));
        }
      }, 5000);
      return;
    }

    // Binary-unavailable exemption (2026-08-04 fleet incident). Third member
    // of the "upstream condition, not agent malfunction" family, alongside the
    // image-poison and rate-limit blocks above.
    //
    // Every agent runs its own Claude Code auto-updater (private
    // CLAUDE_CONFIG_DIR) against ONE shared binary. When two updaters raced,
    // the install was left torn down — ~/.local/bin/claude dangling at a
    // deleted version for ~12 minutes. node-pty happily returns a pid for a
    // dangling symlink, then the child exits 1 having written nothing at all.
    // Indistinguishable from a crash at the daemon's altitude, so the daemon
    // charged the daily budget with exponential backoff and halted agents at
    // the cap. AgentPTY's DISABLE_AUTOUPDATER pin is the prevention half; this
    // is the resilience half, and it stands on its own for any other cause of
    // a vanished runtime (botched upgrade, unmounted volume, bad PATH).
    //
    // Deliberately narrow — three independent conditions must all hold, so a
    // genuine crash that merely coincides with an update window still counts:
    //   1. exitCode === 1        — exec failure, not a clean exit
    //   2. zero bytes written    — a real agent crash emits SOMETHING first.
    //                              Bounded at stdoutLogSizeAtStart because
    //                              stdout.log is append-only across restarts.
    //   3. binary missing NOW    — the decisive check; without it (1)+(2) would
    //                              exempt any fast silent failure.
    const wroteNothingThisLifecycle =
      this.tailStdoutLog(1, this.stdoutLogSizeAtStart).length === 0;
    if (exitCode === 1 && wroteNothingThisLifecycle && !isBinaryAvailable(this.agentBinaryName())) {
      const retryMs = this.binaryUnavailableRetryDelayMs();
      this.log(
        `Agent binary "${this.agentBinaryName()}" is not executable on PATH — runtime is missing or ` +
        `mid-install, not an agent fault. Retrying in ${retryMs / 1000}s without counting against ` +
        `max_crashes_per_day.`,
      );
      this.appendCrashToRestartsLog(exitCode, retryMs, 'BINARY_UNAVAILABLE_RECOVERY');
      this.status = 'crashed';
      this.notifyStatusChange();
      setTimeout(() => {
        if (this.status === 'crashed') {
          this.start().catch(err => this.log(`Binary-unavailable restart failed: ${err}`));
        }
      }, retryMs);
      return;
    }

    // CrashLoopPauser (instar-inspired): if a sliding window is configured,
    // check whether the agent is crash-looping before falling through to
    // the legacy daily counter. The window is a more precise signal than
    // the per-day count: 3 crashes in 30 minutes is a crash loop even if
    // the daily budget of 10 is far from exhausted.
    if (this.crashWindowMs > 0) {
      const now = Date.now();
      this.crashTimestamps.push(now);
      // Prune timestamps outside the window.
      this.crashTimestamps = this.crashTimestamps.filter(
        (ts) => now - ts <= this.crashWindowMs,
      );
      if (this.crashTimestamps.length >= this.crashWindowMax) {
        this.log(
          `CRASH_LOOP: ${this.crashTimestamps.length} crashes in ${this.crashWindowMs / 1000}s window — auto-pausing`,
        );
        this.appendCrashToRestartsLog(exitCode, 0, 'CRASH_LOOP');
        this.status = 'halted';
        this.notifyStatusChange();
        return;
      }
    }

    // Legacy daily crash counter (fallback when no crash_window is configured,
    // or as a secondary gate when the window hasn't filled yet).
    this.crashCount++;
    const today = new Date().toISOString().split('T')[0];
    this.resetCrashCountIfNewDay(today);

    if (this.crashCount >= this.maxCrashesPerDay) {
      this.log(`HALTED: exceeded ${this.maxCrashesPerDay} crashes today`);
      this.appendCrashToRestartsLog(exitCode, 0, 'HALTED');
      this.status = 'halted';
      this.notifyStatusChange();
      return;
    }

    // Exponential backoff restart
    const backoff = Math.min(5000 * Math.pow(2, this.crashCount - 1), 300000);
    this.log(`Crash recovery: restart in ${backoff / 1000}s (crash #${this.crashCount})`);
    // Persist the crash to restarts.log so operators have a durable audit
    // trail. Previously only planned SELF-RESTART / HARD-RESTART from
    // bus/system.ts wrote here, which left daemon-classified crashes
    // invisible outside the rotating PM2 daemon stdout log.
    this.appendCrashToRestartsLog(exitCode, backoff, 'CRASH');
    this.status = 'crashed';
    this.notifyStatusChange();

    setTimeout(() => {
      if (this.status === 'crashed') {
        this.start().catch(err => this.log(`Restart failed: ${err}`));
      }
    }, backoff);
  }

  private shouldContinue(): boolean {
    // Hermes: session continuity is determined by whether the SQLite DB exists.
    // HERMES_HOME env var overrides the default ~/.hermes path.
    if (this.config.runtime === 'hermes') {
      const hermesHome = process.env['HERMES_HOME'];
      return hermesDbExists(hermesHome);
    }

    // Check for force-fresh marker (all runtimes honor it).
    const forceFreshPath = join(this.env.ctxRoot, 'state', this.name, '.force-fresh');
    if (existsSync(forceFreshPath)) {
      try {
        const { unlinkSync } = require('fs');
        unlinkSync(forceFreshPath);
      } catch { /* ignore */ }
      return false;
    }

    // codex-app-server: session continuity is tracked by the adapter's own
    // codex-app-server-thread.json under ctxRoot/state/<agent>/. The Claude
    // JSONL check below is meaningless for the codex runtime, and a stale
    // Claude JSONL left over from a prior Claude-runtime tenure caused
    // continue-mode → thread/resume timeout → exit_code=0 crash loop
    // (testorg codex-agent crashed 3x with this signature on 2026-05-09,
    // 05-14, and 05-16 before backoff drained the pending resume RPC).
    if (this.config.runtime === 'codex-app-server') {
      const threadStatePath = join(
        this.env.ctxRoot,
        'state',
        this.name,
        'codex-app-server-thread.json',
      );
      return existsSync(threadStatePath);
    }

    // opencode: do not inspect Claude JSONL history. The OpencodePTY adapter
    // writes a lightweight marker after a successful spawn; that marker is the
    // only signal that the next boot should pass `opencode --continue`.
    if (this.config.runtime === 'opencode') {
      return opencodeSessionExists(this.env.ctxRoot, this.name);
    }

    // Default (Claude runtime): existing conversation = JSONL files present.
    const launchDir = this.config.working_directory || this.env.agentDir;
    if (!launchDir) return false;

    // Claude projects dir uses the absolute path with all separators replaced by dashes
    // e.g. /Users/foo/agents/boss -> -Users-foo-agents-boss (leading sep becomes -)
    // Use homedir() for cross-platform compatibility (HOME is not set on Windows).
    const convDir = join(
      homedir(),
      '.claude',
      'projects',
      launchDir.split(sep).join('-'),
    );

    try {
      const files = require('fs').readdirSync(convDir);
      return files.some((f: string) => f.endsWith('.jsonl'));
    } catch {
      return false;
    }
  }

  private buildStartupPrompt(): string {
    const onboardedPath = join(this.env.ctxRoot, 'state', this.name, '.onboarded');
    const onboardingPath = join(this.env.agentDir, 'ONBOARDING.md');
    let onboardingAppend = '';

    if (!existsSync(onboardedPath) && existsSync(onboardingPath)) {
      onboardingAppend = ' IMPORTANT: This is your FIRST BOOT. Before doing anything else, read ONBOARDING.md and complete the onboarding protocol.';
    }

    const nowUtc = new Date().toISOString();
    const reminderBlock = this.buildReminderBlock();
    const deliverablesBlock = this.buildDeliverablesBlock();
    const handoffBlock = this.consumeHandoffBlock();
    const isHandoffRestart = handoffBlock.length > 0;
    this.lastSpawnWasHandoff = isHandoffRestart;
    const telegram = this.canSendTelegram();
    // HANDOFF UX: the pickup message MUST be the first action after reading the handoff doc —
    // before cron restoration, before heartbeat, before anything else. Placing this instruction
    // immediately after the handoffBlock in the prompt ensures it is not buried.
    const shouldPromptTelegram = this.shouldPromptTelegramOnlineMessage();
    const handoffUxOverride = isHandoffRestart
      ? (telegram
        // Telegram-capable: upstream's telegram_polling gate still applies.
        ? (shouldPromptTelegram
          ? ' HANDOFF UX: This is a context handoff restart — your memory is intact via the handoff doc. CRITICAL: After reading the handoff document, your VERY FIRST tool call MUST be a Bash call running: cortextos bus send-telegram $CTX_TELEGRAM_CHAT_ID \'back — [what you were just working on]\' — replace the brackets with one brief plain-English sentence about your current state. Do this BEFORE running heartbeat, BEFORE any other tool call. No cron IDs, no status report, no cold-boot phrasing. Do NOT send "Booting up... one moment" (skip AGENTS.md step 1 entirely).'
          : '')
        // Bus-only (#107): ordering send-telegram here exits 1. update-heartbeat is
        // the only channel these agents have, and it is what the dashboard shows.
        : ' HANDOFF UX: This is a context handoff restart — your memory is intact via the handoff doc. You have NO Telegram bot configured, so do NOT attempt send-telegram; it will fail. Instead, after reading the handoff document, your VERY FIRST tool call MUST be a Bash call running: cortextos bus update-heartbeat \'back — [what you were just working on]\' — replace the brackets with one brief plain-English sentence about your current state. That string is what the dashboard shows a human, so write it as a sentence, not a status code. Do this BEFORE any other tool call. No cron IDs, no cold-boot phrasing.')
      : '';
    // Gate ONLY the Telegram instruction on telegram_polling (upstream). The bus-only
    // branch must NOT sit behind that predicate: shouldPromptTelegram is false for every
    // bus-only agent by construction (telegramApi is only wired when BOT_TOKEN is set), so
    // gating it there silently deletes #107's instruction for exactly the five agents it
    // was written for, while leaving the string in the file for a grep to find.
    const onlineMessage = isHandoffRestart
      ? ''
      : (telegram
        ? (shouldPromptTelegram
          ? ' Send a Telegram message to the user saying you are back online.'
          : '')
        : ' You have NO Telegram bot configured — do NOT attempt send-telegram. Report you are back online with: cortextos bus update-heartbeat \'<one-sentence status>\'.');
    return `You are starting a new session. Current UTC time: ${nowUtc}. Read AGENTS.md and all bootstrap files listed there. External crons are auto-loaded by the daemon — do NOT call CronCreate or CronList for cron restoration.${reminderBlock}${deliverablesBlock}${handoffBlock}${handoffUxOverride}${onlineMessage}${onboardingAppend}`;
  }

  private buildContinuePrompt(): string {
    const nowUtc = new Date().toISOString();
    const reminderBlock = this.buildReminderBlock();
    const deliverablesBlock = this.buildDeliverablesBlock();
    // Session refresh (--continue) is never a handoff restart.
    this.lastSpawnWasHandoff = false;
    const backOnline = this.canSendTelegram()
      ? (this.shouldPromptTelegramOnlineMessage()
        ? ' After checking inbox, send a Telegram message to the user saying you are back online.'
        : '')
      : ' You have NO Telegram bot configured — do NOT attempt send-telegram. After checking inbox, report you are back online with: cortextos bus update-heartbeat \'<one-sentence status>\'.';
    return `SESSION CONTINUATION: Your CLI process was restarted with --continue to reload configs. Current UTC time: ${nowUtc}. Your full conversation history is preserved. Re-read AGENTS.md and ALL bootstrap files listed there. External crons are auto-loaded by the daemon — do NOT call CronCreate or CronList for cron restoration.${reminderBlock}${deliverablesBlock} Check inbox. Resume normal operations.${backOnline}`;
  }

  /**
   * Whether a back-online / handoff instruction can actually be honoured, by
   * EITHER delivery path. Both exist and neither alone is sufficient:
   *
   *  - the AGENT self-sends via `cortextos bus send-telegram`, which reads
   *    BOT_TOKEN from the agent .env / process env (see hasTelegram) — this is
   *    the claude-code shape, where the daemon never wires a handle at all;
   *  - the DAEMON sends via a handle wired by setTelegramHandle() — the codex /
   *    opencode shape, where the agent .env may carry no token.
   *
   * Keying on only the handle silences a token-holding claude agent; keying on
   * only BOT_TOKEN silences a handle-wired opencode agent. Both regressions are
   * covered by tests (agent-process-telegram-capability, agent-process-opencode),
   * which is how the union was established rather than assumed.
   */
  private canSendTelegram(): boolean {
    return this.hasTelegram() || (!!this.telegramApi && !!this.telegramChatId);
  }

  private shouldPromptTelegramOnlineMessage(): boolean {
    return this.config.telegram_polling !== false && this.canSendTelegram();
  }

  /**
   * Whether this agent can actually send Telegram.
   *
   * Keys on BOT_TOKEN having a VALUE, not on the `BUS_ONLY` marker. BUS_ONLY is a
   * classification that currently happens to select the right five agents; BOT_TOKEN
   * is the property that actually determines whether `send-telegram` succeeds. They
   * diverge on any newly-created agent: `add-agent` writes a literal `BOT_TOKEN=`
   * (empty) with no BUS_ONLY field, so a BUS_ONLY check would tell every fresh agent
   * to send Telegram it cannot send — the same defect, on a population that did not
   * exist when the marker was introduced.
   *
   * Note CHAT_ID is deliberately NOT a tell: it is set (to the same value) on all
   * five bus-only agents while BOT_TOKEN is empty, so its presence is a false
   * positive for Telegram capability.
   *
   * NO process.env fallback (fixed 2026-08-25, task_1787663199029_25580749): this
   * class only ever runs inside the daemon's own Node process, which is SHARED
   * across every agent. `process.env` there is the daemon's environment, never an
   * individual agent's — a `pm2 restart cortextos-daemon --update-env` run from
   * inside any one agent's shell leaks that agent's real BOT_TOKEN into the
   * daemon's process env, and a fallback here then reported EVERY agent as
   * Telegram-capable, including bus-only ones (reproduced twice on infra, same
   * incident). There is no legitimate standalone invocation of this method to
   * fall back for — the agent's own `.env` file is always present and is the
   * complete, correct signal.
   */
  private hasTelegram(): boolean {
    try {
      const envPath = join(this.env.agentDir, '.env');
      if (existsSync(envPath)) {
        const match = readFileSync(envPath, 'utf-8').match(/^BOT_TOKEN=(.+)$/m);
        return !!(match && match[1].trim());
      }
    } catch { /* .env unreadable — no telegram, do not fall back to process.env */ }
    return false;
  }

  /**
   * Build a reminder block for the boot prompt.
   *
   * SUPERSEDES the old "restart is the only delivery path" framing: as of
   * task_1783983487266_03083173, ReminderScheduler (src/daemon/reminder-
   * scheduler.ts) live-polls pending-reminders.json every 30s and injects
   * overdue reminders into a RUNNING session, the same way CronScheduler
   * fires crons. This method is now the restart-time BACKSTOP of that same
   * delivery mechanism, not the only path: it re-surfaces any reminder still
   * `pending` at boot/continue, including one the live poller already
   * injected but the agent hadn't acked before the restart happened.
   *
   * Marks every reminder it includes via markReminderInjected — the same
   * dedup marker ReminderScheduler sets on a successful live delivery — so a
   * reminder shown here isn't redundantly re-injected by the live poller 30
   * seconds into the new session. Marking does not suppress a FUTURE restart
   * from showing it again; only `ack-reminder` does that (see
   * src/bus/reminders.ts's injected_at docs for why the two are separate).
   */
  private buildReminderBlock(): string {
    try {
      const paths = resolvePaths(this.name, this.env.instanceId, this.env.org, this.env.ctxRoot);
      const overdue = getOverdueReminders(paths);
      if (overdue.length === 0) return '';
      const items = overdue.map(r =>
        `  - [${r.id}] (due ${r.fire_at}): ${r.prompt}`,
      ).join('\n');
      for (const r of overdue) {
        try { markReminderInjected(paths, r.id); } catch { /* best-effort dedup marker */ }
      }
      return ` You also have ${overdue.length} overdue persistent reminder(s) from before this restart — handle each one, then run: cortextos bus ack-reminder <id>\n${items}`;
    } catch {
      return '';
    }
  }

  /**
   * Build a deliverable-standard instruction block for the boot prompt.
   * When require_deliverables is enabled in the org's context.json, agents
   * are told that every task submitted for review must have at least one
   * file attached via save-output. The instruction is injected dynamically
   * so existing agents pick up the rule on their next boot with zero file
   * changes, and toggling it off removes it from the next startup prompt.
   */
  private buildDeliverablesBlock(): string {
    try {
      const contextPath = join(this.env.frameworkRoot, 'orgs', this.env.org, 'context.json');
      if (!existsSync(contextPath)) return '';
      const ctx = JSON.parse(readFileSync(contextPath, 'utf-8'));
      if (!ctx.require_deliverables) return '';
      return ' DELIVERABLE STANDARD: Every task you submit for review MUST have at least one file deliverable attached via the save-output bus command. A task with zero file deliverables will be sent back. Attach files with: cortextos bus save-output <task-id> <file-path> --label "<descriptive label>". Labels must be human-readable at a glance: describe WHAT it is plus enough context to understand at a glance. Good: "Traffic Growth Plan — 10 channels, 30-day launch sequence". Bad: "traffic-growth-plan.md" or "output-1". Notes are for context only, never file paths or URLs.';
    } catch {
      return '';
    }
  }

  /**
   * Consume the .handoff-doc-path marker (written by the context watchdog or the
   * agent itself via `cortextos bus hard-restart --handoff-doc <path>`).
   * Returns a boot-prompt fragment pointing the new session at the handoff doc,
   * or an empty string if no marker exists.
   * The marker is unlinked after reading so it fires only once per restart.
   */
  private consumeHandoffBlock(): string {
    const markerPath = join(this.env.ctxRoot, 'state', this.name, '.handoff-doc-path');
    if (!existsSync(markerPath)) return '';
    try {
      const docPath = readFileSync(markerPath, 'utf-8').trim();
      unlinkSync(markerPath);
      if (!docPath || !existsSync(docPath)) return '';
      return ` CONTEXT HANDOFF: Before restoring crons or checking inbox, read the handoff document at ${docPath} to resume your prior session state.`;
    } catch {
      return '';
    }
  }

  /**
   * Issue #392 / OpenCode parity: send lifecycle Telegram directly from the
   * daemon for runtimes whose startup/continue prompts are not reliable enough
   * to guarantee a user-visible notification.
   *
   * codex-app-server: the boot prompt's inline "Send a Telegram message..."
   * instruction reaches the codex thread but is not executed reliably as a tool
   * call, leaving James without the standard post-restart notification
   * claude-code peers send.
   *
   * opencode: the prompt is injected into the persistent TUI after startup.
   * Real production evidence showed an OpenCode --continue restart updated the
   * process/session markers but emitted no Telegram message, so lifecycle
   * visibility must be daemon-owned just like Codex.
   *
   * Two distinct notifications, mirroring what a claude-code agent emits:
   *  - msg1 (planned-restart lifecycle, "🔄 <agent> restarted (planned): ..."):
   *    for claude this is sent by hook-crash-alert.ts on PTY exit. codex/opencode
   *    runtimes do NOT run Claude Code hooks, so on a handoff restart the daemon
   *    emits the same notification here for parity (James saw msg1 only for
   *    claude agents otherwise). Format mirrors hook-crash-alert.ts:394-397.
   *  - msg2 (back-online / "back — ..." summary): codex reliably self-sends its
   *    own contextual reply via the boot prompt; opencode (deepseek) does NOT, so
   *    the daemon sends a handoff-flavored back-online ping for opencode only.
   *
   * Skipped when:
   *  - runtime is anything other than codex-app-server/opencode (claude-code
   *    and hermes already emit both via the hook + prompt),
   *  - Telegram is disabled or no Telegram handle has been wired.
   */
  private maybeSendRuntimeLifecycleNotification(): void {
    if (this.config.runtime !== 'codex-app-server' && this.config.runtime !== 'opencode') return;
    if (!this.shouldPromptTelegramOnlineMessage()) return;
    const telegramApi = this.telegramApi;
    const telegramChatId = this.telegramChatId;
    if (!telegramApi || !telegramChatId) return;
    const send = (text: string) =>
      telegramApi
        .sendMessage(telegramChatId, text)
        .catch(() => { /* non-fatal: notification is observability only */ });

    if (this.lastSpawnWasHandoff) {
      // msg1: planned-restart lifecycle notif, hook parity for runtimes without
      // Claude Code hooks. Both codex and opencode were missing this.
      send(this.buildPlannedRestartNotification());
      // msg2 ("back — ...") is self-sent by the agent via the handoff boot prompt
      // (agent-process.ts buildStartupPrompt handoffUxOverride) for BOTH codex and
      // opencode — opencode now reliably honors it. The daemon used to send an
      // "Agent X is back online (context handoff)" substitute for opencode, but
      // that produced a redundant 3rd message on top of the self-sent "back —".
      // Removed: msg1 (daemon) + msg2 (agent self-send) = clean 2-message pattern.
      return;
    }

    // Non-handoff restart (crash recovery / config reload): both runtimes need
    // the daemon-emitted back-online ping.
    send(`Agent ${this.name} is back online`);
  }

  /**
   * Build the planned-restart lifecycle notification (msg1) for codex/opencode,
   * reading the reason from the `.restart-planned` marker and matching the
   * hook-crash-alert.ts:394-397 format string exactly so codex/opencode parity
   * is byte-identical to what claude agents emit via the hook.
   */
  private buildPlannedRestartNotification(): string {
    let reason = '';
    try {
      const markerPath = join(this.env.ctxRoot, 'state', this.name, '.restart-planned');
      if (existsSync(markerPath)) {
        reason = readFileSync(markerPath, 'utf-8').trim();
      }
    } catch { /* non-fatal — fall through to generic reason */ }
    return reason.startsWith('CONTEXT-FORCE-RESTART')
      ? `🔄 ${this.name} restarting with memory`
      : `🔄 ${this.name} restarted (planned): ${reason || 'no reason given'}`;
  }

  private startSessionTimer(): void {
    const DEFAULT_MAX_SESSION_S = 255600;
    // Node setTimeout uses int32 ms internally. Values > 2^31-1 (~24.8d) silently
    // coerce to 1ms, which combined with the BUG-048 reschedule loop below causes
    // an infinite tight loop. Clamp at the call site so any future misconfigured
    // max_session_seconds (e.g. a stray 3600000s = 1000h) cannot wedge the daemon.
    const MAX_SETTIMEOUT_MS = 2_147_483_647;
    const startedAt = Date.now();
    const initialMs = (this.config.max_session_seconds || DEFAULT_MAX_SESSION_S) * 1000;

    // BUG-048 fix: re-read max_session_seconds from config.json on each timer
    // fire so that config changes after start() take effect. Without this, a
    // briefly-low max_session_seconds baked at start time causes a fleet-wide
    // simultaneous restart when all agents hit the same stale deadline.
    const scheduleCheck = (delayMs: number): void => {
      this.sessionTimer = setTimeout(() => {
        // Re-read current config from disk
        let currentMaxMs = initialMs;
        try {
          const configPath = join(this.env.agentDir, 'config.json');
          if (existsSync(configPath)) {
            const cfg = JSON.parse(readFileSync(configPath, 'utf-8'));
            currentMaxMs = (cfg.max_session_seconds || DEFAULT_MAX_SESSION_S) * 1000;
          }
        } catch { /* use initial value on read error */ }

        const elapsedMs = Date.now() - startedAt;
        const remainingMs = currentMaxMs - elapsedMs;

        if (remainingMs > 5000) {
          // Config was updated to a longer duration — reschedule for the remaining time.
          this.log(`Session timer: config updated to ${currentMaxMs / 1000}s, rescheduling (${Math.round(remainingMs / 1000)}s remaining)`);
          scheduleCheck(remainingMs);
          return;
        }

        this.log(`Session timer fired after ${Math.round(elapsedMs / 1000)}s (limit: ${currentMaxMs / 1000}s)`);
        this.sessionRefresh().catch(err => this.log(`Session refresh failed: ${err}`));
      }, Math.min(delayMs, MAX_SETTIMEOUT_MS));
    };

    scheduleCheck(initialMs);
  }

  private clearSessionTimer(): void {
    if (this.sessionTimer) {
      clearTimeout(this.sessionTimer);
      this.sessionTimer = null;
    }
  }

  /**
   * Check whether the daemon is currently in its shutdown sequence.
   *
   * Returns true iff a `.daemon-stop` marker exists in this agent's state
   * dir AND was written within the last 60 seconds. The marker is written
   * by AgentManager.stopAll() before it begins iterating stopAgent() calls.
   * A stale marker older than 60s is treated as leftover from a prior
   * shutdown and ignored — real crashes must not be masked indefinitely.
   */
  private isDaemonShuttingDown(): boolean {
    const marker = join(this.env.ctxRoot, 'state', this.name, '.daemon-stop');
    try {
      if (!existsSync(marker)) return false;
      const ageMs = Date.now() - statSync(marker).mtimeMs;
      return ageMs < 60_000;
    } catch {
      return false;
    }
  }

  /**
   * Append an unplanned-exit entry to restarts.log. Complements the planned
   * SELF-RESTART / HARD-RESTART entries written by src/bus/system.ts so that
   * a single file gives the complete restart history for an agent.
   *
   * Format matches bus/system.ts: `[ISO] <KIND>: <details>`. appendFileSync
   * uses write(2) with O_APPEND on Linux, which is atomic for writes under
   * PIPE_BUF (~4KB) — each CRASH line fits comfortably. All errors are
   * swallowed: logging must never break crash recovery.
   */
  private appendCrashToRestartsLog(
    exitCode: number,
    backoffMs: number,
    kind: 'CRASH' | 'HALTED' | 'CRASH_LOOP' | 'IMAGE_POISON_RECOVERY' | 'RATE_LIMIT_RECOVERY'
      | 'BINARY_UNAVAILABLE_RECOVERY',
  ): void {
    try {
      const logDir = join(this.env.ctxRoot, 'logs', this.name);
      ensureDir(logDir);
      const timestamp = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
      const notCountedTowardMaxCrashes = kind === 'IMAGE_POISON_RECOVERY' || kind === 'RATE_LIMIT_RECOVERY'
        || kind === 'BINARY_UNAVAILABLE_RECOVERY';
      const details =
        kind === 'HALTED'
          ? `exit_code=${exitCode} crash_count=${this.crashCount} max_crashes=${this.maxCrashesPerDay}`
          : notCountedTowardMaxCrashes
            ? `exit_code=${exitCode} backoff_s=${backoffMs / 1000} (not counted toward max_crashes)`
            : `exit_code=${exitCode} crash_count=${this.crashCount} backoff_s=${backoffMs / 1000}`;
      const logLine = `[${timestamp}] ${kind}: ${details}\n`;
      appendFileSync(join(logDir, 'restarts.log'), logLine, 'utf-8');
    } catch {
      /* swallow — never break crash recovery on a logging failure */
    }
  }

  private resetCrashCountIfNewDay(today: string): void {
    const crashFile = join(this.env.ctxRoot, 'logs', this.name, '.crash_count_today');
    try {
      if (existsSync(crashFile)) {
        const content = readFileSync(crashFile, 'utf-8').trim();
        const [storedDate, count] = content.split(':');
        if (storedDate === today) {
          this.crashCount = parseInt(count, 10) + 1;
        } else {
          this.crashCount = 1;
        }
      }
      ensureDir(join(this.env.ctxRoot, 'logs', this.name));
      writeFileSync(crashFile, `${today}:${this.crashCount}`, 'utf-8');
    } catch { /* ignore */ }
  }

  private notifyStatusChange(): void {
    if (this.onStatusChange) {
      this.onStatusChange(this.getStatus());
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
