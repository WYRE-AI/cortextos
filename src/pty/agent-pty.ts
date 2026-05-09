import { join } from 'path';
import { existsSync, readFileSync, readdirSync } from 'fs';
import { execFileSync } from 'child_process';
import { platform, homedir } from 'os';
import type { AgentConfig, CtxEnv } from '../types/index.js';
import { OutputBuffer } from './output-buffer.js';

// node-pty types
interface IPty {
  pid: number;
  write(data: string): void;
  onData(callback: (data: string) => void): { dispose(): void };
  onExit(callback: (e: { exitCode: number; signal?: number }) => void): { dispose(): void };
  kill(signal?: string): void;
  resize(cols: number, rows: number): void;
}

interface IPtySpawnOptions {
  name?: string;
  cols?: number;
  rows?: number;
  cwd?: string;
  env?: Record<string, string>;
}

type SpawnFn = (file: string, args: string[], options: IPtySpawnOptions) => IPty;

/**
 * Manages a single Claude Code PTY session.
 * Replaces the tmux session management in agent-wrapper.sh.
 */
export class AgentPTY {
  private pty: IPty | null = null;
  private _alive = false;
  private outputBuffer: OutputBuffer;
  private env: CtxEnv;
  private config: AgentConfig;
  private onExitHandler: ((exitCode: number, signal?: number) => void) | null = null;
  private spawnFn: SpawnFn | null = null;
  // Issue #326 watchdog: detect "injection went into a black hole" hangs —
  // an injection happens but the PTY produces ZERO output before the
  // timeout. A healthy agent that responds and then goes idle is NOT a
  // hang, even after long quiet periods — agents are supposed to be quiet
  // when they're done with a turn. The earlier "idleSinceOutput" check was
  // wrong: it treated normal post-turn quiet as a hang and killed healthy
  // agents on a 6-minute idle timer. Correct semantics: track whether ANY
  // output has been seen since the most recent injection. Hung iff
  // (sinceInjection >= timeout) AND (no output since injection).
  private lastInjectionAt: number = 0;
  private outputSeenSinceInjection: boolean = true;
  private hangTimer: ReturnType<typeof setInterval> | null = null;
  private hangFired: boolean = false;
  private onHangHandler: ((idleMs: number) => void) | null = null;
  private hangTimeoutMs: number = 0;

  constructor(env: CtxEnv, config: AgentConfig, logPath?: string, bootstrapPattern?: string) {
    this.env = env;
    this.config = config;
    this.outputBuffer = new OutputBuffer(1000, logPath, bootstrapPattern);
  }

  /**
   * Spawn Claude Code in a PTY process.
   *
   * @param mode 'fresh' for new conversation, 'continue' for preserving history
   * @param prompt The startup or continue prompt to pass to Claude
   */
  async spawn(mode: 'fresh' | 'continue', prompt: string): Promise<void> {
    if (this.pty) {
      throw new Error('PTY already spawned. Kill first.');
    }

    // Lazy-load node-pty (native addon)
    if (!this.spawnFn) {
      const nodePty = require('node-pty');
      this.spawnFn = nodePty.spawn;
    }

    const cwd = this.config.working_directory || this.env.agentDir || process.cwd();

    // Build environment variables for the PTY process
    const ptyEnv: Record<string, string> = {
      ...this.getBaseEnv(),
      CTX_INSTANCE_ID: this.env.instanceId,
      CTX_ROOT: this.env.ctxRoot,
      CTX_FRAMEWORK_ROOT: this.env.frameworkRoot,
      CTX_AGENT_NAME: this.env.agentName,
      CTX_ORG: this.env.org,
      CTX_AGENT_DIR: this.env.agentDir,
      CTX_PROJECT_ROOT: this.env.projectRoot,
      // Backward compat
      CRM_AGENT_NAME: this.env.agentName,
      CRM_TEMPLATE_ROOT: this.env.frameworkRoot,
    };

    // Source org-level shared secrets (orgs/{org}/secrets.env).
    // These are shared across all agents in the org: OPENAI_KEY, APIFY_TOKEN, GEMINI_API_KEY, etc.
    // Agent .env is loaded after and overrides org values — agent-specific keys win.
    if (this.env.org && this.env.projectRoot) {
      const orgEnvFile = join(this.env.projectRoot, 'orgs', this.env.org, 'secrets.env');
      if (existsSync(orgEnvFile)) {
        const content = readFileSync(orgEnvFile, 'utf-8');
        for (const line of content.split('\n')) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith('#')) continue;
          const eqIdx = trimmed.indexOf('=');
          if (eqIdx > 0) {
            ptyEnv[trimmed.slice(0, eqIdx).trim()] = trimmed.slice(eqIdx + 1).trim();
          }
        }
      }
    }

    // Source agent .env file (overrides org secrets.env for same key names).
    // Contains agent-specific secrets: BOT_TOKEN, CHAT_ID, CLAUDE_CODE_OAUTH_TOKEN.
    const agentEnvFile = join(this.env.agentDir, '.env');
    if (existsSync(agentEnvFile)) {
      const content = readFileSync(agentEnvFile, 'utf-8');
      for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eqIdx = trimmed.indexOf('=');
        if (eqIdx > 0) {
          ptyEnv[trimmed.slice(0, eqIdx).trim()] = trimmed.slice(eqIdx + 1).trim();
        }
      }
    }

    // Add convenience CTX_* aliases used throughout agent templates.
    // CTX_TELEGRAM_CHAT_ID: alias for CHAT_ID from the agent's .env
    if (ptyEnv['CHAT_ID']) {
      ptyEnv['CTX_TELEGRAM_CHAT_ID'] = ptyEnv['CHAT_ID'];
    }
    // CTX_TIMEZONE: from config.json timezone field, falls back to system TZ
    const configTimezone = this.config.timezone;
    if (configTimezone) {
      ptyEnv['CTX_TIMEZONE'] = configTimezone;
      ptyEnv['TZ'] = configTimezone; // also set TZ so date/time system calls use correct zone
    } else if (process.env.TZ) {
      ptyEnv['CTX_TIMEZONE'] = process.env.TZ;
    }
    // CTX_ORCHESTRATOR_AGENT: read from org context.json so agents can route to orchestrator
    if (this.env.projectRoot && this.env.org) {
      try {
        const contextPath = join(this.env.projectRoot, 'orgs', this.env.org, 'context.json');
        if (existsSync(contextPath)) {
          const ctx = JSON.parse(readFileSync(contextPath, 'utf-8'));
          if (ctx.orchestrator) {
            ptyEnv['CTX_ORCHESTRATOR_AGENT'] = ctx.orchestrator;
          }
        }
      } catch { /* leave unset if context.json is missing or malformed */ }
    }

    // Spawn the agent binary directly (no shell wrapper) — cross-platform, no shell escaping needed.
    // env is passed natively via node-pty options; no bash export commands required.
    // On Windows, npm global installs create .cmd wrappers, not .exe binaries.
    // node-pty's CreateProcess requires the exact wrapper name to resolve correctly.
    const claudeArgs = this.buildClaudeArgs(mode, prompt);
    const claudeCmd = this.getBinaryName();

    this.pty = this.spawnFn!(claudeCmd, claudeArgs, {
      name: 'xterm-256color',
      cols: 200,
      rows: 50,
      cwd,
      env: ptyEnv,
    });

    this._alive = true;

    // Set up output capture
    this.pty.onData((data: string) => {
      // Any output between an injection and the watchdog timeout proves the
      // agent received the injection — even if it then goes quiet, that's
      // a normal completed turn, not a hang. Re-arming hangFired here lets
      // the next injection start fresh.
      this.outputSeenSinceInjection = true;
      this.hangFired = false;
      this.outputBuffer.push(data);
    });

    // Set up exit handler
    this.pty.onExit(({ exitCode, signal }) => {
      this._alive = false;
      this.pty = null;
      if (this.onExitHandler) {
        this.onExitHandler(exitCode, signal);
      }
    });

    // Claude Code shows a "trust this folder?" prompt on first run in a new directory.
    // Auto-accept by sending Enter after the prompt appears.
    // The prompt takes ~3-5s to render; we send Enter at 5s and 8s for reliability.
    setTimeout(() => {
      if (this.pty) {
        const recent = this.outputBuffer.getRecent();
        if (recent.includes('trust') || recent.includes('Yes')) {
          this.pty.write('\r');
        }
      }
    }, 5000);
    setTimeout(() => {
      if (this.pty) {
        const recent = this.outputBuffer.getRecent();
        if (recent.includes('trust') || recent.includes('Yes')) {
          this.pty.write('\r');
        }
      }
    }, 8000);
  }

  /**
   * Returns the binary path for the agent process.
   * Protected so HermesPTY can override to return 'hermes'.
   *
   * Issue #342: PM2 caches PATH at daemon-spawn time. When Claude Code
   * self-updates and the binary moves (e.g. from /usr/local/bin/claude to
   * ~/.local/bin/claude), bare `claude` resolution against PM2's frozen
   * PATH fails and every agent spawn silently exits 1. Re-resolving to an
   * absolute path on each spawn — through the user's login shell so live
   * PATH is consulted, plus a fallback scan of the install locations
   * Claude Code actually uses — closes that failure mode.
   */
  protected getBinaryName(): string {
    if (platform() !== 'win32') return this.resolveClaudeBinaryUnix();
    // The Claude Code Windows installer historically shipped a `claude.cmd`
    // shim alongside `claude.exe`. Newer installers (e.g. when claude lives
    // under `~/.local/bin`) ship only `claude.exe` and have no `.cmd` shim.
    // Hardcoding `claude.cmd` causes node-pty/ConPTY to fail with an empty
    // "File not found" error before the agent ever boots.
    //
    // Probe PATH for whichever extension is present and prefer `.exe` —
    // it spawns more cleanly under ConPTY than a `.cmd` wrapper, and matches
    // what `where.exe claude` returns on current installs.
    const pathDirs = (process.env.PATH || '').split(';').filter(Boolean);
    for (const ext of ['.exe', '.cmd']) {
      for (const dir of pathDirs) {
        if (existsSync(join(dir, `claude${ext}`))) {
          return `claude${ext}`;
        }
      }
    }
    // Neither found on PATH — fall back to the legacy default so the error
    // message from node-pty surfaces a recognizable filename for debugging.
    return 'claude.cmd';
  }

  private resolveClaudeBinaryUnix(): string {
    const home = homedir();
    // Order matters: prefer user-local installs (~/.local/bin, ~/.claude/local)
    // because that's where Claude Code self-updater writes new binaries on
    // macOS/Linux. PM2's frozen PATH may still point at an older system path.
    const candidates = [
      join(home, '.local/bin/claude'),
      join(home, '.claude/local/claude'),
      '/opt/homebrew/bin/claude',
      '/usr/local/bin/claude',
      '/usr/bin/claude',
    ];
    for (const p of candidates) {
      if (existsSync(p)) return p;
    }
    try {
      const out = execFileSync('/usr/bin/which', ['claude'], {
        encoding: 'utf-8',
        timeout: 5000,
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
      if (out && existsSync(out)) return out;
    } catch { /* ignore */ }
    return 'claude';
  }

  /**
   * Build the claude CLI argument array.
   * Returns args suitable for passing directly to node-pty spawn (no shell escaping needed).
   * Protected so HermesPTY can override this for its own spawn args.
   */
  protected buildClaudeArgs(mode: 'fresh' | 'continue', prompt: string): string[] {
    const args: string[] = [];

    if (mode === 'continue') {
      args.push('--continue');
    }

    args.push('--dangerously-skip-permissions');

    if (this.config.model) {
      args.push('--model', this.config.model);
    }

    // Local override pattern (feat #20): concatenate {agentDir}/local/*.md files
    // and append as system prompt. The local/ dir is gitignored so users can customize
    // agent behavior without merge conflicts on framework updates.
    const agentDir = this.env.agentDir;
    if (agentDir) {
      const localDir = join(agentDir, 'local');
      if (existsSync(localDir)) {
        try {
          const mdFiles = readdirSync(localDir)
            .filter(f => f.endsWith('.md'))
            .sort()
            .map(f => join(localDir, f));
          if (mdFiles.length > 0) {
            const localContent = mdFiles
              .map(f => readFileSync(f, 'utf-8'))
              .join('\n\n');
            args.push('--append-system-prompt', localContent);
          }
        } catch { /* ignore read errors */ }
      }
    }

    // Pass prompt as a plain string — no shell escaping needed when using node-pty directly
    args.push(prompt);

    return args;
  }

  /**
   * Write data to the PTY.
   */
  write(data: string): void {
    if (!this.pty) {
      throw new Error('PTY not spawned');
    }
    this.lastInjectionAt = Date.now();
    this.outputSeenSinceInjection = false;
    this.hangFired = false;
    this.pty.write(data);
  }

  /**
   * Enable the hang watchdog. Calls handler once per detected hang
   * (alive PTY + no stdout for `timeoutMs` after the most recent injection).
   * The handler is responsible for any kill/restart decision.
   *
   * Issue #326: Telegram photo injection has been observed to leave the
   * PTY alive but stdout-idle indefinitely. Without a watchdog the daemon
   * happily keeps queueing further injections that the agent will never
   * process.
   */
  enableHangWatchdog(timeoutMs: number, handler: (idleMs: number) => void): void {
    this.hangTimeoutMs = timeoutMs;
    this.onHangHandler = handler;
    if (this.hangTimer) clearInterval(this.hangTimer);
    this.hangTimer = setInterval(() => this.checkHang(), Math.max(100, Math.floor(timeoutMs / 4)));
  }

  private checkHang(): void {
    if (!this._alive || !this.pty || this.hangFired || this.hangTimeoutMs <= 0) return;
    if (this.lastInjectionAt === 0) return; // never injected — nothing to watch
    if (this.outputSeenSinceInjection) return; // agent acked the inject — healthy
    const sinceInjection = Date.now() - this.lastInjectionAt;
    if (sinceInjection >= this.hangTimeoutMs) {
      this.hangFired = true;
      this.onHangHandler?.(sinceInjection);
    }
  }

  /**
   * Kill the PTY process.
   */
  kill(): void {
    if (this.hangTimer) {
      clearInterval(this.hangTimer);
      this.hangTimer = null;
    }
    const pty = this.pty;
    if (pty) {
      this._alive = false;
      this.pty = null;
      pty.kill();
    }
  }

  /**
   * Check if the PTY process is alive.
   * Uses an internal flag set by the onExit handler — cross-platform safe.
   * (process.kill(pid, 0) is unreliable on Windows.)
   */
  isAlive(): boolean {
    return this._alive && this.pty !== null;
  }

  /**
   * Get the PTY PID.
   */
  getPid(): number | null {
    return this.pty?.pid || null;
  }

  /**
   * Register an exit handler.
   */
  onExit(handler: (exitCode: number, signal?: number) => void): void {
    this.onExitHandler = handler;
  }

  /**
   * Get the output buffer for inspection.
   */
  getOutputBuffer(): OutputBuffer {
    return this.outputBuffer;
  }

  /**
   * Get a clean base environment (excluding potentially harmful vars).
   */
  private getBaseEnv(): Record<string, string> {
    const env: Record<string, string> = {};
    // Copy essential env vars
    const keepVars = [
      'PATH', 'HOME', 'USER', 'SHELL', 'TERM', 'LANG', 'LC_ALL',
      'TMPDIR', 'TEMP', 'TMP', 'ANTHROPIC_API_KEY', 'CLAUDE_API_KEY',
      'NODE_PATH', 'COMSPEC', 'USERPROFILE',
      // Windows path-expansion essentials. Stripping these causes phantom
      // %SystemDrive% directories from inherited Search Indexer processes
      // and Unity batchmode UPM IPC crashes (path.join(undefined,...)).
      'SystemDrive', 'SystemRoot', 'windir',
      'APPDATA', 'LOCALAPPDATA', 'ProgramData', 'ALLUSERSPROFILE',
      'ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432',
      'HOMEDRIVE', 'HOMEPATH', 'PUBLIC',
    ];
    for (const key of keepVars) {
      if (process.env[key]) {
        env[key] = process.env[key]!;
      }
    }

    // Windows: ensure UTF-8 locale so emoji and Unicode pass through the PTY
    if (platform() === 'win32') {
      if (!env['LANG']) env['LANG'] = 'en_US.UTF-8';
      if (!env['LC_ALL']) env['LC_ALL'] = 'en_US.UTF-8';
      if (!process.env['PYTHONIOENCODING']) env['PYTHONIOENCODING'] = 'utf-8';
    }

    return env;
  }
}
