/**
 * Next.js startup hook — boots the file watcher when the SERVER starts.
 *
 * Before this existed, `initWatcher()` had exactly one caller: the SSE route
 * (`src/app/api/events/stream/route.ts`). Under `next start` no route module
 * loads until it is requested, so the dashboard began ingesting only once a
 * browser opened it and subscribed to the event stream — and (with the
 * singleton bug in `lib/watcher.ts`) stopped again when that connection closed.
 *
 * The consequence is the part worth remembering: EVERY HISTORICAL GAP IN THE
 * DASHBOARD DB IS AN UNOBSERVED-PERIOD ARTEFACT RATHER THAN A QUIET SPELL, so
 * the dashboard could not be evidence about anything that happened while nobody
 * was looking — which is exactly when monitoring is wanted. Measured instance:
 * 37 hours frozen while the process was online, serving, and green.
 *
 * Ingestion must not depend on being observed, so it starts here.
 */
export async function register(): Promise<void> {
  // Only the Node.js server runtime can watch the filesystem; the edge runtime
  // imports this file too and must be a no-op there.
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;

  try {
    const { initWatcher } = await import('./src/lib/watcher');
    initWatcher();
    console.log('[instrumentation] watcher booted at server start');
  } catch (err) {
    // Never block server startup on the watcher — a dashboard that serves
    // stale data is better than one that will not boot. The failure is logged
    // rather than swallowed, because a silent miss here reproduces the exact
    // bug this file exists to fix.
    console.error('[instrumentation] failed to boot watcher:', err);
  }
}
