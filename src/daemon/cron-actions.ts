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

/** Delay between dispatching and looking up the resulting run. The REST
 * dispatch call itself returns 204 with no run identifier — GitHub creates
 * the run asynchronously, so a lookup immediately after dispatch can race
 * it. 15s was verified live (task_1790952782650): dispatch-to-queryable in
 * practice took well under that during manual testing. */
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
 * look it up and report its conclusion.
 *
 * Throws on any failure (auth, dispatch rejected, no run found, or the run
 * completed without succeeding) — the caller (agent-manager.ts's onFire,
 * via cron-scheduler.ts's existing `fireWithRetry`) already retries and
 * logs a thrown error exactly as it would a failed PTY injection. This
 * function does not need its own retry logic.
 */
export async function runGithubWorkflowDispatch(
  action: GithubWorkflowDispatchAction,
  credentials: CronActionCredentials,
): Promise<CronActionResult> {
  const owner = action.repo.split('/')[0];
  const ref = action.ref ?? 'main';

  const { token } = await mintInstallationToken(credentials.appId, credentials.privateKey, owner);

  const dispatchRes = await githubApiRequest(
    token,
    `/repos/${action.repo}/actions/workflows/${action.workflow}/dispatches`,
    { method: 'POST', body: { ref, ...(action.inputs ? { inputs: action.inputs } : {}) } },
  );
  if (dispatchRes.status !== 204) {
    throw new Error(
      `workflow_dispatch POST for ${action.repo}/${action.workflow} returned ` +
      `${dispatchRes.status}: ${await dispatchRes.text()}`,
    );
  }

  await new Promise((resolve) => setTimeout(resolve, RUN_LOOKUP_DELAY_MS));

  const runsRes = await githubApiRequest(
    token,
    `/repos/${action.repo}/actions/workflows/${action.workflow}/runs?event=workflow_dispatch&per_page=1`,
  );
  if (!runsRes.ok) {
    throw new Error(
      `run lookup for ${action.repo}/${action.workflow} returned ${runsRes.status}: ${await runsRes.text()}`,
    );
  }
  const runsBody = await runsRes.json() as {
    workflow_runs: Array<{ id: number; html_url: string; status: string; conclusion: string | null }>;
  };
  const run = runsBody.workflow_runs[0];
  if (!run) {
    throw new Error(
      `workflow_dispatch POST succeeded for ${action.repo}/${action.workflow} but no run appeared ` +
      `within ${RUN_LOOKUP_DELAY_MS}ms of dispatch`,
    );
  }

  if (run.status === 'completed' && run.conclusion !== 'success') {
    throw new Error(`dispatched run ${run.html_url} concluded "${run.conclusion}"`);
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
