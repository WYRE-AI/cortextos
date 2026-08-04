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

## Learnings - 2026-08-04

- **`CLAUDE_CONFIG_DIR` isolation gave each agent a private config but they still SHARE one binary.** Every agent's Claude Code therefore believes it is a standalone install and independently schedules its own auto-update against `~/.local/bin/claude -> versions/<v>`. N private updaters, one shared file, no lock. Two fired 250ms apart (`14:05:30.564Z` ruby, `14:05:30.812Z` pearl), both `install_failed`, and left the symlink dangling at an already-deleted `2.1.220` for ~12 minutes. This is the hidden cost of the 2026-07-14 per-agent-config fix.
- **A dangling binary reads as an agent crash, and that is the damaging part.** node-pty hands back a pid for a dangling symlink, then the child exits 1 having written ZERO bytes — reproduced exactly: `pid assigned: 69035 / exitCode: 1 signal: 0 / output bytes: 0`. The daemon charged the daily crash budget with exponential backoff; `boss` burned 8 of 10, `analyst` hit the cap and HALTED. Fixed both ways (`DISABLE_AUTOUPDATER=1` pin + a binary-unavailable exemption in `handleExit()`), but the diagnostic tell is worth keeping: **exit_code=1 with NOTHING appended to `stdout.log` means the process never started — check the binary before reading agent logs.** A real agent crash always emits something first.
- **Only agents that RESTART during such a window die; already-running ones are unaffected.** So the fleet looks half-healthy and the failure masquerades as agent-specific. `boss` and `analyst` crash-looped while ruby/pearl/warden kept beating, purely because the latter hadn't respawned. Corollary: `.last-update-result.json` in each agent's `claude-config/` is the forensic record — it timestamps every updater run and its outcome, and is what proved the race.
- **The same shape had already fired 13 hours earlier** (analyst updated 00:46Z, crash-looped 01:08–01:28Z, HALTED) and went unnoticed because the hang-detector rescued it. Silent recoveries hide recurring structural bugs — grep `restarts.log` for `CRASH: exit_code=1` bursts when auditing.
