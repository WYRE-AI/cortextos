# Held follow-ups — recommendations for Aaron's review (2026-07-29)

Two judgment calls from the 2026-07-27 context-engineering review were
deliberately **not executed**. Recommendation and reasoning for each; neither
touches code until you approve.

## 1. `hook-extract-facts`: wire it (recommended) vs delete it

**Current state.** `src/hooks/hook-extract-facts.ts` is a PreCompact hook that
captures each compaction summary into `state/<agent>/memory/facts/DATE.jsonl`
(8,000-char cap + ranked keywords). It is dead on the write side: no template
`settings.json` registers it (all three register only `hook-compact-telegram`
for PreCompact) and `src/cli/bus.ts` never exposes it as a hook subcommand.
Meanwhile the **read side is live and mandated**: `cortextos bus recall-facts`
exists and `templates/agent/AGENTS.md` makes it session-start step 7 — every
agent reads a directory the framework never writes.

**Recommendation: wire it.**
- It is the codebase's only automatic memory path, and "let Claude save
  memories automatically instead of manually curating" is exactly the
  direction the Claude 5 context-engineering guidance pushes; the manual
  3-layer protocol stays untouched either way.
- The loop was clearly *intended* to close: writer implemented and unit-tested
  (`tests/unit/hooks/extract-facts.test.ts`), reader shipped and mandated.
  Wiring completes existing design rather than adding new surface.
- Cost is small and mechanical: one `case` in bus.ts's hook dispatch + one
  entry appended to each template's PreCompact hooks array (hooks arrays
  already support multiple commands per event).
- Deleting instead would also require unwinding `recall-facts` and AGENTS.md
  step 7 across three templates plus community copies — more churn than
  wiring, for less value.

**Risk note:** template edits diverge from upstream and will echo-conflict at
the next sync — acceptable (they already conflict every sync), and the change
is upstreamable afterwards.

## 2. Template `CLAUDE.md` → `@AGENTS.md` wrapper: migrate, but as a careful two-step (recommended)

**Current state.** `templates/{agent,orchestrator,analyst}/CLAUDE.md` are
194–306-line standalone manuals that substantially duplicate AGENTS.md, while
the scaffolder (`src/cli/add-agent.ts:437`) and `dashboard/CLAUDE.md` already
use the one-line `@AGENTS.md` import. Two conventions, guaranteed drift, and
~8–11 KB of duplicated boot context per agent per session.

**Recommendation: collapse them — but not as a naive deletion.** The
orchestrator and analyst CLAUDE.md files carry role-specific sections
(coordination duties, version-control/publishing guidance) that are **not**
in their AGENTS.md; a straight collapse loses them. The safe migration per
template is:

1. Diff CLAUDE.md against AGENTS.md; move genuinely unique content into the
   template's AGENTS.md (where the role's manual already lives).
2. Replace CLAUDE.md with the one-line `@AGENTS.md` wrapper, matching what
   the scaffolder already writes.
3. Mirror the same change into the `community/agents/*` copies.

Two caveats worth deciding with eyes open:
- **Deployed agents don't change retroactively** — templates are copied at
  scaffold time, so the live fleet keeps its fat CLAUDE.md files until
  re-provisioned or hand-touched. This only fixes new agents (and drift).
- **Upstream ships the same fat files**, so this diverges the templates
  further. Since they echo-conflict on every sync anyway and the change
  compresses cleanly ("ours = wrapper"), the merge cost is low; offering it
  upstream as a PR after it bakes on the fork would eliminate it entirely.
