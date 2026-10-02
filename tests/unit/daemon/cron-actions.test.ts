import { describe, it, expect, vi, beforeEach } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

const { runGithubWorkflowDispatch, runCronAction } = await import('../../../src/daemon/cron-actions.js');
const { NonRetryableError } = await import('../../../src/daemon/cron-scheduler.js');

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const TEST_KEY = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();
const CREDENTIALS = { appId: '4317194', privateKey: TEST_KEY };

function jsonResponse(body: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => body, text: async () => JSON.stringify(body) };
}

function emptyResponse(status: number, body = '') {
  return { ok: status >= 200 && status < 300, status, json: async () => ({}), text: async () => body };
}

/**
 * GitHub's real `workflow_dispatch` response: 204 No Content, no body, no
 * run identifier of any kind — verified live against a real repo (twice:
 * with and without a speculative `return_run_details` body field, which is
 * not a real parameter this endpoint recognizes). There is no way to
 * correlate the created run except by listing runs afterward.
 */
function dispatchAccepted() {
  return emptyResponse(204);
}

function runsListResponse(run: { id: number; html_url: string; status: string; conclusion: string | null } | null) {
  return jsonResponse({ workflow_runs: run ? [run] : [] });
}

/** The two calls mintInstallationToken itself makes, in order. */
function mockTokenMint() {
  mockFetch
    .mockResolvedValueOnce(jsonResponse([{ id: 147038752, account: { login: 'wyre-ai' }, repository_selection: 'all' }]))
    .mockResolvedValueOnce(jsonResponse({ token: 'ghs_minted123', expires_at: '2026-10-02T23:00:00Z' }));
}

beforeEach(() => {
  mockFetch.mockReset();
  vi.useFakeTimers();
});

describe('runGithubWorkflowDispatch', () => {
  it('mints a token, dispatches, waits, then reports the resulting run on success', async () => {
    mockTokenMint();
    mockFetch.mockResolvedValueOnce(dispatchAccepted());
    mockFetch.mockResolvedValueOnce(runsListResponse({
      id: 999, html_url: 'https://github.com/WYRE-AI/conduit/actions/runs/999', status: 'completed', conclusion: 'success',
    }));

    const promise = runGithubWorkflowDispatch(
      { kind: 'github-workflow-dispatch', repo: 'WYRE-AI/conduit', workflow: 'signup-smoke.yml' },
      CREDENTIALS,
    );
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result).toEqual({ run_id: 999, run_url: 'https://github.com/WYRE-AI/conduit/actions/runs/999', conclusion: 'success' });

    // Dispatch call (3rd fetch overall, after the 2 token-mint calls)
    const [dispatchUrl, dispatchInit] = mockFetch.mock.calls[2];
    expect(dispatchUrl).toBe('https://api.github.com/repos/WYRE-AI/conduit/actions/workflows/signup-smoke.yml/dispatches');
    expect(dispatchInit.method).toBe('POST');
    expect(JSON.parse(dispatchInit.body)).toEqual({ ref: 'main' });
    expect(dispatchInit.headers.Authorization).toBe('Bearer ghs_minted123');

    // No run id comes back from the dispatch itself — the follow-up lists
    // the workflow's runs filtered to workflow_dispatch events.
    expect(mockFetch.mock.calls[3][0]).toBe(
      'https://api.github.com/repos/WYRE-AI/conduit/actions/workflows/signup-smoke.yml/runs?event=workflow_dispatch&per_page=1',
    );
  });

  it('passes a custom ref and inputs through to the dispatch body', async () => {
    mockTokenMint();
    mockFetch.mockResolvedValueOnce(dispatchAccepted());
    mockFetch.mockResolvedValueOnce(runsListResponse({ id: 1, html_url: 'https://x/1', status: 'completed', conclusion: 'success' }));

    const promise = runGithubWorkflowDispatch(
      {
        kind: 'github-workflow-dispatch',
        repo: 'WYRE-AI/conduit',
        workflow: 'mcp-live-probe.yml',
        ref: 'release',
        inputs: { gateway: 'staging' },
      },
      CREDENTIALS,
    );
    await vi.runAllTimersAsync();
    await promise;

    const [, dispatchInit] = mockFetch.mock.calls[2];
    expect(JSON.parse(dispatchInit.body)).toEqual({ ref: 'release', inputs: { gateway: 'staging' } });
  });

  it('throws a plain retryable error when the dispatch POST is explicitly refused (4xx)', async () => {
    mockTokenMint();
    mockFetch.mockResolvedValueOnce(emptyResponse(404, 'Not Found'));

    const promise = runGithubWorkflowDispatch(
      { kind: 'github-workflow-dispatch', repo: 'WYRE-AI/conduit', workflow: 'nonexistent.yml' },
      CREDENTIALS,
    );
    await expect(promise).rejects.toThrow(/returned 404/);
    // GitHub explicitly refused before anything happened: safe to retry.
    await expect(promise).rejects.not.toBeInstanceOf(NonRetryableError);
  });

  it('throws NonRetryableError when the dispatch POST outcome is ambiguous (5xx)', async () => {
    mockTokenMint();
    mockFetch.mockResolvedValueOnce(emptyResponse(502, 'Bad Gateway'));

    const promise = runGithubWorkflowDispatch(
      { kind: 'github-workflow-dispatch', repo: 'WYRE-AI/conduit', workflow: 'signup-smoke.yml' },
      CREDENTIALS,
    );
    await expect(promise).rejects.toBeInstanceOf(NonRetryableError);
  });

  it('throws NonRetryableError when the dispatch POST fails in transport', async () => {
    mockTokenMint();
    mockFetch.mockRejectedValueOnce(new Error('socket hang up'));

    const promise = runGithubWorkflowDispatch(
      { kind: 'github-workflow-dispatch', repo: 'WYRE-AI/conduit', workflow: 'signup-smoke.yml' },
      CREDENTIALS,
    );
    await expect(promise).rejects.toBeInstanceOf(NonRetryableError);
  });

  it('throws NonRetryableError when no run appears after an accepted dispatch', async () => {
    mockTokenMint();
    mockFetch.mockResolvedValueOnce(dispatchAccepted());
    mockFetch.mockResolvedValueOnce(runsListResponse(null));

    const promise = runGithubWorkflowDispatch(
      { kind: 'github-workflow-dispatch', repo: 'WYRE-AI/conduit', workflow: 'signup-smoke.yml' },
      CREDENTIALS,
    );
    // Attach the rejection assertion BEFORE advancing fake timers -- otherwise
    // the promise can reject while runAllTimersAsync() is still in flight,
    // before anything is listening, producing an unhandled-rejection warning
    // even though the test itself passes.
    const assertion = expect(promise).rejects.toBeInstanceOf(NonRetryableError);
    await vi.runAllTimersAsync();
    await assertion;
    await expect(promise).rejects.toThrow(/no run appeared/);
  });

  it('throws NonRetryableError when the run lookup itself fails after an accepted dispatch', async () => {
    mockTokenMint();
    mockFetch.mockResolvedValueOnce(dispatchAccepted());
    mockFetch.mockResolvedValueOnce(emptyResponse(500, 'Internal Server Error'));

    const promise = runGithubWorkflowDispatch(
      { kind: 'github-workflow-dispatch', repo: 'WYRE-AI/conduit', workflow: 'signup-smoke.yml' },
      CREDENTIALS,
    );
    const assertion = expect(promise).rejects.toBeInstanceOf(NonRetryableError);
    await vi.runAllTimersAsync();
    await assertion;
    await expect(promise).rejects.toThrow(/run lookup for WYRE-AI\/conduit\/signup-smoke.yml failed/);
  });

  it('throws NonRetryableError when the dispatched run completes without succeeding', async () => {
    mockTokenMint();
    mockFetch.mockResolvedValueOnce(dispatchAccepted());
    mockFetch.mockResolvedValueOnce(runsListResponse({ id: 2, html_url: 'https://x/2', status: 'completed', conclusion: 'failure' }));

    const promise = runGithubWorkflowDispatch(
      { kind: 'github-workflow-dispatch', repo: 'WYRE-AI/conduit', workflow: 'signup-smoke.yml' },
      CREDENTIALS,
    );
    const assertion = expect(promise).rejects.toThrow(/concluded "failure"/);
    await vi.runAllTimersAsync();
    await assertion;
    await expect(promise).rejects.toBeInstanceOf(NonRetryableError);
  });

  it('does not throw when the run is still in_progress (not yet completed)', async () => {
    mockTokenMint();
    mockFetch.mockResolvedValueOnce(dispatchAccepted());
    mockFetch.mockResolvedValueOnce(runsListResponse({ id: 3, html_url: 'https://x/3', status: 'in_progress', conclusion: null }));

    const promise = runGithubWorkflowDispatch(
      { kind: 'github-workflow-dispatch', repo: 'WYRE-AI/conduit', workflow: 'signup-smoke.yml' },
      CREDENTIALS,
    );
    await vi.runAllTimersAsync();
    await expect(promise).resolves.toEqual({ run_id: 3, run_url: 'https://x/3', conclusion: null });
  });
});

describe('runCronAction', () => {
  it('dispatches github-workflow-dispatch actions through runGithubWorkflowDispatch', async () => {
    mockTokenMint();
    mockFetch.mockResolvedValueOnce(dispatchAccepted());
    mockFetch.mockResolvedValueOnce(runsListResponse({ id: 4, html_url: 'https://x/4', status: 'completed', conclusion: 'success' }));

    const promise = runCronAction(
      { kind: 'github-workflow-dispatch', repo: 'WYRE-AI/conduit', workflow: 'error-triage.yml' },
      CREDENTIALS,
    );
    await vi.runAllTimersAsync();
    await expect(promise).resolves.toEqual({ run_id: 4, run_url: 'https://x/4', conclusion: 'success' });
  });
});
