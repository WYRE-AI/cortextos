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
  dev 2, murph 1, `.worktrees/` 5, `.claude/worktrees/` 3, plus external ones). **Only
  `/Users/asachs/cortextos` itself — the primary tree, on `main` — is shared, and that is exactly
  where every incident above happened.**
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
