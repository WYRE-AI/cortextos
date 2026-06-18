---
name: cortex-secrets
description: Use whenever you need a credential, API key, token, password, or any secret to do your work — calling an external/vendor API, authenticating a CLI, connecting to a database, etc. Retrieves secrets at runtime from the central Cortex/Wyre Infisical store via the `cortex-secret` CLI. ALWAYS use this instead of hardcoding a secret, asking the user to paste one, reading one from a committed file, or inventing a placeholder.
---

# Cortex Secrets

All shared credentials live in the central **Infisical** store (`secrets.wyretechnology.com`,
fronted by Cloudflare Access). You retrieve them at runtime with the **`cortex-secret`** CLI —
you never need the raw store URL, tokens, or headers; the per-context bootstrap config handles
auth for you.

## The rule

- **Need a secret? Fetch it with `cortex-secret`.** Never hardcode, never ask the user to paste
  a credential, never read secrets from source files, never log or echo a secret value.
- **Prefer injection over extraction.** Use `cortex-secret run -- <cmd>` so the secret lives only
  in the child process's environment — never written to disk, never in your transcript.

## Commands

```bash
cortex-secret list                  # list secret keys available to your context
cortex-secret get NAME              # print one secret's value (no trailing newline)
cortex-secret env                   # print `export NAME='VALUE'` lines for all secrets
cortex-secret run -- CMD [ARGS...]  # exec CMD with all secrets injected as env vars
```

Context is auto-selected from `$CORTEXTOS_CONTEXT` (default: `default`). Override with
`--context <ctx>` (e.g. `--context wyre-gateway`).

## Usage patterns

Run a tool that needs an env var (best — secret never leaves the child process):
```bash
cortex-secret run -- gh auth login --with-token   # if GH_TOKEN is in your secrets
cortex-secret run -- ./deploy.sh                  # deploy.sh reads $OPENAI_API_KEY etc.
```

Use one value inline (avoid storing it in a variable that might get logged):
```bash
curl -H "Authorization: Bearer $(cortex-secret get SOME_API_KEY)" https://api.example.com
```

Check what you have access to:
```bash
cortex-secret list
```

## What you can read

Your context reads its **own project plus `cortex-shared`** (common fleet-wide keys). Team
secrets are isolated — you cannot read another team's project. If `cortex-secret get NAME`
reports *not found*, the secret either doesn't exist yet or lives in a project you can't reach;
ask a human to add it (to `cortex-shared` if it should be fleet-wide).

## Fail closed — do not work around it

If `cortex-secret` errors (auth failure, network, missing config), **STOP and report it.**
Do **not** fall back to hardcoding, prompting the user for the secret, or using a placeholder.
A missing secret is a blocker to surface, not to route around.

## Adding / rotating secrets

Agents are **read-only**. Humans add or rotate secrets in the Infisical UI
(`https://secrets.wyretechnology.com`). Operational details (onboarding a team/host, rotation)
are in `docs/runbooks/cortex-secrets.md` in the `wyreOS` repo.
