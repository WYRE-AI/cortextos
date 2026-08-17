/**
 * Unit-test parity for the `cortextos restart <agent>` subcommand
 * (issue #328). Companion to lifecycle-markers.test.ts which already
 * covers writeStopMarker — restart re-uses that helper, so this file
 * pins the command-level wiring (name, required argument, --instance
 * option, description) instead of duplicating the marker-write tests.
 *
 * The second describe block covers the start-phase response handling:
 * a DEDUPED start is not a failure, and reporting it as one sent
 * operators chasing a healthy agent during an incident (2026-08-14).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks — restart.ts talks to the daemon over IPC and writes a stop marker.
// Both are stubbed so the command can be driven without a live daemon or disk.
// ---------------------------------------------------------------------------
const mockSend = vi.fn();
const mockIsDaemonRunning = vi.fn().mockResolvedValue(true);

vi.mock('../../../src/daemon/ipc-server.js', () => {
  class MockIPCClient {
    send = mockSend;
    isDaemonRunning = mockIsDaemonRunning;
  }
  return { IPCClient: MockIPCClient };
});

vi.mock('../../../src/cli/stop.js', () => ({ writeStopMarker: vi.fn() }));

import { restartCommand } from '../../../src/cli/restart';

describe('issue #328: cortextos restart <agent>', () => {
  it('is registered as `restart`', () => {
    expect(restartCommand.name()).toBe('restart');
  });

  it('requires the <agent> positional argument', () => {
    // commander stores arg metadata on _args / registeredArguments depending on
    // version; both expose .required on the registered argument.
    const args = (restartCommand as unknown as { registeredArguments: { required: boolean; name: () => string }[] }).registeredArguments;
    expect(args).toHaveLength(1);
    expect(args[0].required).toBe(true);
    expect(args[0].name()).toBe('agent');
  });

  it('accepts --instance with a default of "default"', () => {
    const opts = restartCommand.opts();
    expect(opts.instance).toBe('default');
  });

  it('describes itself as a stop+start (not a daemon restart)', () => {
    // The description must make clear this does NOT bounce the daemon —
    // operator-facing UX guard so users don't reach for this when they
    // actually need `pm2 restart cortextos-daemon`.
    const desc = restartCommand.description().toLowerCase();
    expect(desc).toContain('stop');
    expect(desc).toContain('start');
    expect(desc).toContain('daemon');
  });
});

describe('restart start-phase response handling', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    mockSend.mockReset();
    mockIsDaemonRunning.mockResolvedValue(true);
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`__PROCESS_EXIT_${code}__`);
    }) as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const out = () => logSpy.mock.calls.map((c) => String(c[0])).join('\n');
  const errOut = () => errSpy.mock.calls.map((c) => String(c[0])).join('\n');

  /** stop succeeds; start resolves to whatever the test supplies. */
  function wireResponses(startResponse: Record<string, unknown>) {
    mockSend
      .mockResolvedValueOnce({ success: true, data: 'Stopping alice' })
      .mockResolvedValueOnce(startResponse);
  }

  it('treats a DEDUPED start as success, not "agent is now stopped"', async () => {
    wireResponses({
      success: false,
      code: 'DEDUPED',
      error: 'start request for "alice" deduped — agent already in registry (in-flight start or already running)',
    });

    await restartCommand.parseAsync(['node', 'restart', 'alice']);

    expect(exitSpy).not.toHaveBeenCalled();
    expect(out()).toContain('starting or already running');
    // The misleading line must not appear — it sent operators chasing a
    // healthy agent, and the suggested `cortextos start` then errors too.
    expect(errOut()).not.toContain('Agent is now stopped');
  });

  it('still reports a genuine start failure and exits non-zero', async () => {
    wireResponses({
      success: false,
      code: 'NOT_FOUND',
      error: 'agent "alice" not in registry — cannot start',
    });

    await expect(
      restartCommand.parseAsync(['node', 'restart', 'alice']),
    ).rejects.toThrow('__PROCESS_EXIT_1__');

    expect(errOut()).toContain('Start failed');
    expect(errOut()).toContain('Agent is now stopped');
  });

  it('reports a successful start normally', async () => {
    wireResponses({ success: true, data: 'Starting alice' });

    await restartCommand.parseAsync(['node', 'restart', 'alice']);

    expect(exitSpy).not.toHaveBeenCalled();
    expect(out()).toContain('Starting alice');
  });
});
