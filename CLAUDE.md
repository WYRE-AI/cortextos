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
- **"Deliberately duplicated" code drifts silently — and the duplicate is where the bug survives.** `dashboard/src/lib/cron-utils.ts` carries a header saying it mirrors daemon logic and "any changes to the core parsing logic should be reflected here as well." PR #21 fixed cron-expression evaluation (local time → UTC) in the daemon and did not reflect it. Result: the daemon fired `0 9 * * *` at 09:00 UTC while the dashboard displayed 09:00 **local** — a 4-5h lie in the UI that no test caught because the dashboard had *two* inline copies of the evaluator and zero cross-implementation tests. Fix pattern: consolidate to one function per side, then add a test that imports BOTH and asserts equality. That test lives in the ROOT tree — a dashboard test importing root `src/` drags root files into the dashboard's lower-ES-target TS program and breaks `tsc --noEmit`.
- **Tests that assert superseded behavior fail only on hosts where the old and new semantics diverge.** The FM-8 block asserted local-wall-clock cron behavior and passed for anyone running UTC; it failed 1 test on EDT and 2 under `TZ=Pacific/Auckland`. When changing timezone/locale semantics, grep for tests deriving expectations from ambient `Date` getters (`setHours`, `getDay`) and pin them to absolute `Date.UTC` instants instead.
- **`Intl.DateTimeFormat.formatToParts()` is ~27x slower than native UTC getters** (measured: 9,382ms vs 340ms over 291K calls). It's the right tool for real timezone work but ruinous inside a per-minute scan. `nextFireFromCron` walks up to a year minute-by-minute, so a sparse expression cost seconds of CPU per computation until UTC got a getter fast path. Reach for Intl at the boundary, not in the loop.
- **Two flaky-test root causes worth recognizing:** (1) a test that leaves an unawaited infinite loop running — when `afterEach` calls `vi.useRealTimers()`, that loop becomes a REAL polling loop that degrades every later test in the file, so *which* test fails looks random; put teardown in `afterEach`, never at the end of the test body. (2) An endpoint doing O(items) full file reads where O(groups) would do — `GET /crons` re-read each agent's whole execution log once per cron (p50 1980ms → 166ms after one pass per agent). Both presented as "flaky perf tests" and were neither flaky nor about the tests.


## Learnings - 2026-08-14

- **A cancelled Anthropic subscription still AUTHENTICATES — the rotation preflight cannot see it.** `aaronmsachs-max20` was cancelled, yet a clean-room one-word opus `-p` ping returned `alive` exit 0, exactly like the three healthy accounts. It only fails on real workloads: hermes' 90k-token / 381-msg request got `rate_limit_error` (`req_011Ce2ms*`) while the 5-token ping sailed through. **The setup-token liveness ping proves the token authenticates, not that the account has capacity** — so `rotate-oauth` will happily rotate *onto* a cancelled account and report success. Corollary for diagnosis: "all accounts ping alive" is not evidence the credential layer is healthy; check a large-request log instead.
- **`rotate-oauth` cannot target a named account** — candidates are sorted by `five_hour_utilization`, which is permanently `0` for setup-tokens, so the order is arbitrary insertion order and it takes the first that pings alive. Off a dead account it lands wherever `Object.entries` points, *not* where you want. Fixed by adding `bus set-oauth-account <name>` (PR #91), which composes `setActiveAccount` + `writeTokenToAgents` so a manual switch still gets a `rotation_log` entry and `.env` propagation. Hand-editing `accounts.json` gets neither.
- **Hermes has its own token manager and it can silently pin to a dead account.** `~/.hermes/anthropic-rotate.py` (launchd `ai.hermes.anthropic-rotate`, every 900s) runs in `mode=follow-active` (track the fleet) or `mode=pin` (own rate pool, so it doesn't contend with the work fleet). It was pinned to `aaronmsachs-max20` and logged `already on aaronmsachs-max20, no change` every 15 min for hours *while the gateway was hard-failing* — the pin means fleet rotation does NOT rescue hermes. Fix is `anthropic-rotate.py pin <account>` (rewrites `.env`, `hermes auth reset anthropic`, restarts gateway). **When cortext and hermes break together, they are two separate credential paths that both need moving.**
- **5 of 14 enabled agents are outside the rotation mechanism.** `adoption`, `grower`, `infra`, `maintainer`, `marketing` have no `CLAUDE_CONFIG_DIR`, so per the 2026-07-14 note they prefer the shared keychain login over `CLAUDE_CODE_OAUTH_TOKEN` — a rotation cannot move them. They were verified clean (no limit banners) on 08-14, so the keychain seat is currently healthy; the latent risk is that when *it* dies, rotation won't help and the failure will look like a partial-fleet outage. `writeTokenToAgents` does append a token line to them, which is inert while the keychain wins.
- **An agent can poison its own context with malformed tool calls and imitate them across restarts.** `boss` spent the day emitting literal `<invoke name="Bash">…</parameter>` XML as assistant *text* instead of real tool calls — 74 occurrences, peaking at ~70% of all tool-call attempts. Every malformed emission is stored as an assistant turn, so `--continue` feeds them back as in-context examples and the model imitates its own bad output; the loop is self-sustaining and **no model swap or nudge clears it**. Repinning `boss` from `claude-opus-4-8` to `claude-opus-5[1m]` only halved the rate (70.6% → 46.7%) because the new model inherited the contaminated history. A `bus hard-restart --handoff-doc <path>` (fresh session, no `--continue`) took it to **0/22 tool calls**. Diagnostic: `grep -c '<invoke name=' <session>.jsonl` — the PTY log is useless here (ANSI stripping mangles it into the `Whatdoyouwanttodo?` shape), the **session jsonl is authoritative**. Cross-agent comparison is the fast discriminator: all 8 other agents scored 0 on the same day.
- **A publisher-layer fix is not live until you REPUBLISH — deploying the image does nothing to already-published pages.** The instatic iframe-embed fix (`08bd43c7`, outlet prop `richtext`→`richtextBody`) was verifiably inside the running image `001c2ea`, the container was healthy, both blog surfaces returned 200 — and iframes were still stripped. `escapeProps` runs at **publish** time, so every already-published page keeps the HTML it was sanitized into. A code deploy never re-renders it. **Verifying a deploy (image swapped, 200s, pages render) is NOT verifying a fix** — load content that actually exercises the fix. I reported "EMBED FIX IS LIVE" off deploy evidence and Aaron caught it still broken.
- **A CMS's `publishedAt` can be the IMPORT timestamp, not the editorial date — and a tie in the sort key silently degrades to row order.** Four blog posts shared `publishedAt = 2026-08-14T13:44:55` to the second (one import batch), so `orderBy publishedAt desc` was a dead tie and the blog rendered in insertion order. The real dates lived in a custom `pubDate` field the loop **cannot** sort on (unsupported keys are silently ignored, not errored). Discriminating test that saved the diagnosis: set the sort to a known-supported key (`slug`) and watch whether the order moves — that separates "this sort key is unsupported" from "the sort prop isn't applying at all."
- **A published site can render from a row's ACTIVE VERSION, not the row.** After backfilling `data_rows.published_at` and republishing, the order did not move. `data_row_versions` (reached via `data_rows.active_version_id`) carries its **own** copy of `published_at`, in a *different format* (`2026-08-14T13:44:55.186Z` vs `2026-08-14 13:44:55`). Both tables needed the backfill. If a data fix "lands" but the rendered output is byte-identical, suspect a versions/snapshot table before suspecting cache.
- **Coolify: the application payload has no storage field at all, so "0 persistent volumes" read from it is an ARTIFACT, not evidence.** Volumes live at `GET /api/v1/applications/{uuid}/storages` (`resource_type: App\Models\Application` = bound to the app, so a tag PATCH re-attaches them and data survives). Also: `GET /api/v1/deploy?uuid=` is the deploy **trigger**, not a read. Host `coolify-prod` (RG `RG-COOLIFY-PROD`) has no open SSH and no exec endpoint — reach it with `az vm run-command invoke`; host has python3+sqlite3, the instatic container has **bun, not node**.
- **UMBRELLA LESSON (ruby's synthesis, and the one to keep if you keep only one): a lookup succeeding is not evidence you got the thing you meant.** Every significant failure on 2026-08-14 was this same shape — a query that resolved cleanly and *answered an adjacent question*: the wrong GitHub namespace returned a real plausible PR; the wrong secret context returned "not found" (which reads as a real absence) or, worse, returned a credential that authenticated successfully against a different system; verifying a *deploy* answered "did the image change?" when the question was "does the fix work?"; and reading a Coolify app payload that has no storage field at all returned "0 volumes," which reads as real data. **Pin the context before trusting a result — `--repo` for namespace, `--context` for secrets, and for a fix, exercise the actual behaviour.** Be most suspicious of clean successes and clean absences, not of errors; errors announce themselves.
- **A broadcast claim needs its own verification, even when it comes from a trusted peer — and ESPECIALLY in a note about verification.** I took dev's "grandamenium is an unrelated project (Nostr relays, Slack adapters)" at face value, wrote it into this journal, and pushed it to 13 agents. It was wrong, and six agents copied it into their own GUARDRAILS.md before murph pushed back with a live check. One unverified secondhand sentence propagated to the whole fleet in minutes because it arrived inside an otherwise-correct lesson. **Relaying is not neutral: the moment you restate a peer's claim as fact in a broadcast or journal entry, you own it.** Cost of prevention was one `gh api repos/<org>/<repo>` call. Corollary that worked: correcting via the SAME channel, with the verification artifact (`fork=true, source=grandamenium/cortextos`) inline, got every agent self-corrected in one round — and analyst then re-verified independently rather than trusting the correction either, which is the behaviour to want.
- **The wrong-GitHub-org query is a systemic trap, because it returns a PLAUSIBLE answer instead of an error.** Three instances on 2026-08-14 across two agents: I queried `grandamenium/conduit` (404) and then `grandamenium/cortextos` — which *resolved*, to a real upstream open-source project with real PRs (Nostr relays, Slack adapters), so `gh pr view 93` cheerfully returned a CLOSED unrelated PR and I nearly acted on it. dev made the same error in the Friday wrap and under-counted cortextos merges 9 vs the true 17 (total 93 → 101). **Root cause (verified, and NOT what the first two of us reported): the shared local `cortextos` clone (`~/cortextos`) has THREE remotes — `origin=wyre-technology/cortextos`, `upstream=grandamenium/cortextos`, `fork=asachs01/cortextos`.** `gh api repos/wyre-technology/cortextos` returns `fork=true, source=grandamenium/cortextos`: **grandamenium/cortextos is our genuine UPSTREAM — the same project, 90 stars, actively pushed — not an unrelated one.** dev and I both initially mischaracterized it as a different project ("Nostr relays, Slack adapters"); those PRs are real (upstream #907 Nostr/NIP-29 adapter, #906 Slack Socket Mode) but they are *cortextOS upstream features we simply haven't pulled*, not evidence of a different codebase. murph caught this and was right to push back.

That makes the trap **sharper and more dangerous** than "wrong repo": it is the same project, forked, with **wildly divergent PR numbering** — upstream is in the 900s, our fork is in the 90s. So a given PR number resolves in BOTH, returns a real cortextOS-looking PR in BOTH, and reads as plausible in BOTH. That is exactly how `gh pr view 93 --repo grandamenium/cortextos` handed me a real CLOSED PR about skills (upstream's #93) when I wanted our #93 about OAuth. **Never infer "that PR is closed/merged/absent" without the namespace pinned.**

Corollary murph flagged, worth heeding: do NOT treat grandamenium as off-limits. It is the legitimate upstream and has real fleet business against it — murph's `task_1778946047536` is PR `grandamenium/cortextos#464`, which only Aaron can merge (no fleet merge rights upstream). (Sub-lesson: I missed the `upstream` line on my own first check because I ran `git remote -v | head -4` — truncating diagnostic output hides the exact thing you are diagnosing.) **Convention (infra's, better than remote-inference): pass an explicit `--repo <org>/<name>` on any `gh` call that feeds a conclusion, and fall back to `git remote -v` only when you genuinely must infer.** Explicit `--repo` removes the inference step entirely, so the query hits the right namespace regardless of what branch/remote/worktree the checkout happens to be on. This matters most for a COUNT or an ABSENCE ("no open PRs", "that PR is closed", "no such repo") — an absence from the wrong namespace is indistinguishable from a real one. Fleet-wide sweep after the broadcast: infra, forge, and scribe had all been passing explicit `--repo` and were unaffected; only remote-inference calls were hit.
- **Worse than a missing secret: a similarly-named secret in the wrong context that AUTHENTICATES AGAINST THE WRONG SYSTEM.** Three hits on 2026-08-14. (a) I reported `COOLIFY_API_TOKEN` absent — it was in `--context conduit`. (b) pearl reported no Stripe key at all — `CONDUIT_STRIPE_KEY` was in `--context conduit`; she found it minutes after the fleet broadcast. (c) dev got a hard 401 against blog-cms using `ANGELA_WYRE_AI_PASSWORD` (**default** context, a credential for **wyre.ai**) when the right one is `INSTATIC_ANGELA_PW` (**conduit** context, for **instatic**). Case (c) is the dangerous shape: the name looks right, the secret resolves, the call runs, and the failure surfaces as a plausible auth error rather than "no such secret" — so you debug the wrong thing. **Pair every secret with the system it authenticates to, not just its name, and confirm the context.**
- **`cortex-secret` has multiple contexts and "the secret does not exist" is usually the wrong context.** I told Aaron there were no Coolify credentials anywhere in scope; `COOLIFY_API_TOKEN` was in the **conduit** context the whole time, and my own MEMORY.md already recorded that exact lesson from a previous occurrence. Probe `cortex-secret list --context conduit` (and grep for `*_TOKEN` as well as `*_KEY`) BEFORE declaring a credential missing or filing a [HUMAN] task. Same class of error as querying `grandamenium/conduit` when origin is `wyre-technology/conduit` — **confirm the namespace before concluding absence.**
- **The instatic MCP does not need the interactive OAuth dance**: `BOUDICA_INSTATIC_MCP` (conduit context) is a PAT — POST JSON-RPC to `https://blog-cms.wyretechnology.com/_instatic/mcp` with `Authorization: Bearer`. But `site_*` tools still require a live **browser** Site-editor session (`siteConnected`) and `content_*` require the Content workspace; opening Preview **drops** the editor connection, and Publish demands a password re-confirmation.
- **"Agent not responding" has at least three distinct causes that look identical from Telegram.** On 08-14 boss hit two at once: (a) outbound `send-telegram` tool calls failing to parse, so composed replies never left the box, and (b) an inbound message stranded *unsubmitted* in the PTY input box — `injectMessage` (`src/pty/inject.ts:91`) pastes then fires Enter on a fixed 300ms `setTimeout`, which loses the race when the TUI is busy (stop hook running). Neither raises an error; the daemon logs `Injected N bytes` and ACKs the inbox either way. Triage order: is the process alive (`pgrep -P <daemon-pid>` + match by `lsof` cwd — the cmdline does **not** contain the agent name), then does the session jsonl advance, then compare last successful `send-telegram` against last inbound `user` entry. Tracked as bus tasks `…53511893` (inject race) and `…76411072` (restart misreport).

## Learnings - 2026-08-15

Written by `marketing`. Findings are attributed — several are `grower`'s, `infra`'s, or `boss`'s, and
several of mine were corrected by them mid-thread. Every claim below carries its artifact or is labelled
UNVERIFIED. **VERIFIED = measured this day with the command output in hand.**

- **A NEW EXHAUSTION MODE THAT OUR DOCUMENTED TRIAGE RECIPE READS AS CLEAN.** `maintainer` was dead for
  ~11h (conduit prod monitoring dark from `02:41:29Z`) answering **every** cron with the synthetic string
  `You're out of usage credits… Fable 5 or /model to switch models` — 69 occurrences, `02:51:08Z →
  13:42:25Z`. **This is CREDIT exhaustion, not the 07-14/07-15 rate-limit mode.** Running the documented
  07-14 diagnostic verbatim — ANSI-strip `stdout.log`, grep `weekly limit`/`rate limit`/
  `Whatdoyouwanttodo` — **returned ZERO hits on an agent dead eleven hours.** A triage recipe that reads
  clean on a corpse is worse than no recipe, because clean is the reassuring answer.
  **It was also NOT WEDGED:** it replied within a second every time, session jsonl advancing,
  `type=<synthetic>`. **Every liveness check keyed on "is it responding" reads healthy.** It was
  responding perfectly and doing nothing.
  **Remedy is RESTART — verified 4/4**, all four affected agents recovered by restart and beating after
  it: `grower` 05:07:00Z, `adoption` 05:51:28Z, `marketing` 13:42:36Z, `maintainer` 13:58:50Z. `model` is
  unset in every config, so a restart re-resolves off the exhausted Fable-5 pool onto `claude-opus-5`.
  `maintainer` had last restarted `00:28Z`, *before* onset — the entire reason it was the one that stayed
  dead for 11h. **Pool is per-model, NOT shared** (infra) — a dying agent here is not a fleet
  leading-indicator.
  **Discriminator for counting incidence (infra's — adopt it, and do not use a plain grep):**
  `message.model=="<synthetic>" AND isApiErrorMessage`; real errors carry `apiErrorStatus`/`requestId`,
  an agent merely *discussing* the outage is `type:"queue-operation"`. **A defect-string grep cannot tell
  a defect from a discussion of it.** infra's second scan counted its own outbound messages; and when I
  re-verified the 4/4 above with a naive grep it returned `marketing`=14 hits / `grower`=3 — **all of
  them agents writing about the incident, with ZERO real errors under the discriminator.** The naive
  instrument would have reported three of four agents still failing, *while they were demonstrably
  healthy and talking to each other about it*. Third time this same instrument misled someone in one day.

- **THE HANG DETECTOR HAS A DETERMINISTIC BLIND SPOT: any agent whose tightest cron interval ≤ `graceMs`
  (15 min) is effectively immune to being flagged hung — detection is delayed by HOURS, not prevented.**
  *(Corrected 14:1xZ by `maintainer`, the agent it landed on, from its own daemon log — the original
  wording here said "can NEVER be flagged" and that is too strong. **It flagged exactly once**:
  `daemon-out.log:49652`, `Hang detected for maintainer… delivered fire 13:42:24.579Z + 15m elapsed`,
  auto-restart 8s later at 13:57:32.827Z — **onset-to-detection 11h06m17s**, count of that string in
  the whole log: 1. Escaping requires a GAP between fires exceeding `graceMs`; it only broke out when
  a fire finally landed late. **Do NOT encode "never flags" in a regression test — such a test PASSES
  on the broken code and FAILS on a good fix. Assert BOUNDED DETECTION LATENCY from onset instead.**)*
  `hang-detector.ts:153` sources `T` from **`last_fire_attempted_at` — ATTEMPTED, not consumed** — so a
  dead agent keeps a perfectly fresh anchor. Measured on `maintainer`: `T=13:42:24Z`, `now-T=15.0min`,
  `graceMs=15.0min` (`fast-checker.ts:1540`) → `evaluateHang:176` returns `within grace → NOT HUNG` on
  every poll, forever, **never reaching line 183 where the beats are compared.** Its circuit file showed
  `consecutiveWithoutBeat:0` not because it believed the agent was beating but because it never looked.
  **The perverse half: MONITORING AN AGENT MORE CLOSELY MAKES IT LESS DETECTABLE.** `maintainer` earned
  its invisibility by having the tightest cadence in the fleet.
  Both anchors failed independently — `evaluateBootstrapHang` keys on `.restart-time` (`R=00:28Z`) and a
  beat *did* land after `R` (02:51Z), correctly returning "not a bootstrap hang." **It booted fine (kills
  the restart anchor) and had a 15m cron (kills the fire anchor), so it fell in the gap between both.**
  **FLEET EXPOSURE MEASURED: exactly ONE agent — `maintainer` (`trigger-scan=15m`). All 14 others are
  ≥4h and CAN be flagged.** Real defect, blast radius currently one. Note for the fix: infra's `maxBeat`
  masking (`S = max(session_heartbeat, idle_flag, activity_flag)` — one fresh signal hides a 13h-stale
  heartbeat) is TRUE but sits *behind* the returning branch. **Fix only line 176 and widening grace makes
  infra's branch live — same outage, different line number.**

- **REMEDIATION DESTROYS THE EVIDENCE — and the resulting error is CONFIDENT, not noisy.** (infra's name
  for it; my instance was the purest.) I scanned the **newest session file per agent** for incidence.
  **A restart CREATES a new session file, and restarting is exactly what CURED the failure** — so every
  recovered agent presented a clean newest file and only the never-recovered one still carried errors.
  I filed **"sole affected agent"** while being *in* the affected set (4 agents hit at `02:51Z`:
  adoption, grower, marketing, maintainer). **My sampling frame was ANTI-CORRELATED WITH THE PHENOMENON,
  so it returned a confident wrong answer rather than a gap.**
  **General rule: ANY per-session or per-run sampling frame is blind to failures whose remedy starts a
  new session or run.** Corollary: **the more effective the remedy, the more completely it erases its own
  case history** — count incidence on an axis the remedy does not touch (heartbeat/state files and
  daemon-side cron records survive a restart; transcripts do not). Fifth instance of this shape today.
  Sharpest detail: **I wrote "restart alone will not fix it" from a session that only existed because a
  restart had fixed it** — my own restart stamp `13:42Z` was in infra's recovery table. `grower` likewise
  spent the day treating its `05:07Z` boot as routine; it was recovery from an outage it never knew it
  was in.

- **`BUS_ONLY` ⟺ empty `BOT_TOKEN` ⟺ absent `CLAUDE_CONFIG_DIR` — perfect 5/5 and 10/10** (adoption,
  grower, infra, maintainer, marketing; `dev` verified as control). Per 07-14, no `CLAUDE_CONFIG_DIR`
  means the **keychain login wins over `CLAUDE_CODE_OAUTH_TOKEN`, so rotation cannot move those five** —
  yet all 15 carry a token line, **so rotation writes it, succeeds, and moves nothing.** *(The
  keychain-beats-env behaviour itself is INHERITED from 07-14 and was NOT re-measured — the single
  load-bearing unverified step. The precondition is now airtight, see next bullet.)*
  **The five that rotation cannot rescue are exactly the five with no Telegram to shout on** — and
  `maintainer` is one of them, which is why an 11h outage surfaced only as an absence. infra's sharpening:
  `account-preflight.ts:30` **deliberately** mkdtemps a clean-room `CLAUDE_CONFIG_DIR` *so the keychain
  cannot answer* — **the isolation that makes the preflight trustworthy for everyone else is exactly what
  makes it non-predictive for those five.** Rotation isn't buggy; it makes a true statement about a
  different system.

- **`CHAT_ID` is set to the SAME value on all 15 agents — it has ZERO discriminating power as a channel
  tell**, not merely false-positive. Only `BOT_TOKEN` having a *value* separates bus-only from
  Telegram-capable. Related: **the daemon's restart directive is templated and orders a `send-telegram`
  first call even on bus-only agents** (fails, exit 1). **A boot directive is a description of what the
  system is for — never evidence about your own configuration.**

- **WHEN AN ARTIFACT IS UNOBSERVABLE, READ THE CODE THAT CONSTRUCTS IT.** `ps eww` returns nothing
  readable on darwin, so "does the daemon inject `CLAUDE_CONFIG_DIR`?" looked unanswerable. It is settled
  in one read: `agent-pty.ts:368 getBaseEnv()` is an **explicit `keepVars` allowlist** that does *not*
  spread `process.env`, and the var is not in it — so the daemon **cannot** inject it even if it carried
  it. **Construction RULES OUT cases; observation only FAILS TO FIND them.** Same shape as the detector
  bug one level up: `T` was measured on `last_fire_attempted_at`, an axis the failure cannot touch, so it
  stayed fresh while everything real froze — **the signal was measured on the wrong side of the event.**

- **THREE CONSECUTIVE INSTRUMENT FAILURES WHILE CHECKING AN INSTRUMENT FAILURE** (infra, verbatim,
  because the sequence is the point). Task: does `list-approvals --status` exist? TOOLS.md documented
  it; it does not.
  1. `... 2>&1 | head -1` — the error was not on line 1, so it reported **ok**.
  2. A shell loop passing the whole argument string as ONE option — commander reported
     `unknown option '--status pending --agent infra'`, so **all three** documented `--status` flags
     came back broken.
  3. Direct invocation **with a known-good control** (`list-tasks --status`, which does work) — the
     true answer: **only `list-approvals` lacks it**; `list-tasks` and `list-experiments` have it.

  **Without the control I would have shipped "three CLI flags are wrong" when ONE was** — a
  documentation fix that broke two working flags, in a fleet-read file. **A control separates a real
  defect from a broken probe, and nothing else does.** Note this happened while running a check
  prompted *by* the instrument lesson, minutes after writing that lesson into this very file:
  **A LESSON DOES NOT INSTALL FROM BEING WRITTEN DOWN. IT INSTALLS FROM A CONTROL.**

- **APPLY THE PERISHABILITY RULE FORWARD, NOT AFTER THE BREAK.** Correcting TOOLS.md, infra noticed
  the correction *itself* would be **falsified by a pending fix** — `maintainer`'s CLI PR ADDS a real
  `--status`, so a standing fact reading "it does not exist" goes false the moment that merges, and
  would read authoritative right up until it silently was not. Written instead as a **stamped
  observation + a re-derive command + an exit-code test**. **Use that shape for any doc claim about
  tooling behaviour that a known open PR will change.** Third stale-but-authoritative record caught
  within the hour — and the only one caught *before* it was written rather than after.

- **IN A SHARED CHECKOUT, BRANCHING DOES NOT PROTECT WORK — ONLY A COMMIT DOES.** (`maintainer`'s
  finding; `infra` reproduced it in an isolated sandbox.) `maintainer` ran `git checkout -b` *before*
  writing a line and believed the work was branch-isolated. It was not: **uncommitted changes FOLLOW
  a branch switch**, so when another agent switched the shared checkout back to `main`, 145 lines of
  in-progress CLI work came with it — and **neither agent got an error**. Reproduced cleanly:
  ```
  on branch: feature, dirty:  M f.txt
  after switching back: branch=main dirty= M f.txt   <- change followed, silently
  ```
  **`git checkout -b` protects nothing while the tree is dirty.** The next agent to switch branches
  drags your changes with them, and the belief *"I branched first, so I'm isolated"* is one several
  of us likely hold. **15 agents share one working tree: commit or stash, never merely branch.**
  Recovery is `stash → checkout branch → stash pop`. Found only because a dirty tree was noticed and
  someone bothered to work out **whose** it was.

  **HAZARD AND REMEDY DEMONSTRATED BACK TO BACK ON THE SAME TREE, ~10 MINUTES APART.** Within the
  hour the checkout moved *again* — onto `infra`'s branch, under `maintainer`, mid-session — and a
  test file on disk reverted to its pre-fix import. **Nothing was lost, only because the work was by
  then committed and pushed.** The identical tree movement that would have eaten it an hour earlier
  was a non-event. **`infra` had the same near-miss from the other side:** branched `CLAUDE.md`
  specifically to protect a peer's 96 lines, with the tree already dirty, and survived on a
  ~90-second margin before committing — **the version where the rule-follower loses someone else's
  work while believing they had just rescued it.**

  **THE STRUCTURAL FIX ALREADY EXISTS AND SEVERAL OF US ALREADY USE IT — it just never became
  convention: a WORKTREE.** A worktree is a separate working directory, so **nothing follows a branch
  switch at all** and the hazard cannot arise. `git worktree list` on this repo returns **17**
  (verified independently by `boss`, then re-run by `infra` rather than relayed — analyst 2, infra 1,
  dev 2, murph 1, `.worktrees/` 5, `.claude/worktrees/` 3, plus external ones). **Only the primary
  checkout itself — the tree the fleet shares, sitting on `main` — is shared, and that is exactly
  where every incident above happened.**
  **⚠ THE PATH LIST READS AGAINST ITSELF — 8 of the 17 sit UNDER the primary repo path**
  (`<primary>/.worktrees/…` ×5, `<primary>/.claude/worktrees/…` ×3), so skimming the paths
  suggests they are *inside* the shared tree and therefore exposed. **They are not.** Verified
  directly: primary tree is `main` @ `269bef42`, while `.worktrees/log-surface-docs` is on
  `fix/log-surface-docs` @ `bc36053f` — **different branch, different HEAD, same parent directory.**
  Its `.git` is a `gitdir:` pointer file rather than a directory, and `.gitignore:60` excludes
  `.worktrees/` outright, so the primary tree cannot even see it, let alone drag it. **Nested by
  path, independent by construction.** (`maintainer`'s catch — the one place the evidence for this
  entry reads as the opposite of the truth.)

  **Commit-early is the backstop; the worktree is the fix.**

  Sharpest detail, and it is about behaviour rather than tooling: `infra` **did** spin up a worktree
  that same afternoon — for a read-only run of an unmerged drift tool — and did **not** use one when
  editing `CLAUDE.md`, which is where the actual risk was. **The safe pattern was reached for on the
  safe task and skipped on the risky one**, because the worktree was chosen to isolate *someone
  else's unmerged code*, not to protect *our own uncommitted work*. The tool was already habit; the
  threat model was not.

- **A WRONG LINE NUMBER DOES NOT 404 — IT RESOLVES.** (infra's catch, on this very entry.) Two of the
  source refs written above were wrong when first committed: `:181` for the beat comparison (it is the
  `S === null` **fail-safe return**; the comparison is `:183`) and `:150` for the `T` read (that is the
  function declaration; the read is `:153`). **Neither would have errored.** A reader following `:181`
  opens real code, in the right file, in the right function, reads a plausible fail-safe branch, and
  concludes something coherent and false. Same shape as the 08-14 wrong-GitHub-namespace trap (a real
  PR, in a real repo, with the wrong number) and the wrong-secret-context trap (a real credential that
  authenticates against the wrong system). **HEDGING THE CLAIMS DOES NOTHING FOR THE POINTERS** — this
  entry is the most carefully qualified thing either of us wrote all day, every claim carrying its
  artifact or an UNVERIFIED label, and it still shipped two bad pointers, because the hedging was
  applied to the assertions and not to the coordinates. **Check refs against the file before
  committing anything fleet-read; a pointer is a claim.** Caught only because the entry was read
  end-to-end before being committed, rather than trusted as a peer's finished work.

- **METHOD, earned three times today: a narrowed hypothesis is a place to point an instrument, never a
  thing to forward.** Two competing root causes for the missed detection were both forwarded before being
  tested (grower's `T===null`; my `last_idle.flag` masking) and **both were wrong**; the branch that
  actually ran was found by reading the source and computing the numbers. I killed my own guess in ninety
  seconds by measuring instead of sending — then shipped a *worse* error through an instrument I had
  never audited. **Not forwarding hypotheses is necessary and NOT sufficient: the measurement instrument
  needs the same suspicion as the inference.** Net for the day: **every measurement held; every inference
  hung on one died — and this time the instrument itself was the liar.**

## Learnings — 2026-08-15 (evening, 17:00–18:30Z)

Written by `infra`. Requested by `boss` for the 23:00Z review. Attributions are explicit: several
below are `grower`'s or `boss`'s, and three are corrections to my own claims made the same hour.
**VERIFIED = measured this evening with the command output in hand.** Every unverified step is
labelled.

- **A FIXTURE SET SAMPLED FROM LIVE CONFIGURATION IS BLIND TO EVERY CONFIGURATION THAT HAS NOT
  HAPPENED YET — the case that breaks you must be SYNTHESISED, not sampled.** I shipped a fleet
  monitor at 17:0xZ with 7 mutation-validated controls. **It produced a false positive on its first
  production fire at 18:11Z**, reporting `maintainer — no enabled heartbeat cron` about a
  demonstrably live agent (activity flag 11 min old). Root cause: `parse_cadence` handled only
  interval schedules (`4h`), returned `None` for a cron expression, and the caller **collapsed
  "cannot parse this schedule" into "has no heartbeat cron"** — two different conditions, one
  message. **No test could have caught it: when the suite was written every agent in the fleet was
  `4h`, so no fixture drawn from live state contained a cron-expression heartbeat.** The
  distinguishing case did not exist to be sampled.
  **The same monitor had already hit this exact shape hours earlier and I still failed to generalise
  it.** Enumerating agents from `state/*/heartbeat.json` makes an agent that has **never beaten**
  *absent* rather than flagged — **the enumeration axis is created by the very act whose absence is
  being detected** — so the fix was to enumerate from the roster and look the heartbeat up. **Both
  readings produced byte-identical output on the live fleet**, so only a *synthesised* never-beaten
  agent could distinguish them. **Twice in one evening, the same blindness: a fixture drawn from
  current state cannot see the case that current state does not contain.**

- **AND THE PAIRING, WHICH IS THE PART TO KEEP: MY OWN BROADCAST LESSON PRODUCED THE INPUT MY OWN
  TOOL MISREAD.** An hour before that fire I told the fleet that an interval cron **re-phases on
  every edit** (below) and that anything whose phase carries meaning should be a cron expression.
  `maintainer` converted its heartbeat `4h → 51 */4 * * *`. **The monitor then reported the agent
  that took my advice as broken.** A monitor written against the configuration style of its moment
  **punishes exactly the agents who adopt your guidance** — improving the fleet changed the fleet
  out from under the instrument measuring it.
  **What stopped it reaching anyone was instruction-at-point-of-use:** the cron prompt I had written
  says *"verify the flagged agent against `last_activity.flag` and the session jsonl BEFORE alerting
  — a mid-cadence agent is not wedged."* I followed it, read the agent's raw `crons.json` instead of
  trusting my own classifier, and the alert died. **That construction is the one that survives an
  author who is wrong.** Second time in one evening it paid.
  Note it also landed `grower`'s MANDATORY CAVEAT — *a control that false-positives trains people to
  ignore it* — **on the first production fire**, which is the worst time for it and the best time to
  learn it.

- **AN INTERVAL CRON'S PHASE IS SET BY ITS LAST EDIT; A CRON-EXPRESSION'S PHASE IS PINNED TO THE
  CLOCK.** `add-cron` refuses to overwrite, so changing a prompt means remove-and-add — **which
  resets the interval clock and silently re-phases the cron.** `boss` hit it: editing
  `check-approvals` moved its fires from 18:14/20:14Z to 19:20/21:20Z, **destroying a backstop they
  did not know they had.** I had done the identical thing seven minutes earlier and missed it — my
  own cron moved `18:11Z → 18:13Z` and **I had the before and after in one session, two minutes
  apart, and read neither**, because I was verifying the text I had changed and the phase moved as a
  *side effect* of the edit rather than as its content. **Two edits made to IMPROVE instruments,
  both silently degrading a DIFFERENT instrument, twenty minutes apart.**
  **RULE: any cron whose PHASE carries meaning — staggering, stampede avoidance, covering a window —
  must be a cron EXPRESSION, never an interval. Prompts get edited.**

- **AN UNDERSTATED CAVEAT IS ARMOURED AGAINST CHALLENGE, AND IT RECRUITS THE READER AS A DEFENDER.**
  (`boss`'s naming; my error.) I documented a monitor's limitation as *"it cannot detect infra."*
  **False** — it enumerates the roster and infra is in it. The real hole is **execution**: a wedged
  host never runs the cron, and **exit-0 silence is byte-identical to a clean fleet.** I had stated a
  **smaller and more flattering** limitation than the truth; boss quoted it back approvingly and
  wrote it into their own record as a virtue. **Overclaiming invites correction; modesty invites
  agreement.** Worse than a stale caveat, because nobody re-audits a limitation that reads as
  humility.
  **OPERATIONAL FORM: when a caveat can be read two ways, the honest version is the one that
  describes the failure you would NOT catch.** A missing row is a gap someone eventually notices; a
  silent monitor is one nobody ever does.

- **AN OBSERVER DRAWN FROM THE OBSERVED POPULATION SHARES ITS FAILURE MODES.** (`grower`'s.) Two
  independent sweep observers now run on different hosts, and **the pair still does not close**,
  because both are agents on the same credit pool. **Existence proof, not tail risk: the 02:51Z
  exhaustion took four agents at once, and `grower` — host of observer 2 — was one of them.** The
  close-out is a **non-agent host** (launchd/crontab): outside the population, cannot be
  credit-exhausted because it never calls a model.
  **Rejected intermediate, and the reasoning is the keeper:** emitting a positive per-run signal so
  absence becomes detectable **regresses** — the emission dies with the host, and then something must
  watch for the missing emission. **The regress terminates only at a host that cannot fail the same
  way**, never at a cleverer signal.

- **A RECONCILIATION IS ONLY AS GOOD AS THE UNIT IT COUNTS — A COUNTER COUNTING THE WRONG UNIT STILL
  RETURNS A CONFIDENT NUMBER.** I told `forge` to verify a rebase by reconciling a **count of
  bullets** in the CHANGELOG Unreleased section, because a conflict resolved by taking either side
  silently drops an entry. **The entries in the two PRs are not bullets** — they are `### Fixed —
  <heading>` sections with prose. My counter returned `main=89, pr101=89, pr102=87`, reading as
  **exactly the dropped-entry failure I had warned about an hour earlier.** I was one message from
  accusing forge of eating my entries. **Nothing was lost.**
  **A second instrument compounded it:** my confirming grep used a **hand-typed** needle —
  `"approval category"` against a heading that reads `"a category the CLI rejects"`. Zero hits, which
  reads as a missing entry rather than a bad search string. **Two instruments agreed and both were
  wrong, and their agreement carried no more information than either alone** — which is, word for
  word, the defect PR #102 documents about the cron-state path. **I reproduced the bug described in
  the PR while verifying that PR.**
  **NEVER HAND-TYPE THE NEEDLE.** Extract it from the diff; test the **merge result**
  (`git merge-tree --write-tree`) not the branch tip; and carry a **positive control** on a
  known-present entry, because without one a zero cannot be told from a broken grep.
  **What caught it was not the control** — it was refusing to forward a surprising number before
  understanding the unit. The control only confirms once you are already suspicious; **something has
  to make you run one.**

- **A BROKEN PROBE THAT RETURNS THE ANSWER YOU EXPECTED IS THE ONE THAT SHIPS.** (`boss`'s, and the
  right counterweight to the entry above.) Verifying a premise, boss ran `grep -r --include=*.ts`
  **unquoted under zsh**; the glob failed to expand, **grep never ran, and the script printed
  `count: 0`.** A zero produced by a command that did not execute, about to be read as evidence a
  thing does not exist. Caught only because the number looked too clean — then rerun quoted **and
  with a control term known to hit** (25 hits), which is what proved the probe live and the zeros
  real. **My false positive announced itself; boss's broken probe agreed with them.** The failure
  that agrees with your prior is strictly more dangerous than the one that contradicts it.

- **A TEARDOWN TRIGGER BELONGS ON THE PERMANENT THING, NOT ON THE TEMPORARY ONE.** A stopgap task
  ends; the crons it created do not. Storing "delete this when X ships" on the stopgap **consumes the
  instruction when the stopgap closes**. It has to live where whoever picks up the permanent work
  will be standing. **General form: any temporary thing needs its removal instruction stored where
  the PERMANENT thing will be picked up.** Guard it with **merged is not built** — verify against the
  *running* daemon, not the merge, or the stopgap comes out while the hole is still open.

- **MERGED IS NOT BUILT, MEASURED: SEVEN PRs MERGED AND NONE LIVE.** After a backlog burn-down,
  `dist/` remained the 15:17:34Z build while `main` advanced through #101 #102 #104 #106 #107 #109
  #110. **Two consequences that bit the same evening:** (a) #107 — the fix stopping bus-only agents
  being ordered to send Telegram on boot — is merged and **not live**, so the next restart of any
  bus-only agent still fails exit 1, and **the author of that fix is the person most likely to read
  the merge as the fix**; (b) **the shared tree MOVED under me** (`e8ff2dff → 4d6d1c4b`, not by me —
  clean tree, no git writes), so a standing note recording the gap as *"benign pull drift, dist
  matches local HEAD"* **went false without anyone editing it.**
  **CORRECTED 18:2xZ, after this entry was merged — the original claim here was mine and it was
  overstated.** I wrote that #110, which refines `deploy-drift-check`, "was sitting in the unbuilt
  gap — **a diagnostic cannot diagnose its own non-deployment**," and called it a second instance of
  a tool blind to the condition it exists to detect. **I never ran the tool before writing that.**
  Run afterwards, the **pre-#110** check reports:
  `build_drift: {stale: true, built_sha: e8ff2dff, reason: "built from a different commit than local
  HEAD — run npm run build"}`. **It diagnoses its own non-deployment precisely** — built sha, local
  head, and the remedy — and the pull-vs-build split it uses **predates #110** entirely. What #110
  actually adds (`src/bus/system.ts`, +48) is a `drift_kind` classifier and a *behind*-vs-*divergent*
  distinction with a sharper reason string. So #110 being unbuilt is true and worth recording; **the
  aphorism was false.**
  **What is actually true, and still worth keeping: A TOOL CAN REPORT ITS OWN STALENESS ACCURATELY
  AND STILL BE THE STALE VERSION OF ITSELF.** The fix for a diagnostic is not live until it is built,
  and the *un*fixed diagnostic will keep telling you so — correctly, and less precisely than the
  version you merged.
  **Why it survived to be merged, which is the part that belongs in a journal about verification:**
  it *paired* with the monitor-cannot-observe-its-own-wedge finding from the same evening, and the
  symmetry is what stopped me checking. **An aphorism that completes a pattern is the claim least
  likely to be tested** — it arrives feeling already confirmed. I asserted it twice to `boss` before
  reading #110's diff. Note the axis, too: this entry's own lesson is that an *understated* caveat is
  armoured against challenge. **This one OVERCLAIMED — the failure mode that invites correction — and
  it still took four hours and a merge to get one.**

- **AN AUTOMATION IS A THIRD ACTOR IN A SHARED REPO — "who changed this" is not answered by asking
  the agents.** Two PR branches were rebased at `17:29:13Z` and `17:29:21Z`, **eight seconds apart**,
  `author=Aaron Sachs, committer=codesmith-bot`. Neither agent in the conversation did it: one had
  discarded their worktree, the other had a clean tree and had run no git writes. **A peer
  attributed the push to me and I nearly accepted it, because the outcome was the one I wanted.**
  What prevented data loss was that peer **checking the remote before force-pushing** — and the
  reason that instinct paid is that **they had no reason to expect a third writer.** Check the remote
  before overwriting it precisely when you are confident nothing changed.

  **⚠ CORRECTED 2026-08-16 — THE ADVICE ABOVE, FOLLOWED LITERALLY WITH `--force-with-lease`, REMOVES
  THE PROTECTION. Read this before acting on it.** (infra, who did exactly that.) Rebasing #122 I ran
  `git fetch`, SAW the remote had moved — `c3e9aed8 → 4459ba7d`, a forced update I did not make,
  `committer=Codesmith` — and then pushed with `--force-with-lease`, **which did not stop me.**

  **MECHANISM: the lease compares against your REMOTE-TRACKING REF, and `git fetch` refreshes that ref
  to whatever is now on the remote.** So fetching *in order to check the remote* is precisely what
  makes the lease vacuous. **The safety check disarms the safety mechanism.** Not a stale reading —
  a **fresh** reading that invalidated the guard *by being fresh*.

  **TWO CORRECT FORMS. Use one:**
  ```bash
  # (a) capture the sha BEFORE fetching, then pin the lease to it
  OLD=$(git rev-parse origin/<branch>)      # before any fetch
  git fetch origin <branch>                  # inspect freely; the lease no longer depends on it
  git push --force-with-lease=<branch>:"$OLD"
  # (b) or do not fetch at all — let the stale tracking ref BE the lease
  git push --force-with-lease
  ```

  **AND THE THIRD ACTOR IS CURRENT, NOT HISTORICAL:** `codesmith-bot` rebased branches at
  `2026-08-15T17:29Z` **and again at `2026-08-16T12:30:48Z`**, the second time producing its own
  rebase of an agent's commit onto the same main. Assume it is active whenever you force-push.

  *(No content was lost in the 08-16 instance — both resolutions carried identical 79-heading sets and
  differed only in entry order — but that was established **after** the overwrite, not a risk avoided.)*

  ### ⚠ FOLLOW-UP, 2026-08-16 13:3xZ — five corrections that arrived AFTER #125 merged

  Written by `boss`, who wrote the entry above and got two things in it wrong. **Every measurement below
  was made by `grower`, `infra` or `marketing`; I ran none of them and I am relaying, so they are
  attributed individually rather than absorbed into the entry.** The one thing I verified myself at
  write time is the config value: `git config --global --get push.useForceIfIncludes` → `true`,
  git 2.55.0.

  **1. THE REAL FIX IS THE CONFIG, AND FORM (a) ABOVE SILENTLY DISABLES THE THING THAT SAVES YOU.**
  The two forms above are still correct *about the lease*. What they omit is that
  `push.useForceIfIncludes=true` (now set globally on this box) adds a **second, independent** guard,
  and **supplying an explicit expect value turns that second guard off.**
  🔑 **`grower`'s narrowing, which corrects my own earlier wording: the no-op attaches to SUPPLYING AN
  EXPECT VALUE, not to the `=` syntax.** They ran `--force-with-lease=main --force-if-includes` — refname,
  **no** `:<expect>` — and if-includes **did** fire. So *"never combine if-includes with the `=` form"* is
  the natural over-reading of what I sent the fleet, **and it is wrong.** The no-op is
  `--force-with-lease=<ref>:<EXPECT>` specifically. ⟹ **Prefer bare `--force-with-lease` with the config
  on; reach for form (a) only when you genuinely want to pin a sha, and know you are giving up
  if-includes to do it.**

  **2. 🔴 THE REFLOG CAVEAT IS RETRACTED — DO NOT PROPAGATE IT.** `infra` had warned that because
  if-includes is reflog-based, protection might be **weakest in a fresh clone or worktree — exactly where
  third-actor exposure is highest.** That was **inferred from the man page's wording, not measured**, and
  `infra` then measured it against a control and retracted it. Clean room, reflog for `main` **wiped to 0
  entries**, lease provably vacuous:
  `config ON → REJECTED, peer commit SURVIVED` · `CONTROL, config OFF → forced update, peer commit
  VERIFIED DESTROYED`. **Protection holds with an EMPTY reflog.** `marketing` reached the same direction
  independently from the other end (fresh clone / `worktree add` carry 1–2 entries, not zero, and the
  flag fired correctly there) — a minimal reflog makes the check **fail closed**, which is the safe
  direction. **Scope, held deliberately: BEHAVIOUR established, MECHANISM not.**
  🔑 **`infra`'s reason for retracting is the keeper and generalises past git: AN UNWARRANTED WARNING
  ATTACHED TO A WORKING CONTROL TEACHES PEOPLE TO DISTRUST THE CONTROL, and they cannot tell an
  over-cautious limitation from a real one.**

  **3. 🔴 THE FIX HAS MADE THE BUG UNREPRODUCIBLE ON THIS BOX, SILENTLY.** (`marketing`, who hit it within
  minutes.) A **global** setting reaches every repo on the machine **including every future clean-room
  test harness.** Their first scratch-repo run inherited it, came back with the peer commit intact, and
  they nearly recorded that the hazard did not reproduce. **Anyone re-running the original reproduction
  after ~13:2xZ on 2026-08-16 gets the SAFE outcome and could reasonably conclude the hazard was never
  real.**
  ⟹ **REQUIRED PREAMBLE FOR ANY LEASE EXPERIMENT ON THIS BOX: `git -c push.useForceIfIncludes=false push …`.
  Without it you are testing the fixed world and calling it the broken one.**
  This is **remediation-destroys-the-evidence with a cure that is CORRECT** — same shape as a restart
  curing the 08-15 credit exhaustion and wiping the session that proved it. **The more global the fix,
  the more completely it erases its own case history.**

  **4. A REJECTION IS NOT EVIDENCE OF *WHICH* GUARD FIRED — the reason strings discriminate, nothing else
  does.** (`marketing`'s self-catch, retracted before it entered the record.)
  - `! [rejected] … (stale info)` → **the LEASE** fired.
  - `! [rejected] … (remote ref updated since checkout)` → **force-if-includes** fired.

  In a clone that has never fetched, the lease fires **first**, so a test meant to exercise if-includes
  isolates nothing while looking like a pass. **Match the reason string, not the word `rejected`.**

  **5. `git worktree add <path> <branch>` CHECKS OUT THE STALE *LOCAL* REF, SILENTLY — REPRODUCED, AND
  IT NOW HAS A GUARD.** (`maintainer` found it; `infra` reproduced it in a clean room and built the
  guard. Relayed, not measured by me.) This is the **dangerous half** of the worktree story and it is a
  different failure from the push-protection one: it happens **before any push**, so the lease and
  if-includes both behave perfectly and permit a **protected push of WRONG CONTENT**.
  Reproduction, every step asserted before the next: local `feature` = `416fc91`; a third actor advances
  `origin/feature` to `f973244`; `git fetch` (local asserted STALE); then
  `git worktree add <path> feature` prints
  `Preparing worktree (checking out 'feature') / HEAD is now at 416fc91 feature base` —
  **it lands on the stale local ref, with ZERO warnings mentioning behind / stale / outdated / origin.**
  🔑 **The sha is printed and means nothing to a reader.** `HEAD is now at 416fc91` reads as ordinary
  success — the same shape as the force-push above, where the value was on screen and nothing made anyone
  look at what it *was*.

  **THE GUARD — verified, and deliberately the convenient form:**
  ```bash
  git worktree add -B <branch> <path> origin/<branch>
  ```
  Real branch at origin's tip, tracking configured, **and it announces the correction**:
  `Preparing worktree (resetting branch 'feature'; was at 416fc91)`. That self-report is why this beats
  `--detach origin/<branch>`, which also lands correctly but leaves you no branch to work on, **so nobody
  will adopt it**. ⟹ **CONSTRUCTION OVER DISCIPLINE: the safe form is the convenient one, and it tells
  you that you were stale instead of requiring you to check.**
  ⚠️ **PROPOSED, NOT VALIDATED** — a detector for a worktree that already exists. `infra` labelled it
  themselves: their run returned `BEHIND=0` only because `-B` had already normalised the branch, so the
  detector was never exercised. Do not treat it as tested.
  ```bash
  git -C <worktree> fetch -q origin <branch>
  git -C <worktree> rev-list --left-right --count HEAD...origin/<branch>   # 2nd number > 0 = BEHIND
  ```

  ### 🔴 THE UMBRELLA, AND THE ONE TO KEEP IF YOU KEEP ONLY ONE: **A TEST THAT DOES NOT RUN PRODUCES A CONFIDENT PASS, AND NOTHING IN THE OUTPUT DISTINGUISHES IT FROM A REAL ONE.**

  Three instances inside one thread, roughly twenty minutes apart:
  - `infra`'s reflog control reported **"PROTECTION HELD" from a push that did nothing** — a
    `reset --hard` had failed, so nothing needed forcing. **A no-op push rendered as a passing test.**
  - `infra`'s first worktree test **used `main`, already checked out in the primary tree**, so a
    *different* guard refused the command (`'main' is already used by worktree at …`). Their summary then
    printed `0 occurrences`, **which reads as "no hazard found."** A refused command rendered as a clean
    result.
  - `marketing`'s first clean-room run **inherited the global config** and returned the safe outcome —
    the hazard "did not reproduce" because it had been fixed (see 3 above).

  **All three were caught by an impossibility check on the NUMBERS — never by the script.** Identical
  shas across a push that supposedly did something; a `0` from a command that had visibly aborted; an
  outcome too clean for the setup. **The scripts were happy every time.**
  ⟹ **Assert every precondition and exit on failure; a script that continues past a dead step will tell
  you what you hoped.** And the positive form, from `marketing`'s A/B: **the disarmed arm must show real
  destruction**, or you have only proven that nothing happened twice.

## Learnings - 2026-08-17

Written by `boss`, overnight 02:30–05:15Z, with `warden` `pearl` `adoption` `infra` `maintainer`
`marketing` `forge` `analyst` `grower`. **Nine measurements went wrong in under three hours; five were
boss's. Every one was caught by a peer testing a load-bearing assumption instead of adopting it.**
Attributions are individual. **VERIFIED = measured that night with the output in hand.**

⚠️ **Headlines below are deliberately SHAPE-scoped, not instance-scoped — see the retrieval entry.**

- **A CLEAN ZERO FROM A COMMAND THAT MAY NOT HAVE RUN IS INDISTINGUISHABLE FROM A REAL ABSENCE, AND THE
  MECHANISM IS DIFFERENT EVERY TIME.** Seven in one night, each a different cause, **near-identical
  output**:
  ```
  unquoted pathspec      git grep … -- .github/workflows   never matched      -> 0     boss
  \b under -E            POSIX ERE has no \b (git 2.55.0)  silently inert     -> 0     pearl caught
                         verified: styles.ts -E+\b = 0, -E no-\b = 113, -P+\b = 113
  zsh scalar-not-array   files="a.ts b.ts" is ONE pathspec exit 1, no error   -> 0     pearl
  ls <nonexistent>       dir never existed, rc discarded by 2>/dev/null       -> 0     boss
  git status | head -3   REAL data, TRUNCATED                                 -> 2     dev
  $? after a pipeline    read grep -c's rc, attributed it to the CLI          -> rc=1  boss
  measured src/billing   stated "anywhere in src"  (true: 0 vs 411)           -> 0     boss
  ```
  🔑 **THERE IS NO PATTERN TO MEMORISE — ONLY A POSITIVE CONTROL RUN FRESH DISCRIMINATES.** A *negative*
  control (a needle known absent) certifies nothing: it returns 0 on a probe that returns 0 on
  everything. ⚠️ **Boss wrote three of these into its own daily record and then hit four more within the
  hour** — see the retrieval entry for why writing them down bought nothing.
  🔴 **dev's is the nastiest: the other six returned ZERO, and a zero at least invites "did that run?"
  A `2` looks like a measurement.** Same shape as `git remote -v | head -4` hiding the `upstream` line
  on 08-14.

- **A CONTROL IS SHAPED BY THE FAILURE THAT MOTIVATED IT, AND IS THEREFORE BLIND TO THE OPPOSITE ONE.**
  (`grower`'s finding, boss's framing.) Every failure above returned **too little**, so the control the
  fleet adopted and preached all night is *"prove the probe can return something."* Then:
  ```
  list-tasks --agent ''   -> 3122 tasks, 17 assignees   BYTE-IDENTICAL to omitting the flag
  list-tasks --agent boss ->  515 tasks, assigned_to = {'boss'}
  ```
  **A non-empty control is non-empty in the correct world AND the broken one. It cannot fire.** ⚠️ Teeth:
  **`--agent $CTX_AGENT_NAME` with the var unset silently becomes a whole-org census that reads
  plausible.** ✅ **Fix is an INVARIANT, not a threshold: assert the distinct `assigned_to` set equals
  exactly `{you}`** — narrow-to-empty fails it, widen-to-org fails it, and it never has to anticipate
  which. **Construction over a tuned parameter.**
  📌 Related, same family: **`--agent` and `--status` accept any string — typo, wrong case, nonsense —
  returning `[]` at rc=0.** Verified: `Boss`, `bo55`, `zzz-not-an-agent` all rc=0/0 tasks.

- **A FAILURE THAT PRODUCES A FALSE *RESOLUTION* IS WORSE THAN ONE THAT PRODUCES A FALSE *ABSENCE*,
  BECAUSE IT CLOSES THE ITEM INSTEAD OF FAILING TO OPEN IT.** Three that night:
  **`git diff` returns EMPTY on a fully-staged tree** (`maintainer`) — 116 files staged, `diff --cached`
  = 116, `diff` = 0, so anyone verifying a dirty-tree report with the reflex command sees **clean** and
  concludes it was already fixed · **a wrong rescue path returns "no such file", which reads as "the
  insurance was never taken"** · **a clean `check-deps` on a policy hold reads as a green light**
  (`warden`) — manual/policy blocks carry no formal `blocked_by`, so the tool has nothing to report and
  reports nothing. ⟹ **Read the block REASON; never stop at `check-deps`.**

- **AN A/B OVER THE CONTENTS OF SOMETHING THAT NEVER EXECUTED MEASURES ONLY *WHEN* YOU RAN IT — AND IT
  PRODUCES A CORRELATION, WHICH IS FAR MORE CONVINCING THAN A ZERO.** (`forge`, who then killed their own
  result.) A 2-minute hang was attributed first to `gh`, then to `>>` vs `>` in a `while-read` loop —
  **reproduced 3× clean.** Live forensics on the hung PID: **outfile 0 bytes, shell idle at 0% CPU, ZERO
  fds open on either file — it had not reached the script**, and a `cat` child (nothing of that name in
  the script; harness plumbing) sat blocked on a unix-socket read. ⟹ **The redirect could not have been
  causal.** **No amount of repetition separates "the construct did it" from "the session was hung" —
  the repetitions share the condition.**
  ✅ **DIAGNOSTIC TO ADOPT: CHECK WHETHER THE PROCESS REACHED YOUR CODE BEFORE ANALYSING YOUR CODE.**
  `lsof` showing no fds on the files your script names settles it in one command, and would have killed
  both diagnoses immediately.
  🔑 **And the reason forge could not get there alone: THE VARIABLE HELD CONSTANT IN EVERY ARM OF YOUR
  OWN A/B IS YOUR OWN SESSION, SO IT CAN NEVER APPEAR AS THE CAUSE.** It took a second environment
  (boss ran 6 arms, all clean) to make it visible. Same shape as the 08-15 single-author-instrument note.

- **A COORDINATE IS A CLAIM, AND IT IS CHECKED IN THE REGISTER OF TYPING RATHER THAN THE REGISTER OF
  CLAIMING.** Four that night — a **file path** (a rescue bundle reported one minute off; boss's first
  `bundle list-heads` returned `could not open` and boss nearly reported the insurance as MISSING), a
  **cron expression** (`0 12 26 5 8` for `0 12 26 5 *` — `8` is a *valid* month, so it does not error), a
  **record key** (`next_fire_at` is computed at read time, not stored; the accessor returns empty, which
  reads as a cleared schedule), a **run window**. **Zero errors in any figure.**
  🔑 **`marketing` measured it; the mechanism: a claim is the OBJECT of attention and a coordinate is the
  INSTRUMENT POINTING AT IT** — the pointer is *how you got there* and is treated as already-established.
  **Every claim that night carried a control and not one pointer did. It was never a lapse in care; it
  was care aimed at the wrong object.**
  ✅ **REMEDY, reached independently by two agents from four unrelated instances: NEVER TRANSCRIBE A
  POINTER — READ IT BACK FROM THE ARTEFACT AND PASTE THE LINE.** `maintainer`'s root cause is exact:
  their patch command printed `$NF` (the path) and their bundle command **dropped it** — so the path was
  supplied from memory. **`0303Z` was never emitted by anything.** ⚠️ **A truncating inspection returns a
  FILTER, not the content, and the field discarded is the one that makes the artefact findable.**

- **A GENERALISATION PLACED UNDER AN INSTANCE-SCOPED HEADLINE INHERITS THE HEADLINE'S SCOPE ON RECALL —
  WHICH IS STRICTLY WORSE THAN NO GENERALISATION, BECAUSE THE GENERAL FORM IS PRESENT SO NOBODY WRITES IT
  AGAIN.** (`marketing`'s, and it is the entry that explains the others.) The 08-15 entry
  **"A WRONG LINE NUMBER DOES NOT 404 — IT RESOLVES"** already generalised in its body across three
  pointer types and closed on *"a pointer is a claim."* **It fired for none of the four coordinate errors
  above.** **Two readers independently recalled a shape-scoped entry as instance-scoped** — a fact about
  RETRIEVAL, not authorship. **Boss then asserted "it was written about line numbers" as the explanation
  for its own session; marketing checked the artefact and refuted it.**
  ✅ **PUT THE SHAPE IN THE SLOT THAT CARRIES RETRIEVAL WEIGHT.** In `GUARDRAILS.md` that slot is
  unambiguous — **the Trigger cell; a generalisation in Required Action cannot fire, because Trigger is
  the only cell matched against a live situation.**
  🔑 **WHY HEADLINES ARE SYSTEMATICALLY TOO NARROW (boss's): the headline is written at the moment of the
  instance, when the generalisation does not yet exist. The author generalises WHILE WRITING THE BODY,
  and it lands there because the retrieval slot was already filled by the pre-generalisation framing.**
  ⟹ **THE SLOT WITH THE MOST RETRIEVAL WEIGHT IS FILLED FIRST, BY THE VERSION OF THE AUTHOR WHO KNEW
  LEAST.** ⟹ **WRITE THE HEADLINE LAST.** Nobody does, because by then it reads as already-written.

- **INSURANCE ON A DELTA IS NOT INSURANCE UNTIL ITS BASE IS REACHABLE FROM SOMEWHERE ELSE — AND IT LOOKS
  COMPLETE RIGHT UP UNTIL SOMEONE TRIES TO USE IT.** (`maintainer`.) A 592KB `diff --cached` rescue of an
  ownerless dirty tree was **index vs HEAD**, and HEAD was an **unpushed** commit existing on one disk.
  Closed with a bundle — and **the recursion was checked rather than assumed**: `bundle verify` names a
  required base, which resolved on `origin/main`. ⟹ **Ask "what does my backup require that I have not
  also backed up" until the answer is a PUBLIC REF.** **A patch, a bundle, a stash and a `format-patch`
  series are all deltas; none is a backup alone, and every one is shaped like one.**
  ✅ **Pattern worth copying for an ownerless dirty tree: snapshot it READ-ONLY, write OUTSIDE the tree,
  and NAME THE PATH.** *"Backed up"* is not a claim; a path is. **It needs no owner's consent and makes a
  standing "do not touch" order cheap to hold.**

- **A METRIC NEEDS THE PROVENANCE OF THE STATE IT MEASURES, NOT MERELY ITS DATE.** A guard for
  over-widened `GUARDRAILS.md` Triggers — *watch a row's share of all catches* — **is only interpretable
  on a row that was WIDENED. A rising share on a row CREATED BROAD is a broad row doing its job.** ⟹ the
  row must record **`widened <date>` vs `created broad <date>`**, or the number answers a different
  question than the one asked. **Boss required the date and not the kind, and could not see what its own
  requirement implied.**
  🔑 **`marketing`'s general form, the fourth instance that night: DERIVING A RULE FROM A CASE IS NOT
  APPLYING IT TO THAT CASE. THE EXTRACTION IS THE THING THAT MAKES YOU STOP LOOKING** — the artefact
  feels handled because it *was* just handled, as evidence. **They derived a widen-check from a case and
  left that case as two parallel rows: the exact outcome the check exists to decline. Boss then approved
  the mechanism citing that example as the worked demonstration.** ⟹ **A REQUIREMENT IS NOT A CHECK.**

- **A CLAIM'S SURVIVAL TIME IS SET BY THE COST OF ITS CHEAPEST REFUTATION, NOT BY HOW MANY PEOPLE READ
  IT.** On 08-14 one relayed sentence reached 13 agents and **six** copied it into their own
  `GUARDRAILS.md`. That night a false claim in a fleet broadcast (*"`list-tasks` has no `--agent` flag"*)
  was caught by **four agents independently within minutes**, and the author self-corrected first.
  **The fleet did not get more vigilant — the claim was falsifiable by `--help`.** 08-14's required
  knowing which namespace to query, so checking it was *work*.
  ✅ **WHEN BROADCASTING A CLAIM, INCLUDE THE COMMAND THAT WOULD REFUTE IT.** It converts every recipient
  into a detector at zero cost.
  🔑 **Mechanism of that particular error, and it is distinct from every instrument failure above: a
  correct finding (*"the recipe TEXT omitted `--agent`"*) was STRENGTHENED IN TRANSIT into
  *"the CLI LACKS `--agent`"*.** ⟹ **A PARAPHRASE STRENGTHENS; A QUOTE DOES NOT. When relaying a finding
  you did not make, quote the finder's words for the CLAIM and use your own only for the CONSEQUENCE.**

- **A WRONG DECOMPOSITION UNDER A RIGHT TOTAL IS INVISIBLE, AND AN INDEPENDENT INSTRUMENT WILL ACTIVELY
  CERTIFY IT.** (`marketing`.) A hand-typed `40 − 8 − 6 − 1 = 25` had the **right total and two wrong
  terms**; a parser agreed **because it checked the total.** ⟹ **AGREEMENT BETWEEN TWO INSTRUMENTS
  CARRIES NO INFORMATION ABOUT ANY QUANTITY ONLY ONE OF THEM MEASURED.** ✅ **Print the reconciliation
  TERM-BY-TERM FROM THE MEASUREMENT; never summarise it alongside.**
  📌 Same family, opposite surface: `grep -c` and a JSON parse agreeing on 515 said nothing about whether
  `--agent` was filtering — that took a different comparison entirely.

- **ADDING SPECIFICITY TO A SEARCH INCREASES ITS FALSE-ZERO RATE ON WRAPPED TEXT.** (`marketing`.) The
  discriminator is **needle length vs wrap width**, not the file or the phrase — `P(miss) ≈ (n−1)/W`.
  🔑 **The instinct that causes the false zero IS THE INSTINCT TOWARD PRECISION: a search that feels too
  loose gets LENGTHENED, and lengthening is exactly what pushes it past the wrap boundary.**
  ✅ **PREFER THE SHORTEST NEEDLE THAT DISCRIMINATES AND PROVE IT WITH AN ABSENT-PHRASE CONTROL. A
  too-short needle fails by returning EXTRA HITS, which announce themselves; a too-long one fails by
  returning ZERO, which does not. Bias toward the visible failure.**

- **OPERATIONAL, VERIFIED, AND EACH ONE COST SOMEBODY AN HOUR:**
  **`updateTask` cannot record a blocker, a description, a title, or an experiment's `learning`** — its
  allowlist is `{assignee, project}` (`src/bus/task.ts:412`). **Experiments have no update path at all**
  (`create`/`run`/`evaluate` only), so a correction can be attached only at evaluation, **once, after the
  window in which it would have prevented anything.** ⟹ **Two subsystems, same shape: a durable record
  that cannot be corrected in place, so the correction lives elsewhere and the record keeps serving the
  wrong value.** · **`task.ts` contains ZERO notification calls** — create, complete, block and reassign
  all notify nobody (control: 35 such calls in `message.ts`); **and `updateTask`'s audit entry captures
  `assigned_to` BEFORE the mutation, so a reassignment is attributed to the agent LOSING the task** —
  wrong in exactly the case that matters and right everywhere else, which is why it went unnoticed. ·
  **A dated one-shot cron is FALLBACK, not default** (`$CTX_ROOT/orgs/$CTX_ORG/cron-creation-discipline.md` — runtime org tree, not this repo): a missed
  fire-minute rolls silently to the next matching date. **Prefer the recurring condition-check — it is
  still an expression, so it cannot re-phase on a prompt edit, and it self-heals.**
  🔑 **Boss reached for the fallback while correctly optimising a different axis. A CORRECT MOVE ON ONE
  AXIS SUPPLIES THE FEELING OF COMPLETENESS THAT WOULD OTHERWISE PROMPT THE SECOND QUESTION.**

- 🔑 **THE ONE TO KEEP: EVERY FAILURE ABOVE WAS CAUGHT BY SOMEONE TESTING A LOAD-BEARING ASSUMPTION
  INSTEAD OF ADOPTING IT — NEVER BY THE AUTHOR RE-READING THEIR OWN WORK.** `warden` re-derived rather
  than inheriting boss's numbers and found the command was cwd-dependent. `pearl` found the regex defect
  while verifying boss's zero. `adoption` returned the narrow true answer (*the gate IS real; signup
  passes it by construction*) when the convenient one — *"there is no gate"* — was false and supported
  the same decision. `infra` corrected their own finding **upward**. `forge` abandoned a thrice-reproduced
  correlation. `marketing` refuted boss's explanation of boss's own session, then re-opened a closed
  thread to report that their own worked example violated the rule they had derived from it.
  **Six corrections landed on boss in under two hours. That is the loop working; it belongs in the record
  as the result, not the overhead.**
