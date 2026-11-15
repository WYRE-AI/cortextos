# WYRE cortextOS — SP1: Fork & Namespace Foundation

- **Status:** Draft for review
- **Date:** 2026-05-20
- **Author:** Aaron Sachs (with Claude)
- **Initiative:** Team-wide WYRE cortextOS (multi-spec — see Decomposition)

## Context

cortextOS runs persistent 24/7 Claude Code agents controlled from Telegram and
a web dashboard. WYRE currently runs a single-operator fork (`asachs01/cortextos`)
with one org, `orgs/wyre/`, holding 10 fully-specified agents.

The goal is a team-wide WYRE edition: a **hybrid topology** where shared org
agents (e.g. `boss`, `analyst`) coordinate the team, and each engineer also has
personal specialist agents — all running on **one central host**, with each
engineer's personal agents isolated in their own **namespace**. Because every
agent runs on a single filesystem, cortextOS's existing file bus works unchanged;
no networked transport is needed.

## Goal (SP1)

Establish the foundation: a WYRE-owned hard fork, a per-engineer namespace model,
and one-command engineer provisioning. After SP1, the repo structurally supports
shared + personal agents on one host, even though deployment, multi-user Telegram,
and onboarding land in later sub-projects.

## Decomposition (full initiative)

| # | Sub-project | Scope |
|---|---|---|
| **SP1** | **Fork & namespace foundation** | **This spec.** |
| SP2 | Central host & deployment | Host provisioning (Proxmox VM vs. Azure VM), PM2 ecosystem, dashboard, backups, secrets management. |
| SP3 | Multi-user Telegram & access | Team allowlists on shared agents; per-engineer bot/chat wiring; approval routing. |
| SP4 | Team onboarding & docs | New-engineer flow; integration into the WYRE AI Operating Manual. |

### Non-goals for SP1

- No host provisioning or deployment (SP2).
- No multi-user Telegram or approval-routing changes (SP3).
- No onboarding documentation beyond the fork's own README/CHANGELOG (SP4).
- No networked bus — the central-host topology makes it unnecessary.

## Architecture — the namespace model (Approach A)

Personal agents nest under the `wyre` org alongside the shared `agents/` dir:

```
orgs/wyre/
├── agents/                      # shared org agents: boss, analyst, ...
└── engineers/
    ├── aaron/agents/            # Aaron's personal specialists: dev, forge, ...
    └── jane/agents/             # Jane's personal specialists
```

- **Shared agents** keep their current location, `orgs/wyre/agents/<name>`.
- **Personal agents** live at `orgs/wyre/engineers/<engineer>/agents/<name>`.
- A personal agent's fully-qualified name is `<engineer>/<name>` (e.g. `aaron/dev`);
  shared agents remain bare (`boss`). The bus uses the qualified form for routing.

Approach A was chosen over one-org-per-engineer (would need cross-org bus
plumbing) and flat-with-prefixes (no real isolation) because it extends the
structure cortextOS already uses and keeps the file bus single-filesystem.

## Key technical finding — centralize path resolution first

Agent directory resolution — `join(orgsDir, org, 'agents', name)` — is **hardcoded
in roughly eight files**: `src/bus/agents.ts`, `src/bus/system.ts`, `src/bus/oauth.ts`,
`src/utils/env.ts`, `src/cli/get-config.ts`, `src/cli/ecosystem.ts`, `src/cli/setup.ts`,
`src/cli/bus.ts`. Several already carry a fallback to a top-level `agents/` dir.

Teaching every call site about `engineers/<name>/agents/` would scatter the namespace
logic and invite drift. Instead, SP1 **centralizes resolution first**, then adds
namespace awareness in exactly one place. This is the simplicity-first sequencing:
the refactor is mechanical and independently valuable; the feature becomes a
one-function change.

## Implementation outline

1. **Create the fork.** `gh repo fork`/create `WYRE-AI/cortextos` from
   `asachs01/cortextos`. Add `upstream` → `grandamenium/cortextos`. Document the
   cherry-pick sync process in `CONTRIBUTING.md`.

2. **Centralize agent path resolution.** Add `resolveAgentDir(org, qualifiedName)`
   and helpers to `src/utils/paths.ts`. The resolver understands both shared
   (`orgs/<org>/agents/<name>`) and namespaced
   (`orgs/<org>/engineers/<engineer>/agents/<name>`) layouts. Replace all ~8
   hardcoded joins with calls to it. No behavioural change yet — pure refactor,
   covered by existing tests.

3. **Add the namespace concept to types & discovery.** Extend agent identity in
   `src/types/index.ts` with an optional `engineer` field. Update `src/bus/agents.ts`
   discovery to enumerate `engineers/*/agents/*` in addition to `agents/*`. Bus
   addressing (`src/cli/bus.ts`, `src/bus/message.ts`) accepts qualified names.

4. **`add-engineer` CLI command.** New `src/cli/add-engineer.ts` (sibling to
   `add-agent.ts`): `cortextos add-engineer <name> --org wyre` scaffolds
   `orgs/wyre/engineers/<name>/` from a new `templates/engineer/` template
   (an `agents/` dir plus a namespace `config.json`). Register in `src/cli/index.ts`.

5. **`templates/engineer/`.** A minimal template: empty `agents/`, a namespace
   `config.json`, and a README explaining how to `add-agent` personal specialists
   into the namespace.

6. **Ecosystem generation.** Update `src/cli/ecosystem.ts` so PM2 process names
   for namespaced agents are qualified (`wyre-aaron-dev`) and never collide with
   shared agents or another engineer's.

7. **Migrate existing structure.** The current `orgs/wyre/agents/*` are the shared
   agents — they stay. If any are personal to Aaron, move them under
   `engineers/aaron/agents/` as part of this step (decided during implementation
   by reviewing each agent's role).

8. **Branding & hygiene.** WYRE branding in `README.md`; start `CHANGELOG.md`
   (Keep a Changelog 1.1.0); note the fork relationship and upstream-sync process.

## Testing strategy

- **Refactor (step 2):** existing unit/integration tests must pass unchanged —
  that is the proof the centralization is behaviour-preserving.
- **Namespace discovery (step 3):** new unit tests for `resolveAgentDir` covering
  shared, namespaced, and not-found cases; a discovery test with a fixture org
  containing both shared and namespaced agents.
- **`add-engineer` (step 4):** integration test — run the command against a temp
  org, assert the scaffold exists and a subsequent `add-agent` into the namespace
  succeeds.
- **Ecosystem (step 6):** unit test asserting qualified, collision-free PM2
  process names.
- TypeScript strict mode must compile cleanly; `npm run build` and `npm test` gate.

## Risks & open questions

- **Bus addressing surface area.** Qualified names may touch more of the bus than
  steps 2–3 identified. Mitigation: step 2's centralization surfaces every agent-path
  call site; treat any missed addressing spot as a step-3 follow-up.
- **Dashboard.** The Next.js dashboard reads agent lists; namespaced agents may
  not render correctly. SP1 ensures the API returns qualified names; full
  dashboard UX for namespaces is deferred to SP2.
- **Telegram identity.** Each namespaced agent still needs its own bot/chat env.
  SP1 scaffolds the `.env` slots; wiring real credentials and team allowlists is
  SP3.
- **Upstream divergence.** A hard fork means ongoing merge cost. Mitigation: keep
  WYRE changes surgical and well-isolated; `CONTRIBUTING.md` documents the
  cherry-pick cadence.

## Definition of done (SP1)

- `WYRE-AI/cortextos` exists with `upstream` configured and sync documented.
- Agent path resolution flows through one resolver; all hardcoded joins removed.
- `engineers/<name>/agents/` namespaces are discovered, addressable, and run under
  unique PM2 process names.
- `cortextos add-engineer <name>` scaffolds a namespace; `add-agent` can populate it.
- `npm run build` and `npm test` pass; new tests cover the resolver, discovery,
  and `add-engineer`.
- `README.md` branded, `CHANGELOG.md` started.
