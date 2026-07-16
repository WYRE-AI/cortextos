// tests/unit/account-preflight.test.ts
import { describe, it, expect } from 'vitest';
import { classifyPreflightOutput } from '../../src/daemon/account-preflight.js';

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
