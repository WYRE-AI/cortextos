// tests/unit/account-preflight.test.ts
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../src/bus/oauth.js', () => ({ resolveClaudeBinary: vi.fn(() => '/opt/homebrew/bin/claude') }));
vi.mock('child_process', () => ({ execFile: vi.fn((_bin, _args, _opts, cb) => cb(null, 'ok', '')) }));

import { execFile } from 'child_process';
import { classifyPreflightOutput, preflightAccount } from '../../src/daemon/account-preflight.js';
import { resolveClaudeBinary } from '../../src/bus/oauth.js';

describe('classifyPreflightOutput', () => {
  it('exit 0 → ok', () => {
    expect(classifyPreflightOutput(0, 'ok')).toBe('ok');
  });
  it('limit text → limit regardless of exit code', () => {
    expect(classifyPreflightOutput(1, "You've hit your weekly limit · resets Jul 20 at 2am (America/New_York)")).toBe('limit');
  });
  it('other nonzero → error', () => {
    expect(classifyPreflightOutput(1, 'network unreachable')).toBe('error');
  });
});

describe('preflightAccount — PATH-hardened binary resolution (PR #54 review, F1)', () => {
  it('invokes execFile with resolveClaudeBinary()\'s result, never the bare "claude" command name', async () => {
    await preflightAccount('fake-token');

    expect(resolveClaudeBinary).toHaveBeenCalled();
    expect(execFile).toHaveBeenCalledWith(
      '/opt/homebrew/bin/claude',
      expect.arrayContaining(['-p', 'reply with exactly: ok']),
      expect.any(Object),
      expect.any(Function),
    );
    // The bare command name must never be the first arg — that's exactly the
    // ENOENT-under-PM2-PATH failure mode F1 fixes.
    expect(execFile).not.toHaveBeenCalledWith('claude', expect.anything(), expect.anything(), expect.anything());
  });
});
