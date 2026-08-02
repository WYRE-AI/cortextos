/**
 * Global vitest setup: delete ambient CTX_* env vars before any test file
 * loads.
 *
 * Root cause (task_1785590101969): when the whole suite is run from a LIVE
 * cortextos agent's own shell (as opposed to a clean CI runner), that shell
 * has real CTX_FRAMEWORK_ROOT / CTX_AGENT_DIR / CTX_PROJECT_ROOT / etc. set
 * in process.env. Individual test files that stub ONE of these (e.g.
 * bus-crons.test.ts sets CTX_FRAMEWORK_ROOT to a per-test tempdir to
 * exercise agentExistsInFramework()) assume the rest are simply absent, as
 * they are on a clean CI runner — they don't also clear CTX_AGENT_DIR /
 * CTX_PROJECT_ROOT. Left ambient, those genuinely diverge from the test's
 * synthetic CTX_FRAMEWORK_ROOT and trip src/utils/env.ts's real
 * sandbox/live-leak guard (issue #313) — a false positive from the guard's
 * point of view, since resolveEnv() has no way to know the divergence is a
 * test fixture rather than an actual leak. The same leak also flips
 * src/bus/hooks.ts's emitHookBusEvent() onto its CTX_FRAMEWORK_ROOT-set
 * execFile branch (execPath+cliPath prefix) when tests/unit/bus/hooks.test.ts
 * assumes the unset branch's argv shape — same root cause, different
 * manifestation (a shifted array index instead of a thrown error).
 *
 * This does not touch src/utils/env.ts's guard itself — it's a real,
 * correct production safety check and must stay exactly as strict. The fix
 * belongs on the test side: make the whole suite hermetic (matching a clean
 * CI runner) regardless of which shell happens to invoke it, so behavior
 * doesn't depend on whether that shell happens to be a live agent's own
 * session env.
 *
 * Swept by prefix rather than an explicit var list, so a future CTX_* var
 * (e.g. something added alongside a new hook) is covered automatically
 * instead of silently leaking through an outdated list.
 */
for (const key of Object.keys(process.env)) {
  if (key.startsWith('CTX_')) delete process.env[key];
}
