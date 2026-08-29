import { describe, it, expect } from 'vitest';
import { homedir } from 'os';
import { join } from 'path';
import { resolvePaths } from '../src/utils/paths.js';

describe('resolvePaths CTX_ROOT override', () => {
  it('uses the provided ctxRoot when given', () => {
    const customRoot = '/tmp/some-other-ctx-root';
    const paths = resolvePaths('myagent', 'default', 'myorg', customRoot);

    expect(paths.ctxRoot).toBe(customRoot);
    expect(paths.inbox).toBe(join(customRoot, 'inbox', 'myagent'));
    expect(paths.stateDir).toBe(join(customRoot, 'state', 'myagent'));
    expect(paths.taskDir).toBe(join(customRoot, 'orgs', 'myorg', 'tasks'));
  });

  it('falls back to homedir-based default when ctxRoot is omitted', () => {
    const paths = resolvePaths('myagent', 'default', 'myorg');
    const expectedRoot = join(homedir(), '.cortextos', 'default');

    expect(paths.ctxRoot).toBe(expectedRoot);
  });

  it('falls back to homedir-based default when ctxRoot is explicitly undefined', () => {
    const paths = resolvePaths('myagent', 'default', 'myorg', undefined);
    const expectedRoot = join(homedir(), '.cortextos', 'default');

    expect(paths.ctxRoot).toBe(expectedRoot);
  });

  it('ignores instanceId for path construction when a ctxRoot override is given', () => {
    // instanceId is still validated, but should not leak into the resulting
    // paths once a caller has already resolved a real ctxRoot for it.
    const customRoot = '/tmp/instance-b-root';
    const paths = resolvePaths('myagent', 'instance-b', undefined, customRoot);

    expect(paths.ctxRoot).toBe(customRoot);
    expect(paths.inbox).toBe(join(customRoot, 'inbox', 'myagent'));
  });
});
