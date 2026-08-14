# Contributing to cortextOS

## Development Setup

```bash
git clone https://github.com/grandamenium/cortextos.git
cd cortextos
npm install
npm run build
npm test
```

## Before Submitting Changes

1. `npm run build` — TypeScript must compile cleanly
2. `npm test` — all tests must pass
3. Match existing patterns in `src/` for new features
4. Add unit tests in `tests/` for any new code

## Project Structure

- `src/` — TypeScript source (bus, cli, daemon, hooks, types, utils)
- `bus/` — Shell wrapper scripts (delegate to `dist/cli.js bus`)
- `dashboard/` — Next.js 14 web dashboard
- `templates/` — Agent templates (agent, orchestrator, analyst)
- `community/` — Community skills and agent catalog
- `tests/` — Unit, integration, and E2E tests

## Code Style

- TypeScript strict mode
- No external runtime dependencies beyond what's in `package.json`
- File operations use atomic writes (see `src/utils/atomic.ts`)
- All bus operations go through `src/bus/` modules

## Learnings - 2026-07-14

- **Fleet-wide "hang" was weekly-limit exhaustion, not a freeze.** All agents shared the keychain login (aaron@aaronmsachs.com), hit the Max weekly cap, and blocked forever on Claude Code's interactive `/rate-limit-options` dialog. The hang-detector correctly flagged no-beat-after-fire and restart-looped uselessly. Diagnostic tell: strip ANSI from `~/.cortextos/default/logs/<agent>/stdout.log` and grep for "weekly limit" BEFORE suspecting daemon code.
- **Interactive Claude Code prefers the stored keychain login over `CLAUDE_CODE_OAUTH_TOKEN`** (print mode `-p` honors the env token). Fix: per-agent `CLAUDE_CONFIG_DIR` (in agent `.env`, pointing at `~/.cortextos/default/state/<agent>/claude-config/`) so the token is the only credential. Seed `.claude.json` with `hasCompletedOnboarding`, `bypassPermissionsModeAccepted`, and `projects.<agentDir>.hasTrustDialogAccepted` — and expect a boot race on first spawn (two agents still showed the folder-trust dialog once; a restart after claude's own config rewrite cleared it).
- **Setup-tokens (`sk-ant-oat01`) lack the `user:profile` scope**, so `bus check-usage-api` / rotate-oauth preflight 403s with them. Rotation preflight needs an inference ping (e.g. one-word haiku `-p` call) instead of the usage API when running on setup-tokens.
- **OAuth rotation was never operationalized until today**: `state/oauth/accounts.json` was never seeded, no `.env` had a token, and nothing invokes rotation automatically. Now seeded with 4 accounts (active: wyre-team100). Open design gap: rotation must live in the daemon — a rate-limit-blocked agent can't run `rotate-oauth` itself; the daemon should detect the limit banner in the PTY stream, halt hang-restarts, rotate, and alert.
- **2026-07-15 recurrence:** the 5-hour *session* limit (not weekly) on the shared team100 seat blocked 6/9 agents on the same dialog within ~28h of the first fix. Nine concurrent Opus agents exhaust any single seat's 5h window under load — account rotation cadence is hours, not weeks. Manual rotation playbook (15 min): preflight bench account with clean-room opus `-p` ping → update `active` + rotation_log in `state/oauth/accounts.json` → rewrite `CLAUDE_CODE_OAUTH_TOKEN` in agent `.env`s → restart agents. Daemon-side auto-rotation is now the top open item.

## Learnings - 2026-07-16

- **Limit-rotation shipped and live-verified.** Full chain (PTY banner → limit-detector → rotation-manager → opus-ping preflight → accounts.json flip → .env rewrite → targeted restart → Telegram alert → cooldown guard) exercised end-to-end via a PATH-shimmed fake `claude` on warden that printed a real banner. Agent `.env` PATH lines override the daemon base env — useful for per-agent binary shims in future verifies.
- **Weekly limits are rolling windows:** aaronmsachs-max20 was hard-blocked Tuesday but had usable capacity again by Thursday, two days before its stated "resets Jul 20" — a "dead" account can't be assumed dead for a live verify, hence the shim approach.
- **PTY banner text has cursor-positioning escapes BETWEEN words** — after ANSI-stripping, text reads `Whatdoyouwanttodo?`. Any matching against agent PTY output must normalize whitespace away first.

## Learnings - 2026-08-14

- **A cancelled Anthropic subscription still AUTHENTICATES — the rotation preflight cannot see it.** `aaronmsachs-max20` was cancelled, yet a clean-room one-word opus `-p` ping returned `alive` exit 0, exactly like the three healthy accounts. It only fails on real workloads: hermes' 90k-token / 381-msg request got `rate_limit_error` (`req_011Ce2ms*`) while the 5-token ping sailed through. **The setup-token liveness ping proves the token authenticates, not that the account has capacity** — so `rotate-oauth` will happily rotate *onto* a cancelled account and report success. Corollary for diagnosis: "all accounts ping alive" is not evidence the credential layer is healthy; check a large-request log instead.
- **`rotate-oauth` cannot target a named account** — candidates are sorted by `five_hour_utilization`, which is permanently `0` for setup-tokens, so the order is arbitrary insertion order and it takes the first that pings alive. Off a dead account it lands wherever `Object.entries` points, *not* where you want. Fixed by adding `bus set-oauth-account <name>` (PR #91), which composes `setActiveAccount` + `writeTokenToAgents` so a manual switch still gets a `rotation_log` entry and `.env` propagation. Hand-editing `accounts.json` gets neither.
- **Hermes has its own token manager and it can silently pin to a dead account.** `~/.hermes/anthropic-rotate.py` (launchd `ai.hermes.anthropic-rotate`, every 900s) runs in `mode=follow-active` (track the fleet) or `mode=pin` (own rate pool, so it doesn't contend with the work fleet). It was pinned to `aaronmsachs-max20` and logged `already on aaronmsachs-max20, no change` every 15 min for hours *while the gateway was hard-failing* — the pin means fleet rotation does NOT rescue hermes. Fix is `anthropic-rotate.py pin <account>` (rewrites `.env`, `hermes auth reset anthropic`, restarts gateway). **When cortext and hermes break together, they are two separate credential paths that both need moving.**
- **5 of 14 enabled agents are outside the rotation mechanism.** `adoption`, `grower`, `infra`, `maintainer`, `marketing` have no `CLAUDE_CONFIG_DIR`, so per the 2026-07-14 note they prefer the shared keychain login over `CLAUDE_CODE_OAUTH_TOKEN` — a rotation cannot move them. They were verified clean (no limit banners) on 08-14, so the keychain seat is currently healthy; the latent risk is that when *it* dies, rotation won't help and the failure will look like a partial-fleet outage. `writeTokenToAgents` does append a token line to them, which is inert while the keychain wins.
