# CHANGELOG

## [Unreleased]

### Fixed — GET /api/workflows/crons was O(crons) full log reads per request

`readLastExecution(agent, cronName)` re-read and re-parsed the agent's entire
`cron-execution.log` once **per cron**. At 10 crons per agent that is ten full
reads of the same file per request, which made `/crons` the slowest route the
dashboard serves — while `/health`, which already read each log once, was 5x
faster over the same dataset.

Replaced with a single backward pass per agent building a `Map<cronName,
lastEntry>` (keeping the first hit per name preserves "last entry in file order
wins" exactly). Measured on the phase-4 benchmark:

| dataset | p50 before | p50 after | p95 before | p95 after |
|---|---|---|---|---|
| 50 crons  | 1980ms | **166ms** | 2676ms | **373ms** |
| 100 crons | 1749ms | **270ms** | 2706ms | **400ms** |

`tests/integration/phase4-performance.test.ts` had been failing its
`p95 < 2000ms` budget on this route; it now passes 6/6 and runs 3x faster.
### Added — canonical branch protection on `main`

`main` previously had zero branch protection (no required status checks, no
required reviews, no rulesets) — the only thing standing between a push and
`main` was individual discipline. Added, matching `conduit`'s live shape:

- Required status checks: `Build & Type Check`, `Dashboard Build`,
  `Unit Tests`, `Operational-leak scan` (all `github-actions`, app id 15368).
- 1 required approving review (`require_code_owner_reviews: false` — no
  `CODEOWNERS` file exists yet; can layer that on separately if one is added).
- `enforce_admins: false` — preserves the existing admin/agent squash-merge
  path (used throughout tonight's PR triage) for cases with no second
  reviewer available, same pattern already proven on `conduit`.
- No force-pushes, no deletions.

Step 0 of the low-risk auto-merge lane design
(`task_1785685546659`) — the lane should merge through required-checks, not
around an unprotected `main`.

### Fixed — hang-detector class 3: PreToolUse activity beat as a third liveness source

The Stop hook (`last_idle.flag`) only writes on turn COMPLETION, so a single
work turn longer than the hang-detector's 15min grace window — a build, a
full test suite, a long research pass — that spans a delivered cron fire
read as beatless for the turn's entire duration, even though the session was
actively working throughout. A healthy agent doing exactly that could
force-fresh-restart mid-work.

- **`src/hooks/hook-activity-beat.ts`** (new): PreToolUse hook, writes
  `state/<agent>/last_activity.flag` on EVERY tool call — mid-turn, unlike
  the Stop hook. Same minimal, fail-safe shape as `hook-idle-flag.ts`.
- **`src/daemon/hang-detector.ts`**: `maxBeat` generalized from two inputs to
  N; `evaluateHang`, `evaluateBootstrapHang`, and `hasBeatSinceRestart` now
  take an optional third source, `lastActivityBeatAt`, combined the same way
  `lastIdleFlagAt` was added in the 2026-07-13 dual-source fix.
- **`src/daemon/fast-checker.ts`**: `checkHangStatus()` reads
  `last_activity.flag` alongside the existing two sources and threads it
  through both hang evaluators and the restart-loop-counter reset check.
- **`src/cli/bus.ts`** / **`tsup.config.ts`**: wired `hook-activity-beat` as
  a CLI subcommand and build entry point (the exact miss that caused
  `hook-idle-flag` to ship silently-inert once before — see that commit).
- Registered in the `PreToolUse` hook array of every `.claude/settings.json`
  template (`templates/{agent,analyst,orchestrator}`,
  `community/agents/{security,research-agent}`) — applies to newly created
  agents. **Not** propagated to already-live agents' gitignored
  `orgs/*/agents/*/.claude/settings.json` copies — that's a fleet-wide
  runtime-behavior rollout decision left for a deliberate follow-up, not a
  silent side effect of this fix.
- Tests: `tests/unit/daemon/hang-detector.test.ts` (triple-source cases for
  both `evaluateHang` and `evaluateBootstrapHang`, plus `hasBeatSinceRestart`)
  and `tests/unit/daemon/fast-checker.test.ts` (`checkHangStatus` integration
  coverage mirroring the existing dual-source wiring tests).

### Fixed — `bus complete-task` / `update-task` uncaught-exception crash

An agent hit this live: `cortextos bus complete-task <id> --result "..."`
and `cortextos bus update-task <id> <status>` crashed on a task ID that
didn't resolve (`findTaskFile` returns `null`) — an uncaught exception
past the commander action handler, printing a raw Node stack dump that
ends in a `Node.js vX.Y.Z` trailer line. Piped through `tail` (as the
reporting agent had done while diagnosing), only that trailer survived,
reading as a mysterious bare crash.

- **`src/cli/bus.ts`**: wrapped both actions' calls (`completeTask` /
  `updateTask`) in try/catch, mirroring the pattern `claim-task`'s action
  already used — `console.error(err.message); process.exit(1)` instead of
  letting the throw become an uncaught exception. `completeTask`/
  `updateTask` themselves were already correct (throwing on a genuinely
  missing task is the right behavior) — the gap was purely at the CLI
  layer not catching it.
- **`bus/complete-task.sh`**: separately found and fixed while
  investigating — the wrapper only ever read `$2` as a bare positional
  result value, so `complete-task.sh <id> --result "<text>"` (the form
  every agent bootstrap doc teaches) set `RESULT="--result"` and silently
  dropped the real text (landed in `$3`, never read), storing the literal
  string `"--result"` as the completion result. Fixed by forwarding all
  args after `<id>` to the CLI as-is — it already accepts both the
  positional and `--result`-flag forms.
- Regression tests: `tests/integration/bus-task-error-handling-cli.test.ts`
  (drives the compiled CLI as a subprocess against a nonexistent task ID,
  asserts a clean one-line stderr message with no `Node.js v` trailer or
  stack frame, and that the happy path still works) and
  `tests/integration/bus-complete-task-wrapper.test.ts` (drives the bash
  wrapper directly, both invocation forms).

### Added — SP3b: Slack Socket Mode inbound channel

Agents can now be talked to on Slack, not just Telegram — critical path for
deploying a Hermes agent for a user whose only channel is Slack. Builds on
SP3a (outbound-only: `src/slack/api.ts`, `identity.ts`).

- **`src/slack/socket-mode.ts`** (new): `SlackSocketModeClient` — one shared
  WebSocket connection for the whole daemon (Slack is one app per workspace,
  not one bot per agent, unlike Telegram's per-agent `TelegramPoller`). Uses
  Node's native global `WebSocket` (stable since Node 22 — `engines.node`
  bumped `>=20.0.0` → `>=22.0.0` accordingly, no new runtime dependency
  added). Acks every `events_api` envelope within Slack's ~3s window
  (transport requirement, independent of downstream processing). An
  epoch/generation-counter guard makes stale-connection frames a no-op by
  construction after a reconnect — a positive invariant rather than relying
  on teardown-ordering correctness (the classic hand-rolled-reconnect bug
  class).
- **`src/slack/dispatcher.ts`** (new): routes one inbound Slack message to
  every agent whose `slack.json` allows it — channels are N:1 (multiple
  agents can watch one channel), unlike Telegram's inherent 1:1.
- **Fail-closed user allowlist**: `slack.json` gains `allowed_users`, keyed
  on `"<team_id>:<user_id>"` composite identity (not bare `user_id` — Slack
  user ids are workspace-scoped, not globally unique). Channel membership
  alone was judged too weak a gate (channels are N-member, membership drifts)
  — mirrors Telegram's `ALLOWED_USER` fail-closed default. An agent with an
  empty or missing `allowed_users` accepts messages from no one.
- **`src/daemon/fast-checker.ts`**: `queueSlackMessage` +
  `formatSlackTextMessage`, a queue parallel to (not shared with)
  `queueTelegramMessage` so Slack traffic doesn't drive the Telegram typing
  indicator. Reuses the existing content-hash `isDuplicate` dedup unmodified.
- **`src/daemon/agent-manager.ts`**: the org's orchestrator starts the one
  shared `SlackSocketModeClient` at boot (mirrors the existing org-level
  activity-channel-poller pattern), gated on `SLACK_APP_TOKEN` +
  `SLACK_BOT_TOKEN` being present.
- **`cortextos slack send`** (new, stable command name): what the injected
  "Reply using:" line invokes. `test-send` is unchanged.
- Setup runbook: `docs/runbook/sp3b-slack-socket-mode-setup.md`.

### Added — daemon-side rate-limit detection + OAuth auto-rotation

Twice in 28 hours (2026-07-14 weekly limit, 2026-07-15 5-hour session limit) the
whole fleet blocked on Claude Code's interactive rate-limit dialog; the hang
detector saw no-beat-after-fire and restart-looped agents into the same wall.
Recovery is now automatic:

- **`src/daemon/limit-detector.ts`** — pure banner detection over ANSI-stripped,
  whitespace-normalized PTY output (cursor-positioning escapes sit between words).
  Fires only on limit phrase + blocking-dialog marker together, so an agent merely
  quoting a limit message never triggers it. Parses `(UTC)` reset hints.
- **`src/daemon/rotation-manager.ts`** — reacts to limit events: marks the agent
  limit-blocked (`state/oauth/rotation-state.json`), preflights bench accounts,
  flips `accounts.json` active, rewrites agent `.env` tokens, restarts only the
  blocked agents, and Telegram-alerts once. All-dry → halt with a single alert and
  auto-retry at the earliest known reset. Recovered-in-place active accounts are
  detected and reused without a flip. 10-min rotation cooldown; 30-min proactive
  preflight of the active account rotates ahead of exhaustion.
- **`src/daemon/account-preflight.ts`** — preflight is a one-word **Opus**
  inference ping in an isolated `CLAUDE_CONFIG_DIR` (limits are model-bucketed,
  and setup-tokens lack the `user:profile` scope the usage API requires).
- **FastChecker** suppresses hang-restarts for limit-blocked agents — the
  rotation manager owns that recovery.
- **`src/bus/oauth.ts`** — new `setActiveAccount` helper; `writeTokenToAgents`
  exported for the daemon.

Verified live end-to-end (PTY banner → detection → rotation → targeted restart →
alert → cooldown) via a shimmed agent binary on 2026-07-16.

### Fixed — topology guard: argv/env instance agreement + single-daemon-per-instance boot guard

- **The daemon now parses `--instance` argv and refuses to start when it
  disagrees with env `CTX_INSTANCE_ID`** (new `src/daemon/instance-guard.ts`).
  Env-only resolution was the 2026-07-13 two-daemon root cause: a
  `pm2 start --update-env` from a shell without `CTX_INSTANCE_ID` re-baked the
  gateway-named app onto instance `default` — duplicate fleet, bus
  double-delivery. The mismatch error names both values and the exact operator
  fix.
- **Single-daemon-per-instance boot guard**: the daemon refuses to boot when
  its instance's `daemon.pid` already points at a live process that isn't
  itself, instead of silently overwriting the pidfile and joining a
  split-brain. Unknown states (missing/stale/corrupt pidfile) boot normally —
  it only refuses on a positively-indicated live daemon. Ownership is
  verified via a new `daemon.start-time` anchor (epoch-ms process start time,
  written anchor-first/atomically): a live pid whose start time mismatches
  the anchor is a **recycled pid** (crash-orphaned pidfile) and boots instead
  of false-refusing; `daemon.pid` itself stays bare-int for operator `cat`s
  and the deploy-runbook invariant. NOTE: the daemon uses pm2 restart /
  stop-then-start, NEVER `pm2 reload` — reload spawns-new-before-kill-old, so
  this guard structurally refuses it by design.

### Fixed — cron scheduler: infeasible dom+month expressions rejected before the minute scan

- `nextFireFromCron` now pre-checks that at least one expanded month admits at
  least one expanded day-of-month. An impossible-but-per-field-valid expression
  (`0 0 31 2 *` — Feb 31) previously walked the entire 366-day scan window —
  527K `formatToParts` calls, ~1.2s measured against ~3.5ms for a normal
  expression — just to return NaN, on every schedule reload and every
  `list-crons` next-fire preview. The pre-check rejects in O(fields) before the
  Intl formatter is built. `29 2` (Feb 29) deliberately remains feasible; leap
  years are the scan's question. Fast-follow to the timezone fix below, which
  introduced the per-minute Intl cost.

### Fixed — freeze-cure: context-handoff default-ON + fleet-wide bridge wiring

The daemon shipped a full context-handoff mechanism (thresholds, tiers, handoff
prompt, `.force-fresh` pre-arm) that **never fired**, so agents ran to context
exhaustion and froze (one orchestrator reached ~928k / ~93% of a 1M window before
freezing for ~51h). Two dead gates in series were responsible:

- **Primary (make-or-break): the context-status bridge was unwired.** The monitor
  reads `state/<agent>/context_status.json`, which is only written by the
  `cortextos bus hook-context-status` statusLine hook — and that hook was wired
  into **0** agents. `checkContextStatus` returned at `!existsSync` before any
  threshold logic ran, so `pct` was always null and the whole mechanism was inert.
  - The three agent **templates** (`agent`, `analyst`, `orchestrator`) now ship
    the `statusLine` hook so new agents emit context data.
  - New `scripts/wire-statusline.mjs` (idempotent, `--dry-run`) wires the hook into
    existing agents' gitignored local `.claude/settings.json` — a `statusLine`-only
    patch that does not touch permissions. Agents must be restarted to apply.
- **Secondary: handoff was observe-only by default.** An unset
  `ctx_handoff_threshold` meant observe-only (log, never act). It now **defaults ON**
  at warn 30% / handoff 60% of the model window; an explicit `ctx_handoff_threshold
  <= 0` is the deliberate opt-out.

Safety envelope so default-ON is at least as safe as the source mechanism:

- **Fleet handoff lease** (`src/daemon/context-handoff-lease.ts`): caps concurrent
  handoffs (2) and staggers the rest, so the first-ever fleet-wide context flow
  can't become a thundering-herd restart storm. Release-safe (by name, session-id
  independent, on fresh session / Tier-3 teardown) so a slot never leaks.
- **Cooperative-restart loop backstop**: the circuit breaker now also counts Tier-2
  handoff fires in a persisted 15-min window and trips (30-min pause + alert) if a
  runtime fails to reset context on the handoff restart — so a handoff treadmill
  self-limits regardless of cause.
- **Overflow-banner corroboration guard**: the PTY-overflow backstop now only fires
  when context usage corroborates it (exceeds 200k, or pct ≥ 85), so a fresh boot
  re-reading memory/source that *documents* the overflow phrase no longer
  force-restarts on every boot.

Covered by `tests/unit/daemon/context-handoff-lease.test.ts` (herd drain + leaked-
lease edges) and `tests/unit/daemon/context-handoff-defaulton.test.ts` (default
truth-table + loop backstop + overflow guard). Ported/reconciled from upstream #685
against this fork's already-evolved handoff machinery (#194 `.force-fresh` pre-arm
was already present).

### Added — freeze-cure: hang detection (DETECTION half)

Complements the context-handoff PREVENTION path: catches the *non-context* freeze mode
— a `--continue`-resumed session frozen mid-turn that processes no cron fires — which no
context-% threshold can see (this is what took out several fleet agents).

- **`last_session_heartbeat`** on the heartbeat record — advanced ONLY by a genuine
  session-authored `update-heartbeat --source session` (the new default). The 50-min
  watchdog beat (`--source watchdog`) and the log-event timestamp bump preserve it and
  never advance it, so the sensor keys on the *real* signal (session processing) rather
  than `last_heartbeat`, which the watchdog keeps fresh even for a dead session.
- **`update-heartbeat --source <session|watchdog>`** flag; the daemon idle-watchdog
  (`fast-checker`) now beats with `--source watchdog`. `updateHeartbeat` carries the prior
  `last_session_heartbeat` forward on a watchdog beat (it rewrites the whole object).
- **`src/daemon/hang-detector.ts`** (pure, unit-tested sensor): HUNG iff a delivered cron
  fire (`crons.json` `last_fire_attempted_at`) is older than a grace window (~15min) AND
  the most-recent session beat predates it. Batching-aware (keys on the most-recent
  delivered fire). **Fail-safe by construction** — absent field, absent fire, parse error,
  or any ambiguity falls through to *not* hung. Idle-exit ≠ hang: a resumed idle session
  writes a Part-A beat after its fire, so it never trips.
- **Actuator** (`fast-checker` `checkHangStatus`/`forceHangRestart`): force-fresh restart
  (never `--continue`, which re-hangs) with a persisted **halt-after-3-in-30min** breaker
  so the auto-healer can't itself loop, plus a cooldown and a daemon-sent Telegram alert
  to the agent's chat on restart and on HALT. Governing bias: **fail safe toward
  not-restarting** (a missed hang is re-caught on the next fire; a false restart disrupts
  a healthy agent). Covered by `hang-detector.test.ts` + `heartbeat-source.test.ts`.

### Fixed — daemon agent-registry ↔ PTY-liveness reconcile

- **reapOrphan accretion guard** (follow-up to the reconcile below): `reapOrphan`
  now clears the pidfile and reports `reaped: true` ONLY when the process is
  actually gone (exited on SIGTERM, or a confirmed-ownership SIGKILL). On the
  fail-closed skip path — alive but no longer ownership-verified before SIGKILL —
  it leaves the pidfile in place so the orphan is retried by the next boot-reap
  instead of becoming untracked (accretion), and returns `reaped: false`.
- **Restart-tooling divergence**: `cortextos stop <agent>` could silently no-op
  while the agent stayed alive ("stop didn't kill it"), and `cortextos start`
  could return "deduped — already in registry" on a *dead* agent. Root cause: the
  daemon's in-memory agent registry (`AgentManager.agents`) was never reconciled
  against real PTY liveness; agents are PTY children of the daemon (not pm2 apps),
  so when the Map diverged from reality the ops no-op'd against reality.
  - **start**: a dead-but-registered entry is now evicted before the dedup guard,
    so a fresh start proceeds instead of DEDUPE-ing forever. Never kills — the
    process is already gone.
  - **stop / boot orphan-reap**: a PTY that survived a prior daemon generation is
    now reaped, but ONLY after ownership verification — the pid must be alive AND
    its process start-time must match the recorded spawn. This guards the
    catastrophic pid-recycling case (a reused pid belonging to an unrelated
    process is NEVER killed); it fails closed on any doubt.
  - New `src/utils/agent-pidfile.ts` persists each agent's PTY pid + start-time +
    spawning-daemon pid to `state/<agent>/agent.pid`; new `AgentProcess.getPid()`.
    Covered by `tests/unit/utils/agent-pidfile.test.ts` (incl. explicit
    recycling-guard tests that assert an unverified live pid is never killed).

### Hook Framework — Loop Detection (B1)

- **`hook-loop-detector`**: new PreToolUse hook that detects and blocks repeated Claude tool-call loops. Two patterns are detected: (a) the same tool invoked with identical arguments 15+ times within the last 30 calls, and (b) two tools ping-ponging (24+ alternations within a 12-call dominant-pair window). Blocked calls are NOT recorded into history, so the wedge cannot self-perpetuate. History is time-windowed (60s) so a stale prior-session tail does not block the first call of a new session. After 30 minutes of continuous block, exactly one tool call is allowed through ("emergency escape") so the agent can issue a Telegram alert before re-entering the blocked window.
- **`cortextos bus hook-loop-detector`**: CLI subcommand to invoke the hook, follows the existing hook-runner pattern.
- **Settings wiring**: agent / orchestrator / analyst templates and the security community agent now ship with the hook enabled by default in `.claude/settings.json` (PreToolUse, no matcher, 5s timeout).
- **State**: `${CTX_ROOT}/state/<agent>/loop-detector.json`. Recoverable from corruption (bad JSON → empty state).

### Added
- SP3a — Slack outbound. New `src/slack/` (SlackAPI client + per-agent
  identity loader). `cortextos slack {test-send, discover-channels}` CLI.
  `bus/_slack-curl.sh` + `bus/send-slack.sh` shell entry points. Per-agent
  `slack.json` schema (display_name, icon_emoji, channels, allowed_channels).
  Cloud-init pulls `slack-bot-token` from Key Vault into `/etc/cortextos.env`
  at boot. Runbook walkthrough for the one-time Slack app registration
  (`docs/runbook/sp3a-slack-app-setup.md`). App registered & installed to the
  WYRE workspace (app id `A0B8MN37YSC`); verified end-to-end on the live VM
  by posting to #general as `boss` with the per-agent username override.
- SP2c-4 — dashboard env auto-provisioning at first boot. Cloud-init
  generates `ADMIN_PASSWORD` and `AUTH_SECRET`, writes them to
  `dashboard/.env.local`, and stores recoverable copies in Key Vault as
  `dashboard-admin-password` and `dashboard-auth-secret`. Idempotent via
  sentinel file. VM managed identity granted `Set` on Key Vault. A fresh
  VM now presents a working dashboard login on first visit with no
  manual env hacking.
- Per-engineer agent namespaces: personal agents live under
  `orgs/<org>/engineers/<engineer>/agents/<name>`, addressed as `<engineer>/<name>`.
- `cortextos add-engineer <name>` command to scaffold a namespace.
- `templates/engineer` namespace template.
- Centralized agent-directory resolution (`src/utils/agent-dir.ts`).
- `pm2ProcessName` helper for future per-agent PM2 entries.
- SP2b — first-boot bootstrap and steady-state systemd units. A freshly
  provisioned VM (via `infra/terraform/`) boots into a working cortextOS
  install: data disk formatted and mounted at `/var/lib/cortextos`,
  `cortextos` system user, repo cloned to `/opt/cortextos` with `orgs/`
  symlinked into the data disk, `cortextos init` scaffolding the org,
  and `cortextos.service` running the daemon + dashboard under
  `pm2-runtime`.
- `infra/bin/check-systemd-drift.sh` keeps the embedded and standalone
  systemd unit definitions in `cloud-init.yaml.tftpl` and `infra/systemd/`
  in sync (Python+YAML based).
- SP2c-1 — daily data-disk backups via Azure Backup (Data Protection): backup
  vault, daily disk-snapshot policy (14-day retention), and a backup instance
  protecting the data disk, with snapshots in a dedicated snapshot resource
  group. Verified end-to-end (on-demand backup job + snapshot).
- `docs/runbook/sp2-host.md` — operations runbook (SP2c-3: backup, teardown, day-to-day ops, disk growth, tunnel re-auth, restore drill, rollback, break-glass, SSO troubleshooting).
- SP2c-2 — Cloudflare Tunnel + Zero-Trust Access. The dashboard is reachable at
  `https://wyre-agents.wyre.ai` and ops SSH at `wyre-agents-ssh.wyre.ai`
  through a Cloudflare Tunnel (no public IP), gated by Entra-SSO Access limited
  to `@wyretechnology.com`. `cloudflared.service` runs the tunnel from a token
  stored in Key Vault and fetched at first boot via the VM's managed identity.
  Host-based subdomain routing — no dashboard code change.

### Changed
- `cortextos ecosystem` now uses `next start` when `NODE_ENV=production`
  (was hardcoded `next dev`, which caused 30-second cold compiles per
  route on deployed installs). Cloud-init bootstrap also passes
  `NODE_ENV=production` when calling `cortextos ecosystem`.
- `listAgents` also discovers namespaced agents.
- `cortextos ecosystem` agent count now includes namespaced agents.
- `cortextos ecosystem` now emits the daemon entry even when zero agents
  are configured, with a warning. Previously refused to generate the file,
  which broke the first-boot bootstrap path.
- `AGENT_NAME_REGEX` exported from `src/utils/validate.ts` for reuse.
- Forked to `wyre-technology/cortextos`; `CONTRIBUTING.md` documents upstream sync.

### Fixed
- **Test suite green: repaired the three remaining pre-existing failures and
  the import-broken integration files.** (1) hooks: the symlink-escape tests
  used un-canonicalized `mkdtempSync` paths, so on macOS (`/var` →
  `/private/var`) the permission-gate's containment check failed before the
  symlink logic ran — tests now `realpathSync` their temp dirs; confirmed the
  gate itself is correct and fail-closed, and the symlink-security assertions
  now genuinely exercise the real code path on macOS. (2) add-agent: the
  BUG-041 PascalCase test asserted the old `validateAgentName()` error quoting;
  the namespace-support change moved validation to `parseQualifiedName()`
  (same guarantee — rejection before any filesystem write) with double-quoted
  names. Assertion is now quote-tolerant. (3) Four integration test files
  (`phase4-dashboard-backtest`, `phase4-performance`, `phase5-e2e-simulation`,
  `phase5-user-journeys`) runtime-imported `next/server`, a dashboard-only
  dependency absent from root installs, so the whole files failed to load on
  fresh checkouts. The workflows route handlers only use the standard WHATWG
  Request surface, so the tests now build plain `Request`s via a
  `makeRouteRequest` helper (type-only NextRequest cast, erased at transpile).
  38 construction sites converted; 72 previously-unloadable tests now run.
- **BUG-011 "regression" alarms were false positives from cross-org duplicate
  discovery — with a real resurrection side effect.** The default instance
  discovers ALL orgs (legacy behavior kept by BUG-061), and production has the
  same five agent names in both `orgs/wyre` and `orgs/wyre-gateway`. Every
  daemon boot, the duplicate copies hit `startAgent()` while the originals
  were registered, firing "BUG-011 REGRESSION CHECK: X still in registry"
  warnings and poisoning `pendingRestarts` with entries that later fired on
  any intentional stop — resurrecting explicitly-stopped agents, and
  resurrecting agents **mid-shutdown** during `stopAll()`, where the fresh
  FastChecker is killed moments later by `process.exit()` mid-poll: the exact
  kill window that orphans inbox `.lock.d` mutexes (see the stale-lock fix).
  Two changes: (1) `discoverAndStart()` dedupes by agent name — one name, one
  agent; the daemon's own startup org wins the claim deterministically,
  first-discovered otherwise; duplicates are skipped with an info log and
  never reach `startAgent()`. (2) `stopAgent()` no longer honors queued
  restarts while `stopAll()` is in flight; shutdown discards the queue with a
  log line. The genuine-race safety net (queue on live-registry collision,
  honor on single-agent stop) is preserved and pinned by tests. Also repaired
  the three BUG-043 multi-org tests that BUG-061's instance-scoping had left
  stale (they now construct the manager as the `default` instance).
- **Permanent inbox deadlock from orphaned `.lock.d` (silent no-reply agents).**
  `acquireLock()` treated a `.lock.d` whose `pid` file was missing or
  empty/corrupt as "holder mid-acquire, retry" with no staleness escape — but a
  holder killed between `mkdirSync(.lock.d)` and `writeFileSync(pid)` (pm2
  restart, daemon crash, shutdown) never writes a valid pid, so the
  PID-liveness stale check could never run and the lock wedged **forever**.
  `checkInbox()` compounded it by silently returning `[]` on lock failure, so
  wedged agents kept answering Telegram/crons while never receiving bus
  messages (observed 2026-07-01: 8 inboxes across two instances stranded
  ~84 messages for 2–4 days — the "inconsistent agent replies" bug).
  `acquireLock()` now steals a missing/corrupt-pid lock once it is older than
  30s (`STALE_LOCK_MS`, ~6 orders of magnitude above the real mkdir→write
  gap), preserving mid-acquire protection; live-holder and dead-pid-recovery
  semantics unchanged. `checkInbox()` now logs a rate-limited warning (once
  per inbox per minute) when it cannot acquire the lock, so a wedged inbox
  can never be silent again.
- **BUG-061 — multi-instance roster bleed.** A non-default daemon instance
  (e.g. `--instance wyre-gateway`, `CTX_ORG=wyre-gateway`) started the *wrong*
  roster: `AgentManager.discoverAgents()` scans every org under the shared
  framework root, and the instance enable-list is disable-only (absence ⇒
  enabled, per BUG-028), so a second instance re-discovered and started the
  default instance's agents (a different org). Instances were isolated by
  `CTX_ROOT` (state) but not by agent roster. `discoverAndStart()` now skips
  any discovered agent whose `resolveAgentOrg(name)` differs from the daemon's
  `CTX_ORG` — **only for non-default instances**; the `default` instance keeps
  the legacy discover-all-orgs behavior (multi-org / single-install catch-all),
  so there is zero change to existing single-instance installs. Paired with the
  `ecosystem.config.js` PM2 process-name suffix (`cortextos-daemon-<instance>`
  for non-default instances; `default` stays `cortextos-daemon`) so multiple
  instances run side-by-side without renaming/restarting the running default
  fleet.

## [0.2.0] — 2026-05-04 — External Persistent Crons

Crons move from session-local (`/loop`, `CronCreate`) to daemon-managed `crons.json` files under `${CTX_ROOT}/state/{agent}/`. Auto-migrates from existing `config.json` on first daemon boot. Fully backward-compatible additive feature.

### Phase 5.4 — Race Hardening & Workspace Teaching

- **iter 9 fix**: `lastGoodSchedule` fallback now distinguishes a legitimately-empty `crons.json` from a corrupt parse failure, so emptying a file no longer keeps stale crons firing.
- **iter 10 fix**: persist `last_fire_attempted_at` to prevent crash-mid-fire double-fire on next daemon restart.
- **iter 11 fix**: defer scheduler reload while a fire is in flight, and lazy-create the scheduler when a reload hits a start-window gap (no missed first fire after re-enable).
- **iter 12 fix**: serialize bus `add-cron` / `update-cron` / `remove-cron` operations to fix lost-update race when concurrent edits land on the same agent.
- **Race test pins**: dedicated regression tests for iter 9 / 10 / 12 race conditions plus remove-cron mid-fire (no double-fire).
- **`bus upgrade-cron-teaching` CLI scanner**: scans CLAUDE/AGENTS/ONBOARDING/SKILL files for stale `CronCreate` / `/loop` references and reports advisories. Pure advisory by default; `--apply` for safe substitutions.
- **`migrate-crons` cron-teaching upgrade banner**: daemon emits one advisory line per agent on first migration, drops `.cron-teaching-checked` marker (idempotent).

### Phase 5.3 — Failure Mode & Recovery

- **`lastGoodSchedule` snapshot in `CronScheduler`**: if a `reload()` produces an empty schedule (transient corruption), the scheduler retains the last successfully loaded schedule in memory and keeps firing until the file is repaired. In-memory only — does not survive daemon restarts.
- **`.bak` rotation in `writeCrons`**: `atomicWriteSync` now accepts a `keepBak` flag; `writeCrons` passes `keepBak: true` so every atomic write preserves the previous `crons.json` as `crons.json.bak`.
- **`.bak` fallback in `readCrons`**: on primary-file parse failure, `readCrons` automatically retries with `crons.json.bak`. Single-step automatic recovery without operator intervention.
- **ENOSPC/EACCES catch in `tick()`**: disk-full and read-only-filesystem errors when persisting `last_fired_at` are caught and logged; the in-memory schedule is preserved and crons continue firing.

### Phase 4 — Cron Dashboard

- **`/workflows` fleet overview page**: health summary panel + paginated read-only cron table across all agents, with agent and name search filters.
- **`/workflows/health` dedicated health page**: gap detection, health-status breakdown, and per-cron health rows for the entire fleet.
- **`/workflows/[agent]/[name]` cron detail page**: edit form (schedule, prompt, enabled, description), execution history viewer, and test-fire button.
- **`/workflows/new` page**: create a new cron for any enabled agent.
- **POST/PATCH/DELETE API routes** at `/api/workflows/crons/...`: routed through IPC (`handleAddCron`, `handleUpdateCron`, `handleRemoveCron`) with full input validation and scheduler reload after each mutation.
- **Test-fire button** (`/api/workflows/crons/[agent]/[name]/fire`): confirmation dialog, inline pending state, 30-second cooldown enforced client-side and server-side (IPC `handleFireCron`). Auto-refreshes execution history 6s after success.
- **`manualFireDisabled` flag**: setting this field on a cron definition disables the test-fire button (HTTP 403) for that cron. Useful for crons that must only fire on schedule.
- **Execution log pagination + filter + export**: history viewer supports status filter (All/Success/Failure), "Older"/"Newer" pagination with total count, and CSV/JSON export via dedicated executions API route.
- **Fleet health caching**: `computeFleetHealth` caches results for 30 seconds; cache is invalidated after any mutation or manual fire.
- **IPC commands**: `add-cron`, `update-cron`, `remove-cron`, `fire-cron`, `fleet-health`, `list-cron-executions` added to `IPCServer.handleRequest`.

### Phase 1–3 — External Persistent Cron Engine

- Crons migrated from session-local (`/loop` / `CronCreate`) to daemon-managed `crons.json` files under `${CTX_ROOT}/state/{agent}/`.
- `CronScheduler` with 30-second tick, 5-field cron expression parser, interval shorthand support, catch-up-once policy, and 3-attempt exponential backoff (1s/4s/16s).
- `readCrons` / `writeCrons` / `addCron` / `updateCron` / `removeCron` / `getCronByName` in `src/bus/crons.ts`.
- Auto-migration from `config.json` on first daemon boot per agent (`.crons-migrated` marker).
- Execution log (JSONL) with `fired` / `retried` / `failed` status entries.
- IPC `reload-crons`, `list-all-crons` commands.

---

## [0.1.1] — 2026-03-30

### Improvements

- **`/api/kb/search` result fields**: Added `filename`, `chunk_index`, `total_chunks`, and `content_full_length` to the KB search response. These fields come from mmrag.py's per-result metadata and are useful for UI display (show basename, chunk position within a document). `agent_name` and `org` now pull from the top-level JSON envelope when available rather than falling back to the request parameters.

- **`max_crashes_per_day` config field**: Added to `AgentConfig` type and all three agent templates (`config.json`). Default raised from 3 to 10 — the previous default halted agents after three transient crashes, which was too aggressive for production. Agents in high-activity environments can set a custom limit.

- **README — Agent Configuration section**: New section documenting all `config.json` fields with types, defaults, and descriptions. Includes cron format reference.

---

## [0.1.0] — 2026-03-30

### cortextOS Node.js — Initial Release

Complete TypeScript/Node.js implementation of the cortextOS agent framework. Full feature parity with the bash reference implementation. 307 unit and integration tests, 0 failures. npm-ready.

---

## What is cortextOS

cortextOS is a persistent 24/7 multi-agent framework built on Claude Code. Agents run as PM2-managed PTY processes, communicate over a file-based message bus, manage tasks, log analytics events, and are controlled via Telegram. This Node.js package ships the entire framework as a single `npm install` with a unified `cortextos` CLI.

---

## Core Features Shipped

### Message Bus

File-based inter-agent messaging with strict format parity with the bash reference implementation.

- **Priority queue**: `urgent > high > normal > low`. `checkInbox()` always returns messages sorted by priority.
- **Inbox lifecycle**: `send → inbox → inflight (on read) → processed (on ACK)`. Three-directory atomic flow.
- **Filename convention**: `{pnum}-{epochMs}-from-{sender}-{rand5}.json` where `pnum` encodes priority (0=urgent, 1=high, 2=normal, 3=low) for filesystem-native sort ordering.
- **Message ID format**: `{epochMs}-{from}-{rand5}` — globally unique, sortable, human-readable.
- **reply_to field**: Present on every message (null if no reply). Auto-ACKs the original on bus reply.
- **Undelivered redelivery**: Un-ACK'd messages in inflight redeliver after 5 minutes (daemon-level).
- **Urgent signal**: `notifyAgent()` writes `.urgent-signal` to state dir AND sends a bus message for persistence.

### Task Management

17-field task format with full lifecycle tracking.

- **Fields**: `id, title, description, type, needs_approval, status, assigned_to, created_by, org, priority, project, kpi_key, created_at, updated_at, completed_at, due_date, archived`
- **Status states**: `pending → in_progress → completed` (plus `blocked`, `cancelled`)
- **Task ID format**: `task_{epochMs}_{rand3}` — sortable, collision-resistant
- **`createTask()`**: Creates with all 17 fields, atomic write to `orgs/{org}/tasks/{id}.json`
- **`updateTask()`**: Updates status and `updated_at`, preserves all other fields
- **`completeTask()`**: Sets `status: completed`, `completed_at`, and `result` summary
- **`listTasks()`**: Scans task directory, excludes archived, supports `{ agent, status, org }` filters
- **`checkStaleTasks()`**: Identifies in-progress tasks untouched >2h, pending tasks unstarted >24h, and overdue tasks past `due_date`
- **`archiveTasks()`**: Moves completed tasks older than 7 days to `tasks/archive/`, sets `archived: true`. Supports `dry_run` mode.
- **`checkHumanTasks()`**: Finds tasks assigned to `human` or `user` that are stale (>24h pending, >2h in-progress)
- **Blocked task flow**: `update-task blocked "reason" <blocker_id>` — records `blocked_by` field, auto-sends unblock message when blocker completes

### Event Logging (Analytics)

JSONL-based event stream for dashboard Activity feed and analytics aggregation.

- **`logEvent()`**: Appends to `orgs/{org}/analytics/events/{agent}/{YYYY-MM-DD}.jsonl`
- **Event schema**: `{ id, timestamp, agent, org, category, event, level, data }`
- **Categories**: `action`, `task`, `milestone`, `error`, `system`
- **Levels**: `info`, `warning`, `error`
- **`getEvents()`**: Reads JSONL files with date-range filtering and agent/org filtering
- **`aggregateMetrics()`**: Aggregates events into task counts, session counts, KPI scores per agent

### Heartbeat System

Periodic liveness signals with context for dashboard status cards.

- **`updateHeartbeat()`**: Atomic write to `heartbeats/{agent}.json`
- **Heartbeat schema**: `{ agent, org, timestamp, last_heartbeat, status, current_task, mode, loop_interval }`
- **`readAllHeartbeats()`**: Scans heartbeats directory, returns all agents' current status
- **Running detection**: Heartbeat age <60s → agent considered `running: true`
- **`readHeartbeat()`**: Single agent read, returns null if file missing

### Approval Workflow

Pre-action approval gate for external or sensitive operations.

- **`createApproval()`**: Writes to `orgs/{org}/approvals/pending/{id}.json`
- **Approval ID format**: `approval_{epochMs}_{rand6}`
- **Fields**: `id, title, category, context, status, requesting_agent, org, created_at, resolved_at, decision_note`
- **Categories**: `external-comms`, `financial`, `deployment`, `data-deletion`, `other`
- **`updateApproval()`**: Moves from `pending/` to `resolved/` on approve/reject
- **Status values**: `pending`, `approved`, `rejected`
- **Blocked task integration**: Approval ID stored in task's `blocked_by` field; auto-unblocks on decision

### Knowledge Base (RAG / mmrag)

Semantic memory via the multimodal-rag Python library (mmrag.py).

- **`queryKnowledgeBase()`**: Runs mmrag.py query, returns `{ results: [{content, score, source}], total }`
- **`ingestKnowledgeBase()`**: Indexes documents from a path into a named collection
- **`listCollections()`**: Lists all ChromaDB collections with document counts
- **Collections**: `shared-{org}` (org-wide, all agents) and `agent-{name}` (private per-agent)
- **Environment setup**: Auto-sets `MMRAG_DIR`, `MMRAG_CHROMADB_DIR`, `MMRAG_CONFIG` for every subprocess call
- **Instance isolation**: KB root derived from `CTX_ROOT` basename — each cortextOS instance has its own KB
- **Auto-init**: `kb-ingest.sh` auto-calls `kb-setup.sh` if `config.json` is missing
- **`kb-setup.sh`**: Creates venv, installs mmrag deps, writes default `config.json`

### Experiment System (Theta Wave)

Structured hypothesis-test-evaluate loop for autonomous agent experimentation.

- **`createExperiment()`**: Creates experiment file with `id, metric, hypothesis, status, created_at`
- **`runExperiment()`**: Executes experiment, records `started_at`, transitions to `running`
- **`evaluateExperiment()`**: Records outcome, transitions to `completed` or `failed`
- **`manageCycle()`**: Manages full experiment cycle with pass/fail/continue logic
- **`loadExperimentConfig()`**: Reads `experiments/config.json` for `approval_required` and other settings
- **Approval gate**: If `experiments/config.json` has `approval_required: true`, `create-experiment` CLI auto-creates an approval and blocks until approved

### Agent Discovery

- **`listAgents()`**: Reads `config/enabled-agents.json` as authoritative source. Falls back to `orgs/` directory scan only when `CTX_FRAMEWORK_ROOT` is explicitly set in environment.
- **`buildAgentInfo()`**: Enriches agent entries with heartbeat data (status, current_task, mode), role from `IDENTITY.md`, enabled status from `config.json`
- **`notifyAgent()`**: Writes urgent signal file + sends bus message

### Catalog / Skills Marketplace

- **`browseCatalog()`**: Lists available skills from the community catalog
- **`installCommunityItem()`**: Installs a skill into an agent's skills directory
- **`prepareSubmission()`**: Packages a skill for community submission
- **`submitCommunityItem()`**: Submits a skill package to the catalog

### System / Lifecycle

- **`postActivity()`**: Sends activity update to Telegram (reads BOT_TOKEN/CHAT_ID from `.env`)
- **`selfRestart()`**: Writes `.restart-planned` marker, triggers soft restart (preserves conversation history via `--continue`)
- **`hardRestart()`**: Writes `.force-fresh` + `.restart-planned` markers, triggers fresh session
- **`uninstall()`**: Stops PM2, removes `enabled-agents.json`. With `--keep-state`: preserves CTX_ROOT. Without: full removal.

---

## CLI Reference (`cortextos`)

### Agent Management

| Command | Description |
|---------|-------------|
| `cortextos init` | Initialize a new cortextOS instance |
| `cortextos add-agent <name> --template <type>` | Create a new agent from template |
| `cortextos enable <name>` | Enable an agent (adds to enabled-agents.json) |
| `cortextos start <name>` | Start an agent (via PM2) |
| `cortextos stop <name>` | Stop an agent (via PM2) |
| `cortextos status` | Show all agents' status, heartbeat age, current task |
| `cortextos list-agents [--org <org>]` | List agents with heartbeat/role info |
| `cortextos list-skills` | List available skills |
| `cortextos install` | Install/configure cortextOS on this machine |
| `cortextos uninstall [--keep-state]` | Remove cortextOS |
| `cortextos doctor` | Diagnose common configuration issues |
| `cortextos dashboard` | Start the Next.js dashboard |

### Bus Subcommands (`cortextos bus <cmd>`)

#### Messaging
| Command | Description |
|---------|-------------|
| `bus send-message <to> <priority> '<text>' [reply_to]` | Send agent-to-agent message |
| `bus check-inbox` | Read and display pending inbox messages |
| `bus ack-inbox <msg_id>` | ACK a message (moves to processed) |
| `bus send-telegram <chat_id> '<text>'` | Send Telegram message |

#### Tasks
| Command | Description |
|---------|-------------|
| `bus create-task '<title>' ['<desc>']` | Create a new task |
| `bus update-task <id> <status> ['<note>'] ['<blocker_id>']` | Update task status |
| `bus complete-task <id> ['<result>']` | Mark task complete with result summary |
| `bus list-tasks [--agent <name>] [--status <s>] [--org <o>]` | List tasks with filters |
| `bus check-stale-tasks` | Report stale in-progress, stale pending, and overdue tasks |
| `bus archive-tasks [--dry-run]` | Archive completed tasks older than 7 days |
| `bus check-human-tasks` | Find tasks assigned to human/user that need attention |

#### Events
| Command | Description |
|---------|-------------|
| `bus log-event <category> <event> <level> [json_data]` | Append event to analytics JSONL |
| `bus get-events [--agent <a>] [--days <n>]` | Read recent events |

#### Heartbeat
| Command | Description |
|---------|-------------|
| `bus update-heartbeat '<status>'` | Write heartbeat with current status |
| `bus read-all-heartbeats` | Read all agents' heartbeats |

#### Approvals
| Command | Description |
|---------|-------------|
| `bus create-approval '<title>' '<category>' '<context>'` | Create approval request |
| `bus update-approval <id> <approved\|rejected> ['<note>']` | Resolve an approval |

#### Experiments
| Command | Description |
|---------|-------------|
| `bus create-experiment '<metric>' '<hypothesis>'` | Create experiment (auto-approval if configured) |
| `bus run-experiment <id>` | Start an experiment run |
| `bus evaluate-experiment <id> <pass\|fail> ['<notes>']` | Record experiment outcome |
| `bus list-experiments [--status <s>]` | List experiments |
| `bus manage-cycle` | Run the full experiment cycle |

#### Knowledge Base
| Command | Description |
|---------|-------------|
| `bus kb-query '<question>' --org <o> [--agent <a>] [--scope <s>]` | Semantic search |
| `bus kb-ingest <path> --org <o> [--agent <a>] [--scope shared\|private]` | Index documents |
| `bus kb-collections --org <o>` | List collections with document counts |

#### System
| Command | Description |
|---------|-------------|
| `bus self-restart --reason '<why>'` | Soft restart (preserves history) |
| `bus hard-restart --reason '<why>'` | Hard restart (fresh session) |
| `bus notify-agent <target> '<message>'` | Send urgent signal to agent |

---

## Dashboard API Endpoints

All routes require `Authorization: Bearer <token>` header (except `/api/auth/*`).

### Agents

| Method | Route | Description |
|--------|-------|-------------|
| GET | `/api/agents` | List all agents with heartbeat, role, status |
| GET | `/api/agents/[name]` | Get single agent details |
| POST | `/api/agents` | Create new agent |
| GET | `/api/agents/[name]/crons` | List agent's cron jobs |
| POST | `/api/agents/[name]/crons` | Create cron job |
| DELETE | `/api/agents/[name]/crons` | Delete cron job |
| POST | `/api/agents/[name]/lifecycle` | Start/stop/restart agent |
| GET | `/api/agents/[name]/logs` | Stream agent activity log |
| GET | `/api/agents/[name]/memory` | Read agent's memory file |
| POST | `/api/agents/[name]/typing` | Set typing indicator |

### Tasks

| Method | Route | Description |
|--------|-------|-------------|
| GET | `/api/tasks` | List tasks (filters: agent, status, org, priority) |
| POST | `/api/tasks` | Create task |
| GET | `/api/tasks/[id]` | Get single task |
| PATCH | `/api/tasks/[id]` | Update task status/fields |
| DELETE | `/api/tasks/[id]` | Delete task |

### Approvals

| Method | Route | Description |
|--------|-------|-------------|
| GET | `/api/approvals` | List approvals (filters: status, org) |
| POST | `/api/approvals` | Create approval |
| GET | `/api/approvals/[id]` | Get single approval |
| PATCH | `/api/approvals/[id]` | Approve or reject |

### Messages

| Method | Route | Description |
|--------|-------|-------------|
| POST | `/api/messages/send` | Send message to agent |
| GET | `/api/messages/history/[agent]` | Get message history (inbox + processed) |
| GET | `/api/messages/stream/[agent]` | SSE stream for real-time messages |
| POST | `/api/messages/upload` | Upload image/file for message |

### Analytics

| Method | Route | Description |
|--------|-------|-------------|
| GET | `/api/analytics/overview` | Aggregated metrics: tasks, events, cost, KPIs per agent |
| GET | `/api/events` | Recent activity events (filters: agent, category, days) |
| GET | `/api/events/stream` | SSE stream for real-time activity feed |

### Experiments (Theta Wave)

| Method | Route | Description |
|--------|-------|-------------|
| GET | `/api/experiments` | List experiments (filters: status, org) |
| POST | `/api/experiments` | Create experiment |

### Knowledge Base

| Method | Route | Description |
|--------|-------|-------------|
| GET | `/api/kb/search?q=<query>&org=<org>` | Semantic search across KB collections |
| GET | `/api/kb/collections?org=<org>` | List collections with document counts |

### Skills / Catalog

| Method | Route | Description |
|--------|-------|-------------|
| GET | `/api/skills` | List available skills and community catalog |

### Sync

| Method | Route | Description |
|--------|-------|-------------|
| POST | `/api/sync` | Sync file-system state to SQLite (tasks, approvals, events) |

### Goals / Org

| Method | Route | Description |
|--------|-------|-------------|
| GET | `/api/goals` | Read org goals from `goals.json` |
| GET | `/api/orgs` | List organizations |

### Auth / Mobile

| Method | Route | Description |
|--------|-------|-------------|
| GET/POST | `/api/auth/[...nextauth]` | NextAuth session management |
| POST | `/api/auth/mobile` | Mobile app token authentication |
| POST | `/api/notifications/register` | Register push notification token |

### Media

| Method | Route | Description |
|--------|-------|-------------|
| GET | `/api/media/[...filepath]` | Serve local media files (images, logs) |

---

## Shell Wrapper Scripts (`bus/`)

All scripts delegate to `dist/cli.js bus <cmd>` after sourcing `_ctx-env.sh` for environment variables.

| Script | Bus Command |
|--------|-------------|
| `send-message.sh` | `bus send-message` |
| `check-inbox.sh` | `bus check-inbox` |
| `ack-inbox.sh` | `bus ack-inbox` |
| `send-telegram.sh` | `bus send-telegram` |
| `create-task.sh` | `bus create-task` |
| `update-task.sh` | `bus update-task` |
| `complete-task.sh` | `bus complete-task` |
| `log-event.sh` | `bus log-event` |
| `update-heartbeat.sh` | `bus update-heartbeat` |
| `read-all-heartbeats.sh` | `bus read-all-heartbeats` |
| `create-approval.sh` | `bus create-approval` |
| `update-approval.sh` | `bus update-approval` |
| `create-experiment.sh` | `bus create-experiment` |
| `run-experiment.sh` | `bus run-experiment` |
| `evaluate-experiment.sh` | `bus evaluate-experiment` |
| `list-experiments.sh` | `bus list-experiments` |
| `manage-cycle.sh` | `bus manage-cycle` |
| `kb-setup.sh` | (direct Python, no bus equivalent) |
| `kb-query.sh` | `bus kb-query` |
| `kb-ingest.sh` | `bus kb-ingest` |
| `kb-collections.sh` | `bus kb-collections` |
| `self-restart.sh` | `bus self-restart` |
| `hard-restart.sh` | `bus hard-restart` |
| `browse-catalog.sh` | `bus browse-catalog` |
| `install-community-item.sh` | `bus install-community-item` |
| `prepare-submission.sh` | `bus prepare-submission` |
| `submit-community-item.sh` | `bus submit-community-item` |

---

## Agent Templates

Three templates ship in `templates/`:

### `templates/agent/`
General-purpose persistent agent. 24/7, Telegram-controlled, task-focused.
- `CLAUDE.md` — session start protocol, task workflow, messaging format, cron setup, restart procedures
- `IDENTITY.md` — name, role, personality (fill in for each agent)
- `SOUL.md` — values and operating principles
- `GOALS.md` — current objectives and KPIs
- `HEARTBEAT.md` — heartbeat protocol and cron configuration
- `MEMORY.md` — long-term memory index
- `USER.md` — user profile (who the agent reports to)
- `TOOLS.md` — available bus commands reference
- `SYSTEM.md` — system architecture notes
- `config.json` — cron definitions, max session seconds
- `.claude/settings.json` — hooks: plan mode approval, permission requests, ask-user-question, all routed to Telegram

**Skills included**:
- `skills/tasks/` — task lifecycle, KPI logging, stale task detection
- `skills/comms/` — Telegram and agent-to-agent message formats
- `skills/cron-management/` — cron setup, persistence, troubleshooting
- `skills/agent-management/` — spawn, enable, disable, restart agents
- `skills/m2c1-worker/` — autonomous software builds via M2C1 framework
- `skills/worker-agents/` — ephemeral worker session management

### `templates/orchestrator/`
Multi-agent coordinator. Manages task assignment, morning briefings, agent health.
- All agent files plus orchestrator-specific `CLAUDE.md` with 4 crons: morning briefing, task scan, evening wrap, agent health check
- `skills/agent-management/` — full lifecycle management for subordinate agents
- `skills/m2c1-worker/` — spawn M2C1 build sessions
- `skills/worker-agents/` — manage ephemeral workers

### `templates/analyst/`
Research and analytics specialist. Reads metrics, generates reports, tracks KPIs.
- 5 crons: weekly analytics, daily KPI scan, monthly cost report, experiment review, competitive analysis
- Ecosystem config for org-wide analytics
- `skills/agent-management/` — monitor and report on agent health

---

## Test Suite

**307 tests, 0 failures, 0 skipped.**

| Suite | File | Tests | Coverage |
|-------|------|-------|---------|
| Sprint 1 — Templates | `sprint1-templates.test.ts` | 24 | All template files, config schemas, no bash $CTX_FRAMEWORK_ROOT/bus/ references |
| Sprint 2 — Lifecycle | `sprint2-lifecycle.test.ts` | 8 | Agent enable, onboarding flag, config validation |
| Sprint 3 — Experiments | `sprint3-experiments.test.ts` | 12 | Full experiment CRUD, cycle management, approval gate |
| Sprint 4 — Catalog | `sprint4-catalog.test.ts` | 8 | Browse, install, prepare, submit community items |
| Sprint 5 — Metrics | `sprint5-metrics.test.ts` | 15 | Event aggregation, cost tracking, KPI scoring |
| Sprint 6 — Fast Checker | `sprint6-fastchecker.test.ts` | 18 | Telegram polling, callback routing, AskUserQuestion TUI |
| Sprint 7 — Environment | `sprint7-environment.test.ts` | 10 | CTX_ROOT resolution, env var parsing, path isolation |
| Sprint 8 — Dashboard | `sprint8-dashboard.test.ts` | 12 | Sync, SQLite integrity, API payload validation |
| Unit — Messages | `unit/bus/message.test.ts` | 22 | Send, receive, priority sort, format parity with bash |
| Unit — Tasks | `unit/bus/task.test.ts` | 9 | Create, update, complete, list with filters |
| Unit — Task Management | `unit/bus/task-management.test.ts` | 18 | Stale detection, archive, human tasks, backdated fixtures |
| Unit — Agents | `unit/bus/agents.test.ts` | 8 | listAgents, notifyAgent, heartbeat enrichment, IDENTITY.md parsing |
| Unit — System | `unit/bus/system.test.ts` | 6 | postActivity, env parsing, token validation |
| Unit — Daemon | `unit/daemon/*.test.ts` | 24 | FastChecker, message handling, callback routing |
| Unit — Hooks | `unit/hooks/*.test.ts` | 14 | Plan mode hooks, permission hooks, ask hooks |
| Unit — Utils | `unit/utils/*.test.ts` | 12 | Path resolution, atomic write, ID generation |
| Unit — Telegram | `unit/telegram/*.test.ts` | 18 | Message formatting, photo handling, keyboard markup |
| E2E — Lifecycle | `e2e/lifecycle.test.ts` | 15 | Full round-trips: message bus, task lifecycle, multi-agent coordination, approval workflow, format parity |
| Integration | `integration/*.test.ts` | 14 | CLI integration, bus command round-trips |


## Infrastructure

### CI/CD

`.github/workflows/ci.yml` — three-job GitHub Actions pipeline:

1. **`build`**: TypeScript type check (`tsc --noEmit`) + full build (`npm run build`) + CLI smoke test (`cortextos --version`)
2. **`test`**: Vitest full suite (depends on `build` job passing)
3. **`dashboard-build`**: Next.js type check + production build

Triggers: push to `main`, `feat/*`, `fix/*` branches; all pull requests.

### Directory Structure

```
cortextos/
├── src/
│   ├── bus/          # Core bus modules (message, task, event, heartbeat, approval, experiment, knowledge-base, agents, catalog, system, metrics)
│   ├── cli/          # CLI entry points (bus.ts, dashboard.ts, doctor.ts, ecosystem.ts, enable-agent.ts, init.ts, install.ts, list-agents.ts, list-skills.ts, notify-agent.ts, start.ts, status.ts, stop.ts, uninstall.ts)
│   ├── daemon/       # FastChecker daemon (Telegram polling, message routing, callback handling)
│   ├── hooks/        # Claude Code hook handlers (plan mode, permissions, ask-user-question, crash alert)
│   ├── types/        # TypeScript type definitions
│   └── utils/        # Atomic write, path resolution, ID generation
├── bus/              # Shell wrapper scripts (delegate to dist/cli.js bus)
├── dashboard/        # Next.js 14 dashboard (App Router, TypeScript, Tailwind)
├── templates/
│   ├── agent/        # General-purpose agent template
│   ├── orchestrator/ # Multi-agent coordinator template
│   └── analyst/      # Research/analytics agent template
├── skills/           # Community skills catalog
├── tests/
│   ├── unit/         # Unit tests (bus, daemon, hooks, utils, telegram)
│   ├── e2e/          # End-to-end lifecycle tests
│   ├── integration/  # CLI integration tests
│   └── sprint1–8/    # Sprint-level feature tests
└── .github/
    └── workflows/
        └── ci.yml    # Build, test, dashboard CI pipeline
```

---

## Migration Notes (from bash cortextOS)

The Node.js implementation is **format-compatible** with the bash reference implementation. All file formats match exactly:

- Message JSON: identical field set (`id, from, to, priority, timestamp, text, reply_to`)
- Task JSON: identical 17-field schema
- Heartbeat JSON: identical field set including `last_heartbeat`, `current_task`, `mode`
- Event JSONL: identical schema
- Approval JSON: identical schema (note: `rejected` not `denied`)
- Inbox filename convention: `{pnum}-{epochMs}-from-{sender}-{rand5}.json` matches bash

**One breaking difference from earlier Node.js versions**: task status was `'done'` in pre-release builds. The canonical value is `'completed'`, matching bash and dashboard. If you have existing task files with `"status": "done"`, run:

```bash
find orgs/*/tasks -name "*.json" -exec sed -i '' 's/"status": "done"/"status": "completed"/g' {} +
```
