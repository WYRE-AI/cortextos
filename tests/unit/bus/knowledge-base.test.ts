import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Path-aware fs mocks. existsSync is the one we actually drive per-test:
// it returns true for any path EXCEPT the MMRAG_CONFIG one (when the test
// wants to simulate a missing config) so loadSecretsEnv and other path
// lookups still work normally inside the module under test.
const fsMocks = {
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  mkdirSync: vi.fn(),
};

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    existsSync: (...args: Parameters<typeof fsMocks.existsSync>) => fsMocks.existsSync(...args),
    readFileSync: (...args: Parameters<typeof fsMocks.readFileSync>) => fsMocks.readFileSync(...args),
    mkdirSync: (...args: Parameters<typeof fsMocks.mkdirSync>) => fsMocks.mkdirSync(...args),
  };
});

// Mock execFileSync so we can assert whether it was called (and optionally
// simulate a successful python response).
const execFileSyncMock = vi.fn();
vi.mock('child_process', async () => {
  const actual = await vi.importActual<typeof import('child_process')>('child_process');
  return {
    ...actual,
    execFileSync: (...args: unknown[]) => execFileSyncMock(...args),
  };
});

// Mock normalizeOrgName to a passthrough identity — we are not testing org
// normalization here, that has its own dedicated test file.
vi.mock('../../../src/utils/org.js', () => ({
  normalizeOrgName: (_root: string, org: string) => org,
}));

const { queryKnowledgeBase, ingestKnowledgeBase, deleteFromKnowledgeBase } = await import('../../../src/bus/knowledge-base.js');

// Minimal BusPaths stub — knowledge-base.ts doesn't actually USE the paths
// object at call time, just the options/env it constructs.
const dummyPaths = {
  stateDir: '/tmp/agent/state',
  logDir: '/tmp/agent/logs',
  ctxRoot: '/tmp/agent',
  instanceId: 'test',
  agentName: 'tester',
  org: 'TestOrg',
  inboxDir: '/tmp/agent/inbox',
  inflightDir: '/tmp/agent/inflight',
  processedDir: '/tmp/agent/processed',
  outboxDir: '/tmp/agent/outbox',
} as any;

const baseOptions = {
  org: 'TestOrg',
  agent: 'tester',
  frameworkRoot: '/home/test/cortextOS',
  instanceId: 'test',
};

let warnLog: string[] = [];
let originalWarn: typeof console.warn;
let logLog: string[] = [];
let originalLog: typeof console.log;

beforeEach(() => {
  fsMocks.existsSync.mockReset();
  fsMocks.readFileSync.mockReset().mockReturnValue('');
  fsMocks.mkdirSync.mockReset();
  execFileSyncMock.mockReset();

  warnLog = [];
  logLog = [];
  originalWarn = console.warn;
  originalLog = console.log;
  console.warn = (...args: unknown[]) => {
    warnLog.push(args.map((a) => String(a)).join(' '));
  };
  console.log = (...args: unknown[]) => {
    logLog.push(args.map((a) => String(a)).join(' '));
  };
});

afterEach(() => {
  console.warn = originalWarn;
  console.log = originalLog;
});

/**
 * Helper: make existsSync return false ONLY for paths that end with
 * knowledge-base/config.json (i.e. the MMRAG_CONFIG file), true for everything
 * else. Simulates a freshly-created agent with no KB configured yet.
 */
function mockMissingKbConfig(): void {
  fsMocks.existsSync.mockImplementation((p: any) => {
    const path = String(p);
    if (path.endsWith('/knowledge-base/config.json')) return false;
    return true;
  });
}

/**
 * Helper: make existsSync return true for everything, simulating a fully
 * configured KB with config.json present on disk.
 */
function mockConfiguredKb(): void {
  fsMocks.existsSync.mockImplementation(() => true);
}

describe('ingestKnowledgeBase — graceful missing-config', () => {
  it('missing config: warn + return cleanly, execFileSync NEVER called', () => {
    mockMissingKbConfig();

    // Must NOT throw. Previously this path threw an unhandled execFileSync
    // error that dumped a Node stack trace on top of the python stderr.
    expect(() =>
      ingestKnowledgeBase(['/some/file.md'], baseOptions),
    ).not.toThrow();

    expect(execFileSyncMock).not.toHaveBeenCalled();
    // Warn must include the org name AND an actionable hint ("run setup").
    expect(warnLog.some((m) => m.includes('TestOrg') && /run setup/i.test(m))).toBe(true);
    // Warn must carry the [kb] prefix so operators can filter log lines.
    expect(warnLog.some((m) => m.includes('[kb]'))).toBe(true);
  });

  it('config present: execFileSync IS called with the mmrag ingest args', () => {
    mockConfiguredKb();
    execFileSyncMock.mockReturnValue('');

    ingestKnowledgeBase(['/some/file.md'], baseOptions);

    expect(execFileSyncMock).toHaveBeenCalledTimes(1);
    // First positional arg is the python path, second is the argv array.
    const [pythonPath, argv] = execFileSyncMock.mock.calls[0] as [string, string[], object];
    expect(String(pythonPath)).toMatch(/python/);
    expect(argv).toEqual(expect.arrayContaining(['ingest', '/some/file.md']));
    // Happy path emits no [kb] warning.
    expect(warnLog.filter((m) => m.includes('[kb]'))).toHaveLength(0);
  });
});

describe('queryKnowledgeBase — graceful missing-config', () => {
  it('missing config: warn + return empty KBQueryResponse, execFileSync NEVER called', () => {
    mockMissingKbConfig();

    const result = queryKnowledgeBase(dummyPaths, 'what is cortextos?', baseOptions);

    expect(execFileSyncMock).not.toHaveBeenCalled();
    expect(result).toEqual({
      results: [],
      total: 0,
      query: 'what is cortextos?',
      collection: 'shared-TestOrg',
    });
    expect(warnLog.some((m) => m.includes('TestOrg') && /run setup/i.test(m))).toBe(true);
    expect(warnLog.some((m) => m.includes('[kb]'))).toBe(true);
  });

  it('config present: execFileSync IS called, happy-path query returns results', () => {
    mockConfiguredKb();
    // Mock mmrag.py --json output: a JSON blob with one result.
    execFileSyncMock.mockReturnValue(
      JSON.stringify({
        results: [
          { content: 'hit', similarity: 0.9, source: 'foo.md', type: 'markdown' },
        ],
      }),
    );

    const result = queryKnowledgeBase(dummyPaths, 'test query', baseOptions);

    expect(execFileSyncMock).toHaveBeenCalled();
    expect(result.total).toBeGreaterThan(0);
    expect(result.results[0].content).toBe('hit');
    // Happy path emits no [kb] warning.
    expect(warnLog.filter((m) => m.includes('[kb]'))).toHaveLength(0);
  });
});

describe('kb warn messages — UX invariants', () => {
  it('both warn messages name the org and suggest "run setup"', () => {
    // Drive ingest path
    mockMissingKbConfig();
    ingestKnowledgeBase(['/f.md'], { ...baseOptions, org: 'SpecificOrg' });
    // Drive query path
    mockMissingKbConfig();
    queryKnowledgeBase(dummyPaths, 'q', { ...baseOptions, org: 'SpecificOrg' });

    // At least one warn per call site, each containing the org name + hint
    const specificOrgWarns = warnLog.filter((m) => m.includes('SpecificOrg'));
    expect(specificOrgWarns.length).toBeGreaterThanOrEqual(2);
    expect(specificOrgWarns.every((m) => /run setup/i.test(m))).toBe(true);
  });
});

describe('deleteFromKnowledgeBase — no default scope (the pawl)', () => {
  it('THROWS when scope is omitted — must never silently pick a collection to empty', () => {
    mockConfiguredKb();
    // @ts-expect-error — deliberately omitting the required `scope` field to
    // prove the runtime guard fires even if a caller's types are loose.
    expect(() => deleteFromKnowledgeBase('/some/file.md', { ...baseOptions, scope: undefined }))
      .toThrow(/scope/i);
    expect(execFileSyncMock).not.toHaveBeenCalled();
  });

  it('THROWS on any scope value other than exactly "shared" or "private"', () => {
    mockConfiguredKb();
    expect(() =>
      // @ts-expect-error — invalid scope value on purpose
      deleteFromKnowledgeBase('/some/file.md', { ...baseOptions, scope: 'all' }),
    ).toThrow(/scope/i);
    expect(execFileSyncMock).not.toHaveBeenCalled();
  });

  it('scope=private with no agent throws (same rule ingest already enforces)', () => {
    mockConfiguredKb();
    expect(() =>
      deleteFromKnowledgeBase('/some/file.md', {
        org: 'TestOrg',
        frameworkRoot: baseOptions.frameworkRoot,
        instanceId: baseOptions.instanceId,
        scope: 'private',
      }),
    ).toThrow(/agent/i);
    expect(execFileSyncMock).not.toHaveBeenCalled();
  });
});

describe('deleteFromKnowledgeBase — happy path', () => {
  it('missing config: warn + return cleanly, execFileSync NEVER called', () => {
    mockMissingKbConfig();

    expect(() =>
      deleteFromKnowledgeBase('/some/file.md', { ...baseOptions, scope: 'private' }),
    ).not.toThrow();

    expect(execFileSyncMock).not.toHaveBeenCalled();
    expect(warnLog.some((m) => m.includes('TestOrg') && /run setup/i.test(m))).toBe(true);
    expect(warnLog.some((m) => m.includes('[kb]'))).toBe(true);
  });

  it('scope=private: calls mmrag delete against the agent-<agent> collection, no --force-style flag', () => {
    mockConfiguredKb();
    execFileSyncMock.mockReturnValue('');

    deleteFromKnowledgeBase('/some/file.md', { ...baseOptions, scope: 'private' });

    expect(execFileSyncMock).toHaveBeenCalledTimes(1);
    const [pythonPath, argv] = execFileSyncMock.mock.calls[0] as [string, string[], object];
    expect(String(pythonPath)).toMatch(/python/);
    expect(argv).toEqual(['/home/test/cortextOS/knowledge-base/scripts/mmrag.py', 'delete', '/some/file.md', '--collection', 'agent-tester']);
  });

  it('scope=shared: calls mmrag delete against the shared-<org> collection', () => {
    mockConfiguredKb();
    execFileSyncMock.mockReturnValue('');

    deleteFromKnowledgeBase('/some/file.md', { ...baseOptions, scope: 'shared' });

    const [, argv] = execFileSyncMock.mock.calls[0] as [string, string[], object];
    expect(argv).toContain('shared-TestOrg');
    expect(argv).not.toContain('agent-tester');
  });

  it('never exposes a raw --collection passthrough: the caller cannot name an arbitrary collection', () => {
    mockConfiguredKb();
    execFileSyncMock.mockReturnValue('');

    // deleteFromKnowledgeBase's options type has no `collection` field at
    // all — this call proves the only inputs that influence the collection
    // are org/agent/scope, exactly mirroring ingestKnowledgeBase.
    deleteFromKnowledgeBase('/some/file.md', { ...baseOptions, scope: 'private', agent: 'other-agent' });

    const [, argv] = execFileSyncMock.mock.calls[0] as [string, string[], object];
    expect(argv).toContain('agent-other-agent');
  });
});

describe('loadSecretsEnv merge — empty values never clobber non-empty ones', () => {
  /**
   * Helper: drive readFileSync per-path so the framework .env and the org
   * secrets.env return different contents. All other reads return ''.
   */
  function mockEnvFiles(dotenvContent: string, secretsContent: string): void {
    fsMocks.readFileSync.mockImplementation((p: any) => {
      const path = String(p);
      if (path.endsWith('/cortextOS/.env')) return dotenvContent;
      if (path.endsWith('/orgs/TestOrg/secrets.env')) return secretsContent;
      return '';
    });
  }

  /** Extract the env object passed to the mmrag execFileSync call. */
  function spawnedEnv(): Record<string, string> {
    const call = execFileSyncMock.mock.calls[0] as [string, string[], { env: Record<string, string> }];
    return call[2].env;
  }

  it('placeholder KEY= in org secrets.env does NOT wipe the framework .env value', () => {
    mockConfiguredKb();
    execFileSyncMock.mockReturnValue('');
    mockEnvFiles('GEMINI_API_KEY=real-framework-key\n', 'GEMINI_API_KEY=\n');

    ingestKnowledgeBase(['/some/file.md'], baseOptions);

    expect(spawnedEnv().GEMINI_API_KEY).toBe('real-framework-key');
  });

  it('non-empty org secrets.env value still overrides the framework .env value', () => {
    mockConfiguredKb();
    execFileSyncMock.mockReturnValue('');
    mockEnvFiles('GEMINI_API_KEY=real-framework-key\n', 'GEMINI_API_KEY=org-specific-key\n');

    ingestKnowledgeBase(['/some/file.md'], baseOptions);

    expect(spawnedEnv().GEMINI_API_KEY).toBe('org-specific-key');
  });

  it('an empty value with no earlier non-empty value is preserved as empty', () => {
    mockConfiguredKb();
    execFileSyncMock.mockReturnValue('');
    mockEnvFiles('', 'ONLY_IN_SECRETS=\n');

    ingestKnowledgeBase(['/some/file.md'], baseOptions);

    expect(spawnedEnv().ONLY_IN_SECRETS).toBe('');
  });
});
