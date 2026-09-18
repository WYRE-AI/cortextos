/**
 * Resolve the org orchestrator to notify, or null when there is nobody to
 * tell: CTX_ORCHESTRATOR_AGENT is unset (context.json missing/malformed),
 * or the orchestrator IS the agent asking (notifying yourself is a no-op,
 * not a bug).
 *
 * Shared by every "tell the orchestrator" call site — hook-loop-detector.ts's
 * notifyOrchestrator and approval.ts's notifyOrchestratorOfApproval both
 * used to carry this same two-line predicate independently, which is
 * exactly the shape this codebase's own history (CLAUDE.md 2026-08-04
 * cron-utils entry) flags as prone to silent drift: a future change to the
 * no-op condition in one copy going unnoticed in the other. One function
 * means the decision can only diverge in one place — each call site keeps
 * its own delivery mechanism (direct sendMessage vs. shelling out from a
 * hook process), since those are genuinely different and unifying them
 * would just be indirection.
 */
export function resolveOrchestratorTarget(agentName: string): string | null {
  const orchestrator = process.env.CTX_ORCHESTRATOR_AGENT;
  if (!orchestrator || orchestrator === agentName) return null;
  return orchestrator;
}
