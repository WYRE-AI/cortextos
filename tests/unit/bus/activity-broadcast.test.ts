import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock the fleet enumerator so tests control exactly who exists, and the
// message sender so no inbox files are written. Everything else is real.
const discoverMock = vi.fn();
vi.mock('../../../src/utils/agent-dir.js', async () => {
  const actual = await vi.importActual<typeof import('../../../src/utils/agent-dir.js')>(
    '../../../src/utils/agent-dir.js',
  );
  return {
    ...actual,
    discoverAllAgents: (...args: Parameters<typeof discoverMock>) => discoverMock(...args),
  };
});

const sendMessageMock = vi.fn();
vi.mock('../../../src/bus/message.js', async () => {
  const actual = await vi.importActual<typeof import('../../../src/bus/message.js')>(
    '../../../src/bus/message.js',
  );
  return {
    ...actual,
    sendMessage: (...args: Parameters<typeof sendMessageMock>) => sendMessageMock(...args),
  };
});

const { broadcastActivityViaBus } = await import('../../../src/bus/system.js');

beforeEach(() => {
  discoverMock.mockReset();
  sendMessageMock.mockReset();
});

describe('broadcastActivityViaBus — bus-native activity fallback', () => {
  it('fans out to enabled same-org agents, excluding the sender, disabled agents, and other orgs', () => {
    discoverMock.mockReturnValue([
      { name: 'boss', org: 'wyre', enabled: true },
      { name: 'murph', org: 'wyre', enabled: true },
      { name: 'infra', org: 'wyre', enabled: true },      // sender — excluded
      { name: 'lantern', org: 'wyre', enabled: false },   // disabled — excluded
      { name: 'zed', org: 'acme', enabled: true },        // other org — excluded
    ]);

    const result = broadcastActivityViaBus('/fw', '/ctx', 'default', 'wyre', 'infra', 'hello fleet');

    expect(result.delivered).toEqual(['boss', 'murph']);
    expect(result.skipped).toEqual([]);
    expect(sendMessageMock).toHaveBeenCalledTimes(2);
    const recipients = sendMessageMock.mock.calls.map((c) => c[2]);
    expect(recipients).toEqual(['boss', 'murph']);
  });

  it('prefixes the message with [ACTIVITY] and sends at normal priority from the sender', () => {
    discoverMock.mockReturnValue([{ name: 'boss', org: 'wyre', enabled: true }]);

    broadcastActivityViaBus('/fw', '/ctx', 'default', 'wyre', 'infra', 'deploy done');

    const [, from, to, priority, text] = sendMessageMock.mock.calls[0];
    expect(from).toBe('infra');
    expect(to).toBe('boss');
    expect(priority).toBe('normal');
    expect(text).toBe('[ACTIVITY] deploy done');
  });

  it('a throwing delivery lands in skipped without aborting the rest of the fan-out', () => {
    discoverMock.mockReturnValue([
      { name: 'boss', org: 'wyre', enabled: true },
      { name: 'broken', org: 'wyre', enabled: true },
      { name: 'murph', org: 'wyre', enabled: true },
    ]);
    sendMessageMock.mockImplementation((_paths: unknown, _from: string, to: string) => {
      if (to === 'broken') throw new Error('inbox unwritable');
      return 'msg-id';
    });

    const result = broadcastActivityViaBus('/fw', '/ctx', 'default', 'wyre', 'infra', 'x');

    expect(result.delivered).toEqual(['boss', 'murph']);
    expect(result.skipped).toEqual(['broken']);
  });

  it('empty fleet: returns empty delivered and skipped, sends nothing', () => {
    discoverMock.mockReturnValue([]);

    const result = broadcastActivityViaBus('/fw', '/ctx', 'default', 'wyre', 'infra', 'x');

    expect(result.delivered).toEqual([]);
    expect(result.skipped).toEqual([]);
    expect(sendMessageMock).not.toHaveBeenCalled();
  });
});
