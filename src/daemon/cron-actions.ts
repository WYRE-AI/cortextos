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
  conclusion: string | null;
}

/** Delay between dispatching and polling the run once for its conclusion.
 * The dispatch call (with `return_run_details`) returns the run id directly,
 * so this only gives a short run a chance to finish before we report on it.
 * 15s was verified live (task_1790952782650). */
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
 * dispatch the workflow (asking GitHub for the created run's id), wait
 * briefly, then fetch that exact run and report its conclusion.
 *
 * Throws on any failure (auth, dispatch rejected, run lookup failed, or the
 * run completed without succeeding); the caller (agent-manager.ts's onFire,
 * via cron-scheduler.ts's `fireWithRetry`) retries and logs it. Anything
 * that may have happened after GitHub accepted the dispatch (an ambiguous
 * POST outcome, or any post-dispatch lookup/result failure) throws
 * NonRetryableError instead, so a retry can never dispatch the workflow
 * twice for one cron fire.
 */
export async function runGithubWorkflowDispatch(
  action: GithubWorkflowDispatchAction,
  credentials: CronActionCredentials,
): Promise<CronActionResult> {
  const owner = action.repo.split('/')[0];
  const ref = action.ref ?? 'main';
  const label = `${action.repo}/${action.workflow}`;

  const { token } = await mintInstallationToken(credentials.appId, credentials.privateKey, owner);

  let dispatchRes: Response;
  try {
    dispatchRes = await githubApiRequest(
      token,
      `/repos/${action.repo}/actions/workflows/${action.workflow}/dispatches`,
      {
        method: 'POST',
        body: { ref, return_run_details: true, ...(action.inputs ? { inputs: action.inputs } : {}) },
      },
    );
  } catch (err) {
    // Transport failure: GitHub may have accepted the dispatch anyway.
    throw new NonRetryableError(
      `workflow_dispatch POST for ${label} failed with an unknown outcome: ` +
      `${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (dispatchRes.status !== 200) {
    const message = `workflow_dispatch POST for ${label} returned ${dispatchRes.status}: ${await dispatchRes.text()}`;
    // A 4xx is GitHub explicitly refusing the request, so retrying cannot
    // double-dispatch. A 5xx (or an unexpected 2xx/3xx) may have been
    // accepted server-side.
    if (dispatchRes.status >= 400 && dispatchRes.status < 500) throw new Error(message);
    throw new NonRetryableError(message);
  }

  let runId: number;
  try {
    const dispatchBody = await dispatchRes.json() as { workflow_run_id?: unknown };
    if (typeof dispatchBody.workflow_run_id !== 'number') throw new Error('response has no workflow_run_id');
    runId = dispatchBody.workflow_run_id;
  } catch (err) {
    throw new NonRetryableError(
      `workflow_dispatch POST for ${label} succeeded but its response could not be read: ` +
      `${err instanceof Error ? err.message : String(err)}`,
    );
  }

  await new Promise((resolve) => setTimeout(resolve, RUN_LOOKUP_DELAY_MS));

  let run: { id: number; html_url: string; status: string; conclusion: string | null };
  try {
    const runRes = await githubApiRequest(token, `/repos/${action.repo}/actions/runs/${runId}`);
    if (!runRes.ok) {
      throw new Error(`returned ${runRes.status}: ${await runRes.text()}`);
    }
    run = await runRes.json() as typeof run;
  } catch (err) {
    throw new NonRetryableError(
      `run lookup for dispatched run ${runId} of ${label} failed: ` +
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
