import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * Boot/restart prompts must not order an agent to send Telegram it cannot send.
 *
 * Found live 2026-08-15: the context-handoff directive told EVERY agent its "VERY
 * FIRST tool call MUST be" `cortextos bus send-telegram …`. On the bus-only agents
 * BOT_TOKEN is empty, so that mandated first action exits 1 on every restart.
 */

const mockPty = {
  spawn: vi.fn().mockResolvedValue(undefined),
  kill: vi.fn(),
  write: vi.fn(),
  getPid: vi.fn().mockReturnValue(12345),
  isAlive: vi.fn().mockReturnValue(true),
  onExit: vi.fn(),
};

vi.mock('../../../src/pty/agent-pty.js', () => ({
  AgentPTY: function AgentPTY() { return mockPty; },
}));

vi.mock('../../../src/pty/inject.js', () => ({
  injectMessage: vi.fn(),
  MessageDedup: class { isDuplicate() { return false; } },
}));

vi.mock('../../../src/utils/atomic.js', () => ({
  ensureDir: vi.fn(),
  atomicWriteSync: vi.fn(),
}));

vi.mock('../../../src/utils/env.js', () => ({
  writeCortextosEnv: vi.fn(),
  resolveEnv: vi.fn().mockReturnValue({ instanceId: 'test', ctxRoot: '/tmp/test' }),
}));

vi.mock('../../../src/bus/reminders.js', () => ({
  getOverdueReminders: vi.fn().mockReturnValue([]),
}));

vi.mock('../../../src/utils/paths.js', () => ({
  resolvePaths: vi.fn().mockReturnValue({ stateDir: '/tmp/test-ctx/state/alice' }),
}));

const fsMocks = {
  existsSync: vi.fn().mockReturnValue(false),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  appendFileSync: vi.fn(),
  statSync: vi.fn(),
  unlinkSync: vi.fn(),
};

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    get existsSync() { return fsMocks.existsSync; },
    get readFileSync() { return fsMocks.readFileSync; },
    get writeFileSync() { return fsMocks.writeFileSync; },
    get appendFileSync() { return fsMocks.appendFileSync; },
    get statSync() { return fsMocks.statSync; },
    get unlinkSync() { return fsMocks.unlinkSync; },
    default: {
      ...actual,
      get existsSync() { return fsMocks.existsSync; },
      get readFileSync() { return fsMocks.readFileSync; },
      get writeFileSync() { return fsMocks.writeFileSync; },
      get appendFileSync() { return fsMocks.appendFileSync; },
      get statSync() { return fsMocks.statSync; },
      get unlinkSync() { return fsMocks.unlinkSync; },
    },
  };
});

const { AgentProcess } = await import('../../../src/daemon/agent-process.js');

const mockEnv = {
  instanceId: 'test',
  ctxRoot: '/tmp/test-ctx',
  frameworkRoot: '/tmp/fw',
  agentName: 'alice',
  agentDir: '/tmp/fw/orgs/acme/agents/alice',
  org: 'acme',
  projectRoot: '/tmp/fw',
};

const ENV_PATH = '/tmp/fw/orgs/acme/agents/alice/.env';

/** Serve a given .env body at the agent's .env path; nothing else exists. */
function withAgentEnv(body: string | null) {
  fsMocks.existsSync.mockImplementation((p: string) => body !== null && String(p) === ENV_PATH);
  fsMocks.readFileSync.mockImplementation((p: string) => {
    if (String(p) === ENV_PATH && body !== null) return body;
    throw new Error(`unexpected read: ${p}`);
  });
}

/** buildStartupPrompt/buildContinuePrompt are private; reach them directly. */
function boot(ap: unknown): string {
  return (ap as { buildStartupPrompt(): string }).buildStartupPrompt();
}
function cont(ap: unknown): string {
  return (ap as { buildContinuePrompt(): string }).buildContinuePrompt();
}

/**
 * Assert the prompt does not ORDER a Telegram send.
 *
 * Deliberately matches the INVOCATION, not the bare token `send-telegram`: the
 * corrective instruction NAMES the command it forbids ("do NOT attempt
 * send-telegram"), so a bare-token assertion fails on the fix itself. Same trap
 * that made a `--collection` grep flag corrected prose as defective — a
 * defect-string match cannot distinguish a defect from a correction that names it.
 */
function expectNoTelegramOrder(prompt: string) {
  expect(prompt).not.toContain('bus send-telegram $CTX_TELEGRAM_CHAT_ID');
  expect(prompt).not.toContain('Send a Telegram message to the user');
}

const savedBotToken = process.env.BOT_TOKEN;

beforeEach(() => {
  fsMocks.existsSync.mockReset().mockReturnValue(false);
  fsMocks.readFileSync.mockReset();
  fsMocks.writeFileSync.mockReset();
  delete process.env.BOT_TOKEN;
});

afterEach(() => {
  if (savedBotToken === undefined) delete process.env.BOT_TOKEN;
  else process.env.BOT_TOKEN = savedBotToken;
});

describe('boot prompt — Telegram capability gating', () => {
  it('omits send-telegram when BOT_TOKEN is present but EMPTY (the bus-only shape)', () => {
    withAgentEnv('BOT_TOKEN=\nCHAT_ID=8772084625\nBUS_ONLY=true\n');
    const prompt = boot(new AgentProcess('alice', mockEnv, {}));
    expectNoTelegramOrder(prompt);
    expect(prompt).toContain('update-heartbeat');
  });

  it('instructs send-telegram when BOT_TOKEN has a value', () => {
    withAgentEnv('BOT_TOKEN=123456:AAEabcdef\nCHAT_ID=8772084625\n');
    const prompt = boot(new AgentProcess('alice', mockEnv, {}));
    expect(prompt).toContain('Telegram');
    expect(prompt).not.toContain('NO Telegram bot configured');
  });

  it('CHAT_ID alone is NOT a tell — it is set on every bus-only agent while BOT_TOKEN is empty', () => {
    // Regression guard for the tell that made this defect hard to spot. Measured across
    // all 15 agents: CHAT_ID is set to the SAME value on every one, bus-only or not, so it
    // has ZERO discriminating power — not merely a false positive.
    withAgentEnv('BOT_TOKEN=\nCHAT_ID=8772084625\n');
    const prompt = boot(new AgentProcess('alice', mockEnv, {}));
    expectNoTelegramOrder(prompt);
  });

  it('keys on BOT_TOKEN, not BUS_ONLY — a fresh add-agent has neither a token nor the marker', () => {
    // `cortextos add-agent` writes a literal `BOT_TOKEN=` and no BUS_ONLY field, so a
    // BUS_ONLY-based check would tell every newly-created agent to send Telegram it
    // cannot send. This is the case that makes the classification wrong, not just narrow.
    withAgentEnv('# Agent environment for alice\nBOT_TOKEN=\nCHAT_ID=\n');
    const prompt = boot(new AgentProcess('alice', mockEnv, {}));
    expectNoTelegramOrder(prompt);
    expect(prompt).toContain('update-heartbeat');
  });

  it('does NOT fall back to process.env.BOT_TOKEN when the agent .env has none (fixed 2026-08-25, task_1787663199029_25580749)', () => {
    // This class runs only inside the daemon's own shared Node process, so
    // process.env.BOT_TOKEN there is never THIS agent's token — it can only be a
    // different agent's real token that leaked in (e.g. via `pm2 restart
    // cortextos-daemon --update-env` run from inside another agent's shell).
    // A fallback here previously reported every agent, including bus-only ones,
    // as Telegram-capable the moment any one agent's token touched the daemon's
    // process env. The agent's own .env is always the complete signal.
    withAgentEnv(null);
    process.env.BOT_TOKEN = '123456:AAEabcdef';
    const prompt = boot(new AgentProcess('alice', mockEnv, {}));
    expect(prompt).toContain('NO Telegram bot configured');
  });

  it('treats a whitespace-only BOT_TOKEN as absent', () => {
    withAgentEnv('BOT_TOKEN=   \nCHAT_ID=1\n');
    const prompt = boot(new AgentProcess('alice', mockEnv, {}));
    expectNoTelegramOrder(prompt);
  });
});

describe('continue prompt — Telegram capability gating', () => {
  it('omits send-telegram on a --continue restart for a bus-only agent', () => {
    withAgentEnv('BOT_TOKEN=\nBUS_ONLY=true\n');
    const prompt = cont(new AgentProcess('alice', mockEnv, {}));
    expectNoTelegramOrder(prompt);
    expect(prompt).toContain('update-heartbeat');
  });

  it('still asks for Telegram on --continue when the agent has a token', () => {
    withAgentEnv('BOT_TOKEN=123456:AAEabcdef\n');
    const prompt = cont(new AgentProcess('alice', mockEnv, {}));
    expect(prompt).toContain('Telegram');
    expect(prompt).not.toContain('NO Telegram bot configured');
  });
});
