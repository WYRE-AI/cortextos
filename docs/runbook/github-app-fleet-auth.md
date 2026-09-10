# GitHub App fleet auth (WYRE Agent Fleet)

Replaces the shared `asachs01` personal PAT for fleet GitHub operations.
Least-privilege, per-installation scoped, no personal account in the loop.

## The App

- Name: **WYRE Agent Fleet** (slug `wyre-agent-fleet`, App id `4317194`), owned by `wyre-technology`.
- Permissions: `contents:write`, `pull_requests:write`, `actions:write`, `packages:write`, `checks:write`, `metadata:read`.
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

## What's still open (tracked separately)

- Step 3: per-agent git author identity + bus event-log attribution trail.
- Step 4: staged fleet cutover off `asachs01`, validating each agent after.

See task_1784224475661_91811410 (bus tracker) for status.
