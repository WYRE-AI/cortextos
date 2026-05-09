# Coolify deployment — cortextOS dashboard

## What this gets you

A containerized Next.js dashboard running on your Coolify cluster with:
- Multi-stage build (~321MB final image)
- Non-root runtime user
- Built-in healthcheck on `/login`
- Persistent volume for the SQLite read cache and (eventually) bus state

## What this does NOT get you (yet)

The daemon still runs on your Mac. The dashboard's API routes shell out
to `cortextos bus` which talks to the daemon's local IPC socket at
`$CTX_ROOT/daemon.sock`. With the daemon on a different host, pages that
need live agent data (`/tasks`, `/workflows`, agent status, etc.) will
render the UI shell but show empty / error states for daemon-backed
calls. The login flow, static pages, and the SQLite-cached views work.

This is intentional — getting the deploy pipeline working before
migrating the daemon is the cheaper sequencing.

## Coolify setup

### 1. Source

Point Coolify at this repo (or your fork) on branch `wyre/pty-hardening`.
Set the **build context** and **Dockerfile location** to `dashboard/`.

### 2. Environment variables

Required:

| Variable | Value | Notes |
|---|---|---|
| `AUTH_SECRET` | `openssl rand -base64 32` | NextAuth session signing |
| `ADMIN_USERNAME` | `admin` | First-login username |
| `ADMIN_PASSWORD` | strong password | First-login password |
| `CTX_ROOT` | `/state` | Matches the volume mount below |
| `TRUST_PROXY` | `true` | Required behind Coolify's reverse proxy |
| `AUTH_URL` | `https://<your-domain>` | Public URL Coolify exposes |

Optional:

| Variable | Default | Purpose |
|---|---|---|
| `CTX_INSTANCE_ID` | `default` | Multi-instance separation |
| `CTX_FRAMEWORK_ROOT` | unset | Only meaningful when daemon is co-located |
| `PORT` | `3000` | Internal port — leave alone unless conflicting |

### 3. Persistent volume

Mount a Coolify-managed volume at `/state`. The dashboard writes:

- `/state/dashboard/cortextos-default.db` — SQLite read cache (WAL mode)
- `/state/dashboard/cortextos-default.db-wal`, `*-shm` — WAL companion files

When the daemon eventually moves to Coolify too, it will share this same
volume — its bus state lives at `/state/.cortextOS/state/`.

### 4. Port + domain

- Internal port: `3000`
- Coolify routes a public domain to it. Pick a subdomain on
  `wyretechnology.com` — `cortextos.wyretechnology.com` is the suggestion
  unless you want to align with an existing convention.
- Set `AUTH_URL` in env to match this exact public URL or NextAuth will
  redirect to `localhost:3000` after login.

### 5. Healthcheck

Already in the Dockerfile. Coolify will see it as `healthy` once the
container can serve `/login`. No further config needed.

## Verifying

After deploy:

1. Visit the public URL → expect the login page (200).
2. Log in with `ADMIN_USERNAME` / `ADMIN_PASSWORD`.
3. Pages that don't need the daemon should render: `/login`,
   `/settings` (partially), the dashboard shell.
4. Pages that DO need the daemon will load with empty state — this is
   expected until the daemon migrates. Look for "agent not found" or
   spinner-stuck states; those are the ones that will light up later.

## Updating

Coolify pulls and rebuilds on git push. The standalone build is
deterministic — no extra cache invalidation needed.

## Rollback

Coolify keeps prior image versions. If a deploy goes sideways, redeploy
the previous build from the Coolify UI.

## When you're ready to migrate the daemon

This is a real project, not a config change. At minimum:

- Daemon needs Linux x86_64 build of `node-pty` and `better-sqlite3`
  (already handled by `node:22-bookworm-slim` so the same image base
  works).
- Claude Code OAuth credentials currently live in the Mac Keychain.
  Linux uses `~/.claude/.credentials.json` — you'd run `claude login`
  on the container's first boot, or pre-bake a credentials file as a
  Coolify secret.
- PM2 vs systemd vs a fresh supervisor — Coolify's container model
  generally wants one process per container, so the daemon would run
  as its own Coolify service alongside the dashboard, sharing the
  `/state` volume.
- Telegram webhook vs polling — the agents currently use long-polling
  (`getUpdates`). That works fine in a container behind Cloudflare.
