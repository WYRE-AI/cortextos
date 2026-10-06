# GitHub App fleet auth (WYRE Agent Fleet)

Replaces the shared `asachs01` personal PAT for fleet GitHub operations.
Least-privilege, per-installation scoped, no personal account in the loop.

## The App

- Name: **WYRE Agent Fleet** (slug `wyre-agent-fleet`, App id `4317194`), owned by `wyre-technology`.
- Permissions: `contents:write`, `pull_requests:write`, `actions:write`, `packages:write`, `checks:write`, `workflows:write`, `metadata:read`.
  Re-verified live 2026-09-20 via `GET /app` (see below) — this list was missing `workflows:write`, now corrected.
  **No `administration` permission at any scope (repo or org)** — this is load-bearing for the
  repo-creation gap two sections down (that gap needs repository-level `administration: write`
  specifically, see the correction there — not an organization-level permission).
- Credentials live in Infisical, **conduit** context: `GITHUB_APP_ID`, `GITHUB_APP_CLIENT_ID`, `GITHUB_APP_PRIVATE_KEY`.
  Fetch via `cortex-secret run --context conduit -- <cmd>` — never write the private key to disk.

## Installing the App on an org

A JWT signed with the App's own key authenticates as the App, but the App can only
act on orgs/repos it has been **installed** into by an org owner:

1. As an org owner, go to the App's public page and click **Install**
   (or Organization Settings → GitHub Apps → WYRE Agent Fleet → Configure).
2. Select the orgs/repos the fleet needs access to (all-repos, or an explicit list).
3. Confirm.

Each install produces its own `installation_id` — there is no fleet-wide id to
pre-provision; look it up per org after installing (see below).

## Validating the install

Mint an App JWT (RS256) and hit the GitHub API directly — no dependencies beyond
Node's built-in `crypto`:

```js
// gh-app-check.mjs
import crypto from 'node:crypto';
function b64url(s) { return Buffer.from(s).toString('base64').replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_'); }
const appId = process.env.GITHUB_APP_ID, key = process.env.GITHUB_APP_PRIVATE_KEY;
const now = Math.floor(Date.now()/1000);
const unsigned = `${b64url(JSON.stringify({alg:'RS256',typ:'JWT'}))}.${b64url(JSON.stringify({iat:now-60,exp:now+540,iss:appId}))}`;
const sig = crypto.createSign('RSA-SHA256').update(unsigned).sign(key).toString('base64').replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_');
const jwt = `${unsigned}.${sig}`;

const res = await fetch('https://api.github.com/app/installations', {
  headers: { Authorization: `Bearer ${jwt}`, Accept: 'application/vnd.github+json' },
});
console.log(await res.json()); // [] until at least one org has installed the App
```

Run with secrets injected only as env, never on disk:

```bash
cortex-secret run --context conduit -- node gh-app-check.mjs
```

Each entry in the response gives `account.login` (the org), `id` (the
`installation_id` — note this per org, there's no other place it's recorded),
`permissions`, and `repository_selection` (`all` or `selected`).

To confirm the App's own permission grant (not tied to any install), hit
`GET https://api.github.com/app` with the same JWT instead.

## Minting a token (Step 2 — done, this note was stale)

**Struck 2026-09-10 (maintainer, boss-directed) — Step 2 shipped and has been live since before the
2026-09-08/09-10 `asachs01` token-invalidation incidents; this doc simply never got updated.**
Verified live: `git grep -n "gh-app-token" -- src/cli/bus.ts` → `src/cli/bus.ts:3352`,
`.command('gh-app-token')`; `cortextos bus gh-app-token --help` responds. Carried the entire
2026-09-08/09 outage for forge, including write operations (merges, branch-protection PUTs).

```bash
GH_TOKEN=$(cortex-secret run --context conduit -- cortextos bus gh-app-token --org WYRE-AI) gh <cmd>
```

- Mints a ~1h installation access token, printed on stdout only (so the `$(...)` capture pattern
  above just works — `--force` is needed to print interactively, `--json` returns metadata without
  the token itself).
- `--org` defaults to `wyre-technology`; pass the actual org explicitly (e.g. `WYRE-AI`) — this
  is exactly the kind of namespace-pinning this fleet has been burned by skipping before.
- Identity is `wyre-agent-fleet[bot]`, not a human/agent's own name. Known limits: CodeRabbit
  ignores commands from the bot identity (re-triggers still need Aaron); no `Deployments:Read`
  permission on the App's current grant.

## Known gap: repo creation falls back to the deprecated PAT

**Found 2026-09-20 (forge)**: every wave-3 build agent creating a sidecar repo (Slide, Cork,
UniFi, CyberQP) silently fell back to the deprecated `GITHUB_PAT` (conduit context — the
`asachs01` personal token this whole App migration exists to retire) instead of using an App
installation token. Undocumented until now, and contradicted this doc's own stated purpose
("no personal account in the loop").

**Root cause, verified live 2026-09-20** (`GET /app` with the App's own JWT — see "Validating
the install" above): the App's permission grant has **zero `administration` permission at all**.
Creating a repo under an org (`POST /orgs/{org}/repos`) requires the App to hold `administration:
write` — but per GitHub's own permissions table, that's the **repository-level** `Administration`
permission (listed under "Repository permissions," not "Organization permissions"), not an
organization-level one. There is no separate, narrower permission that covers repo creation
specifically. **Correction (CodeRabbit, PR #198 review) to this doc's original claim:** we had
this backwards — it is repository-level `administration: write` that's needed, and that's
sufficient here specifically *because* this installation's `repository_selection` is `all`: a
repository-category permission granted to an "all repositories" install applies across the whole
org, including repos the installation didn't exist to see yet at grant time. Org-level
`administration` (org webhooks, custom properties, org-wide settings) is a different, broader
permission this use case does not need at all.

**Decision: expand the App's grant to include repository-level `administration: write`, rather
than continue leaning on the PAT.** Reasoning:
- The PAT is exactly the credential this system exists to eliminate. Leaving repo creation on it
  indefinitely is a standing regression against this doc's own design goal, and — worse — it was
  happening silently, which is a bigger risk than either option chosen deliberately.
- There is only **one installation** (`WYRE-AI`, `repository_selection: all`, verified live via
  `GET /app/installations`), so this is a single, bounded action: the App owner (Aaron) edits the
  App's permission manifest to add repository `administration: write`, then accepts the resulting
  permission-upgrade prompt for the one installation. Not a recurring credential to rotate or
  track, unlike a PAT.
- Named tradeoff, not hidden: repository-level `administration` is broader than "just repo
  creation" within each repo it applies to — it also covers branch protection, collaborators,
  per-repo webhooks, and Pages settings, across every repo the install can see (i.e. all of them,
  per `repository_selection: all`). The fleet doesn't use most of that today, but it's a materially
  smaller blast radius than the org-level grant this doc originally (incorrectly) called for, since
  it doesn't touch org membership, org-wide webhooks, or custom properties at all.
- Rejected alternative: provisioning a dedicated, narrowly-scoped fine-grained PAT under a
  non-personal bot account. Would be tighter in principle, but WYRE has no existing bot GitHub
  identity to hang it on, so it trades one small, well-understood App-grant click for setting up
  and then indefinitely rotating/tracking a whole new standing credential — worse on the exact
  axis (personal-credential elimination, credential sprawl) this migration is optimizing for.

**Action item**: this needs Aaron directly (App-owner permission edit + install-level accept) —
joins the existing click queue. Until it lands, wave-3 repo creation keeps using `GITHUB_PAT` —
that's now a documented, deliberate, temporary exception rather than a silent one. **Not yet
empirically re-verified against this specific App installation** (the original root-cause
investigation was live-verified 2026-09-20 per above, but this permission-scope correction is
sourced from GitHub's own documentation, not a fresh live test) — confirm the repository-level
grant actually clears the `GITHUB_PAT` fallback once Aaron applies it, before closing this out.

## What's still open (tracked separately)

- Step 3: per-agent git author identity + bus event-log attribution trail.
- Step 4: staged fleet cutover off `asachs01`, validating each agent after.

See task_1784224475661_91811410 (bus tracker) for status.
