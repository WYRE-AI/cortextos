/**
 * cron-actions.ts — non-agent cron actions.
 *
 * Some crons need no model judgment at all: dispatch a GitHub Actions
 * workflow on a schedule GitHub's own `schedule:` trigger can't be trusted
 * for (task_1790882172065 — GH Actions' own schedule-dispatch is delayed
 * 2-8h, uniformly, account-wide; invisible on anything with more slack than
 * the delay, but it destroys a cadence shorter than the delay itself).
 *
 * Per the fleet's 2026-08-15 observer-principle lesson (a dispatcher that
 * needs no judgment shouldn't ride a model-backed session — it inherits
 * credit-exhaustion and session-failure modes for zero benefit), this runs
 * entirely in the daemon process. No agent PTY turn, no prompt injection.
 */

import { mintInstallationToken } from '../bus/github-app.js';
import type { CronAction, GithubWorkflowDispatchAction } from '../types/index.js';
import { NonRetryableError } from './cron-scheduler.js';

export type { CronAction, GithubWorkflowDispatchAction };

export interface CronActionCredentials {
  appId: string;
  privateKey: string;
}

export interface CronActionResult {
  run_id: number;
  run_url: string;
  /**
   * `null` means the run was still `in_progress` at the one poll this
   * function takes — NOT a failure or an unknown outcome, just "ask
   * `run_url` later if you want to know how it finished." This is a common,
   * expected result, not an edge case: the poll happens exactly once, 15s
   * after dispatch (see `RUN_LOOKUP_DELAY_MS`), and a live end-to-end test
   * during development (task_1790952782650) measured ~35s dispatch-to-
   * completion for a real workflow — i.e. for a workflow in that ballpark
   * or slower, `null` is the LIKELY outcome, not the exception. This
   * function's guarantee is "the dispatch was accepted and a run was
   * observed to start," not "confirmed success" — catching that GitHub's
   * own scheduler never fired the workflow at all is the whole point; the
   * workflow's own pass/fail is secondary and these production workflows
   * already have their own failure visibility. A single longer poll or a
   * retry-poll loop was deliberately not added, to keep this a bounded,
   * cheap, no-judgment daemon action rather than something that waits on
   * (and inherits the failure modes of) a long-running external job.
   */
  conclusion: string | null;
}

/** Delay between dispatching and looking up the resulting run. The REST
 * dispatch call returns 204 with no run identifier at all — verified live,
 * twice, against a real repo on 2026-10-02 (raw `gh api ... --include`:
 * `HTTP/2.0 204 No Content`, no `Location` header either, with and without
 * a `return_run_details` body field, which is not a real parameter this
 * endpoint recognizes). GitHub creates the run asynchronously, so a lookup
 * immediately after dispatch can race it; 15s was verified live
 * (task_1790952782650) as comfortably enough in practice. */
const RUN_LOOKUP_DELAY_MS = 15_000;

async function githubApiRequest(
  token: string,
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<Response> {
  return fetch(`https://api.github.com${path}`, {
    method: init.method ?? 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
}

/**
 * Runs one `github-workflow-dispatch` cron action end to end: mint a
 * GitHub App installation token scoped to the action's repo owner,
 * dispatch the workflow, wait briefly for GitHub to create the run, then
 * look it up (by listing the workflow's most recent `workflow_dispatch`
 * run — the dispatch response itself carries no run identifier) and
 * report its conclusion.
 *
 * Throws on any failure; the caller (agent-manager.ts's onFire, via
 * cron-scheduler.ts's `fireWithRetry`) retries and logs it. A clean 4xx on
 * the dispatch POST (GitHub explicitly refusing the request — bad ref,
 * workflow not found, etc.) throws a plain, retryable `Error`, since
 * nothing happened server-side. Everything else — a transport failure or
 * 5xx on the POST (ambiguous: GitHub may have accepted it anyway), the
 * post-dispatch run lookup failing, no run found, or the run completing
 * without succeeding — throws `NonRetryableError`, so a retry can never
 * dispatch the same workflow twice for one cron fire.
 */
export async function runGithubWorkflowDispatch(
  action: GithubWorkflowDispatchAction,
  credentials: CronActionCredentials,
): Promise<CronActionResult> {
  const owner = action.repo.split('/')[0];
  const ref = action.ref ?? 'main';
  const label = `${action.repo}/${action.workflow}`;

  const { token } = await mintInstallationToken(credentials.appId, credentials.privateKey, owner);

  // Lower bound for the post-dispatch run lookup, so a run created before
  // this dispatch can't be mistaken for it. The 5s margin absorbs clock skew
  // between this host and GitHub. Not filtered by branch: `ref` may be a tag.
  const createdAfter = new Date(Date.now() - 5_000).toISOString().replace(/\.\d{3}Z$/, 'Z');

  let dispatchRes: Response;
  try {
    dispatchRes = await githubApiRequest(
      token,
      `/repos/${action.repo}/actions/workflows/${action.workflow}/dispatches`,
      { method: 'POST', body: { ref, ...(action.inputs ? { inputs: action.inputs } : {}) } },
    );
  } catch (err) {
    // Transport failure: GitHub may have accepted the dispatch anyway.
    throw new NonRetryableError(
      `workflow_dispatch POST for ${label} failed with an unknown outcome: ` +
      `${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (dispatchRes.status !== 204) {
    // A 4xx is GitHub explicitly refusing the request, so retrying cannot
    // double-dispatch. A 5xx (or an unexpected 2xx/3xx) may have been
    // accepted server-side.
    const refused = dispatchRes.status >= 400 && dispatchRes.status < 500;
    let body: string;
    try {
      body = await dispatchRes.text();
    } catch (err) {
      body = `<response body unreadable: ${err instanceof Error ? err.message : String(err)}>`;
    }
    const message = `workflow_dispatch POST for ${label} returned ${dispatchRes.status}: ${body}`;
    if (refused) throw new Error(message);
    throw new NonRetryableError(message);
  }

  await new Promise((resolve) => setTimeout(resolve, RUN_LOOKUP_DELAY_MS));

  let run: { id: number; html_url: string; status: string; conclusion: string | null };
  try {
    const runsRes = await githubApiRequest(
      token,
      `/repos/${action.repo}/actions/workflows/${action.workflow}/runs` +
        `?event=workflow_dispatch&created=${encodeURIComponent(`>=${createdAfter}`)}&per_page=1`,
    );
    if (!runsRes.ok) {
      throw new Error(`returned ${runsRes.status}: ${await runsRes.text()}`);
    }
    const runsBody = await runsRes.json() as {
      workflow_runs: Array<{ id: number; html_url: string; status: string; conclusion: string | null }>;
    };
    const found = runsBody.workflow_runs[0];
    if (!found) {
      throw new Error(`no run appeared within ${RUN_LOOKUP_DELAY_MS}ms of dispatch`);
    }
    run = found;
  } catch (err) {
    // The dispatch itself already returned 204 (accepted), so any failure
    // from here on is ambiguous about whether the workflow actually ran —
    // never safe to retry.
    throw new NonRetryableError(
      `run lookup for ${label} failed after a successful dispatch: ` +
      `${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (run.status === 'completed' && run.conclusion !== 'success') {
    throw new NonRetryableError(`dispatched run ${run.html_url} concluded "${run.conclusion}"`);
  }

  return { run_id: run.id, run_url: run.html_url, conclusion: run.conclusion };
}

/**
 * Dispatches whichever cron action variant is given. A single entry point
 * so agent-manager.ts's onFire branch doesn't need to know about variants
 * as more are added — today there's exactly one.
 */
export async function runCronAction(
  action: CronAction,
  credentials: CronActionCredentials,
): Promise<CronActionResult> {
  switch (action.kind) {
    case 'github-workflow-dispatch':
      return runGithubWorkflowDispatch(action, credentials);
    default: {
      const exhaustive: never = action.kind;
      throw new Error(`Unknown cron action kind: ${exhaustive}`);
    }
  }
}
