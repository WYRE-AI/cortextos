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
- `templates/` — Agent templates (agent, orchestrator, analyst, agent-codex, agent-opencode)
- `community/` — Community skills and agent catalog
- `tests/` — Unit, integration, and E2E tests

## Code Style

- TypeScript strict mode
- No external runtime dependencies beyond what's in `package.json`
- File operations use atomic writes (see `src/utils/atomic.ts`)
- All bus operations go through `src/bus/` modules

## Learnings - 2026-07-14

- **Fleet-wide "hang" was weekly-limit exhaustion, not a freeze.** All agents shared the keychain login (aaron@aaronmsachs.com), hit the Max weekly cap, and blocked forever on Claude Code's interactive `/rate-limit-options` dialog. The hang-detector correctly flagged no-beat-after-fire and restart-looped uselessly. Diagnostic tell: strip ANSI from `~/.cortextos/default/logs/<agent>/stdout.log` and grep for "weekly limit" BEFORE suspecting daemon code.
- **Interactive Claude Code prefers the stored keychain login over `CLAUDE_CODE_OAUTH_TOKEN`** (print mode `-p` honors the env token). ⚠️ **STATUS 2026-08-17: the INTERACTIVE half is UNVERIFIED — never re-measured since this entry was written. The `-p` half is settled and was never in dispute. See the correction below; these are two modes and the sentence says opposite things about each.** Fix: per-agent `CLAUDE_CONFIG_DIR` (in agent `.env`, pointing at `~/.cortextos/default/state/<agent>/claude-config/`) so the token is the only credential. Seed `.claude.json` with `hasCompletedOnboarding`, `bypassPermissionsModeAccepted`, and `projects.<agentDir>.hasTrustDialogAccepted` — ~~and expect a boot race on first spawn (two agents still showed the folder-trust dialog once; a restart after claude's own config rewrite cleared it)~~.

  ### 🔴 CORRECTED 2026-08-17 17:0xZ — SPLIT THIS ENTRY INTO MEASURED / INHERITED / CONFOUNDED BEFORE CITING IT
  *(`infra` reproduced the seeding half on a live canary; `grower` caught that the halt notice was forward-looking only; `maintainer` supplied the disclaimer case; corrected in place by `marketing` on `boss`'s ruling. **Struck, not deleted** — the struck text is why anyone believed it.)*

  - 🔴 **SEEDING IS NECESSARY AND NOT SUFFICIENT — the struck clause reads as "seeding solves it modulo a race." It does not.** **Measured on the `adoption` canary: `hasTrustDialogAccepted` was PRESENT AND CORRECT and the trust dialog fired anyway**, after which the config tracked **two projects, not one**. ⚠️ **This is the shape that gets quoted later as a green light.**
  - ⚠️ **THE INTERACTIVE HALF IS UNVERIFIED — AND ON 2026-08-17 IT WAS BRIEFLY AND WRONGLY DECLARED REFUTED. The round trip is kept because it is the most useful thing in this entry.** *(`maintainer` designed the test, `boss` ran and broadcast it, `infra` caught the error, retracted within six minutes.)*
    ```
    DISPUTED   INTERACTIVE PTY -> keychain wins   <- what agents actually run.  STILL NOT TESTED.
    SETTLED    PRINT MODE -p   -> env token wins  <- never in dispute.  THIS IS WHAT WAS TESTED.
    ```
    **The test — `claude -p` with a deliberately-bad token → `401 OAuth access token is invalid` — is EXACTLY WHAT THIS ENTRY PREDICTS.** The parenthetical was confirmed and read as refuting the sentence.
    🔑 **`infra`'s diagnosis, and it is the lesson worth more than the result: A WELL-CONTROLLED EXPERIMENT ON THE WRONG AXIS PRODUCES A MORE CONFIDENT WRONG ANSWER THAN A SLOPPY ONE, BECAUSE EVERY CHECK PASSES.** A/B control · an impossible-token design so you never need to identify which credential served · reading the output text rather than `rc` past a pipe — **every control was sound, and every one was pointed at the wrong mode. The rigour is what made it persuasive enough to broadcast.**
    🔑 **AND THE INSTRUMENT PROHIBITION THAT EXISTED AND DID NOT FIRE:** *"`-p` honours the env token BY DESIGN; the question is what the INTERACTIVE PTY path does; `-p` cannot observe it"* — **written forty minutes earlier, under the heading "DO NOT USE EITHER OF THESE", by the person who then used it.** ⟹ **A DOCUMENTED PROHIBITION DOES NOT SURVIVE CONTACT WITH A RESULT THAT FEELS DECISIVE — not even for its own author. The instrument gets checked when you are CHOOSING one, and not when you are HANDED AN ANSWER.**
    ✅ **WHAT IS SETTLED, verified independently twice: `.env` keys land in `ptyEnv` UNFILTERED (`:133-144`, write `:141`) — THE TOKEN ARRIVES. That has never settled THE TOKEN WINS. Two legs; only the first has evidence.**
    📌 **The real test: the impossible-token design run through a PTY rather than `-p` — clean room, throwaway `HOME`, no live agent, and a no-override control that must SUCCEED or the harness proves nothing.**
  - 🔑 **AND THE ORDERING LESSON, which cost more than the claim (`maintainer`'s): A REMEDIATION IS EVIDENCE ABOUT A PREMISE ONLY WHEN IT FAILS. WHILE IT APPEARS TO WORK IT CONFIRMS NOTHING AND SUPPRESSES THE QUESTION.** **Four agents recorded this premise as fact, two tasks were filed on it, and one live agent was crash-looped remediating it — and settling it cost ONE COMMAND. The canary failing is what finally sent someone to check.**
  - 🔴 **AND THE FIX ABOVE IS NOT SAFE TO APPLY AS WRITTEN.** **A fresh `CLAUDE_CONFIG_DIR` has NO session history and the daemon boots agents with `--continue`, so the first spawn exits 1 on `No conversation found to continue` — DETERMINISTIC, not a race: 5 crashes in 90 seconds** (`adoption`, 2026-08-17, reverted). ⟹ **The real fix is a DAEMON change — force `mode='fresh'` for the first boot after `CLAUDE_CONFIG_DIR` appears — not an `.env` edit.**
  - 🔑 **COMPOUND WORTH KEEPING: four of the five agents this would be applied to have NO TELEGRAM, so a naive rollout halts four agents that cannot say they halted.** **The exposure being fixed and the fix's own failure mode share the same blind spot.**
- **Setup-tokens (`sk-ant-oat01`) lack the `user:profile` scope**, so `bus check-usage-api` / rotate-oauth preflight 403s with them. Rotation preflight needs an inference ping (e.g. one-word haiku `-p` call) instead of the usage API when running on setup-tokens.
- **OAuth rotation was never operationalized until today**: `state/oauth/accounts.json` was never seeded, no `.env` had a token, and nothing invokes rotation automatically. Now seeded with 4 accounts (active: wyre-team100). Open design gap: rotation must live in the daemon — a rate-limit-blocked agent can't run `rotate-oauth` itself; the daemon should detect the limit banner in the PTY stream, halt hang-restarts, rotate, and alert.
- **2026-07-15 recurrence:** the 5-hour *session* limit (not weekly) on the shared team100 seat blocked 6/9 agents on the same dialog within ~28h of the first fix. Nine concurrent Opus agents exhaust any single seat's 5h window under load — account rotation cadence is hours, not weeks. Manual rotation playbook (15 min): preflight bench account with clean-room opus `-p` ping → update `active` + rotation_log in `state/oauth/accounts.json` → rewrite `CLAUDE_CODE_OAUTH_TOKEN` in agent `.env`s → restart agents. Daemon-side auto-rotation is now the top open item.

## Learnings - 2026-07-16

- **Limit-rotation shipped and live-verified.** Full chain (PTY banner → limit-detector → rotation-manager → opus-ping preflight → accounts.json flip → .env rewrite → targeted restart → Telegram alert → cooldown guard) exercised end-to-end via a PATH-shimmed fake `claude` on warden that printed a real banner. Agent `.env` PATH lines override the daemon base env — useful for per-agent binary shims in future verifies.
- **Weekly limits are rolling windows:** aaronmsachs-max20 was hard-blocked Tuesday but had usable capacity again by Thursday, two days before its stated "resets Jul 20" — a "dead" account can't be assumed dead for a live verify, hence the shim approach.
- **PTY banner text has cursor-positioning escapes BETWEEN words** — after ANSI-stripping, text reads `Whatdoyouwanttodo?`. Any matching against agent PTY output must normalize whitespace away first.

## Learnings - 2026-07-28

- Upstream (grandamenium/cortextos) rewrote its published history for the
  SEC-1 operator-metadata purge, so this fork's merge-base is pinned at the
  initial release forever. Every upstream sync re-conflicts on shared files,
  mostly "echo conflicts" (identical cherry-picked changes under different
  SHAs). Scope syncs with `git merge-tree --write-tree` first, and after
  resolving, grep for silently double-applied blocks outside conflict
  markers — `tsc` caught duplicated methods in agent-manager.ts and
  agent-pty.ts during the 2026-07-27 sync (merge 975a1e8c).
- `.gitignore` blanket-ignores `docs/` (upstream SEC-1 posture). Curated
  docs are deliberately force-added past it (`git add -f`), matching the
  existing tracked runbooks. Run `.github/scripts/leak-guard.sh <files>` on
  anything force-added; the `--tree HEAD` form is slow (minutes).
- Known environment-flaky tests on the primary dev Mac (fail under load at
  ANY commit, verified at pre-merge HEAD in a clean worktree): the four
  fast-checker "heartbeat watchdog" fake-timer tests, phase4-performance p95
  assertions, and phase5-performance SC-2. They pass on a quiet machine —
  not regressions.

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
- **5 of 14 enabled agents are outside the rotation mechanism.** `adoption`, `grower`, `infra`, `maintainer`, `marketing` have no `CLAUDE_CONFIG_DIR`, so per the 2026-07-14 note they prefer the shared keychain login over `CLAUDE_CODE_OAUTH_TOKEN` — a rotation cannot move them. They were verified clean (no limit banners) on 08-14, so the keychain seat is currently healthy; the latent risk is that when *it* dies, rotation won't help and the failure will look like a partial-fleet outage. `writeTokenToAgents` does append a token line to them, ~~which is inert while the keychain wins~~.

  ⚠️ **CORRECTED 2026-08-17 (`grower`'s catch, corrected in place by `marketing` on `boss`'s ruling): the struck clause STATES AS FACT the one thing nobody has measured.** **`writeTokenToAgents` appending the line is MEASURED. "Inert" is INHERITED from the 2026-07-14 note above, which is itself unverified and now confounded.** ⟹ 🔑 **HONEST FORM: ROTATION *WRITES* TO ALL 15. WHETHER IT *MOVES* ALL 15 IS UNVERIFIED, AND IS THE THING TO TEST.** ⚠️ **On 2026-08-17 this was briefly broadcast as REFUTED — rotation moves everyone, no gap — and retracted six minutes later: the test used `-p`, which this file already says cannot observe the interactive path. STATUS REMAINS UNVERIFIED.** ⚠️ **If the token does serve, rotation moves them and there is no gap at all — so the entire "5 outside the rotation mechanism" finding rests on the unverified half.**
  🔑 **AND THE TRAP THAT MADE THIS SURVIVE, worth more than the correction (`maintainer`'s case): A DENIAL OF INHERITANCE IS ITSELF A PROVENANCE CLAIM AND NEEDS ITS OWN EVIDENCE.** A peer recorded *"rotation cannot move me (verified w/ positive control, not inherited from the 08-14 note)"* — **the parenthetical covers only the ABSENCE of the var, which they did measure; it does not cover "the keychain beats the token."** ⟹ **The disclaimer did the damage the bare claim could not: it reads as the whole sentence having been checked.**
  📌 **A HALT NOTICE IS FORWARD-LOOKING ONLY.** *"Nobody should record this as verified"* does not tell anyone to check what they have **already** recorded. **Two agents had recorded it, and both found it only by going to look.**
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
  in one read: `agent-pty.ts:399 getBaseEnv()` is an **explicit `keepVars` allowlist** (`:402`) that does
  *not* spread `process.env`, and the var is not in it — so the daemon **cannot inherit it from its own
  environment.** **Construction RULES OUT cases; observation only FAILS TO FIND them.** Same shape as the
  detector bug one level up: `T` was measured on `last_fire_attempted_at`, an axis the failure cannot
  touch, so it stayed fresh while everything real froze — **the signal was measured on the wrong side of
  the event.**

  ### 🔴 CORRECTED 2026-08-17 17:0xZ — THE SENTENCE ABOVE IS TRUE AND IT WAS READ AS A BLOCKER IT IS NOT
  **"The daemon cannot inherit it" is NOT "the agent cannot receive it."** The agent's `.env` is a
  **separate, unfiltered path**: `agent-pty.ts:133-144` reads it line-by-line and writes **every** key into
  `ptyEnv` at **`:141`** with no allowlist, and `ptyEnv` is handed to node-pty at **`:184`**. ⟹ **Setting
  `CLAUDE_CONFIG_DIR` in an agent's `.env` DOES reach the child — that is how every agent which has it is
  configured.**
  ✅ **PROOF THAT NEEDS NO CODE READ (`infra`'s): ten agents have POPULATED private config dirs. Only a
  `claude` that RECEIVED the var could have written them, and the var is not in `keepVars` — so it arrived
  via `.env`.** *(Confirmed live the same day: `adoption`'s `.env` gained the var at `16:59:22Z` and its
  private config dir was created and populated at `17:00:26Z`.)*
  ⚠️ **THAT CANARY WAS REVERTED AT ~17:02Z AND `adoption` DOES NOT CARRY THE VAR TODAY — do not go looking
  for it as evidence.** **The arrival proof is unaffected** (the dir could only have been written by a
  `claude` that received the var) **but the rollout was halted for a different, deterministic reason: a
  fresh `CLAUDE_CONFIG_DIR` has NO session history, the daemon boots with `--continue`, and
  `No conversation found to continue` exits 1 — five crashes in ninety seconds.** ⟹ **The fix is a DAEMON
  change (force `mode='fresh'` on the first boot after the var appears), NOT an `.env` edit.**
  🔑 **AND THE COMPOUND THAT MAKES IT WORSE THAN A FAILED CHANGE: four of the five target agents have no
  Telegram, so rolling it would have halted four agents that cannot say they halted.** **The exposure being
  fixed and the fix's own failure mode share the same blind spot.**
  📌 **Seeding `hasTrustDialogAccepted` is NECESSARY AND NOT SUFFICIENT — measured: the flag was present and
  correct and the trust dialog fired anyway.** *(The 2026-07-14 entry above reads as though seeding solves
  it. It does not.)*
  ⚠️ **`07-14 keychain-beats-CLAUDE_CODE_OAUTH_TOKEN` is NARROWED, NOT CLOSED: the var arrives and the
  private dir is used, but which credential SERVES is still unmeasured. Nobody should record it as verified —
  and on 2026-08-17 it was briefly recorded as REFUTED and retracted six minutes later.** 🔑 **EVIDENCE THAT
  NAMES A LIVE SYSTEM HAS A SHELF LIFE MEASURED IN MINUTES DURING AN ACTIVE CHANGE — this caveat has now been
  wrong in BOTH directions inside one hour.**
  ⚠️ **COST OF THE ORIGINAL WORDING: it was quoted to halt a five-agent remediation that was in fact
  sound.** The entry is in **this file, which is LOADED into every agent's context at boot** — so the false
  blocker **regenerated on demand** for two days rather than being read once.
  🔑 **THE LESSON THAT SURVIVES, AND IT SHARPENS THE HEADLINE ABOVE RATHER THAN RETIRING IT: CONSTRUCTION
  RULES OUT THE CASE YOU CONSTRUCTED, AND NOTHING ELSE.** One function was read and a conclusion about a
  whole subsystem was written. **The rigour was real and the scope was one function wide — which is exactly
  why it stood for two days.**
  🔑 **AND THE RETRIEVAL-SIDE TWIN: A STORED FINDING CARRIES THE FRAME IT WAS WRITTEN IN, AND THE READER
  SUPPLIES A NEW ONE WITHOUT NOTICING THE SWAP.** This sentence answered *"does the daemon inject it on its
  own?"* (no) and was read as answering *"will adding it to `.env` reach the agent?"* (yes). **Same file,
  same function, same sentence, opposite operational answer, and no error to notice.** ⟹ **Write the
  QUESTION into a finding, not just the answer.**
  📌 **`:368` was also wrong** — a coordinate carried from this entry into a live instruction. **It resolves
  to `onExit`/`getOutputBuffer`: real code, right file, plausible, not the thing.** Third pointer error
  traced to this entry, whose own neighbouring lesson is that **a wrong pointer resolves rather than 404s.**

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

## Learnings — 2026-08-16 (evening, 19:10–19:55Z)

Written by `grower`, by agreement — `boss` deliberately stayed out of this file so there would be exactly
one copy, which is the subject of the entry. `maintainer` and `boss` are attributed inline. **VERIFIED =
measured this session with the command output in hand.** Three of my own hypotheses appear here **as
refuted**; they are retained deliberately, because omitting a refuted hypothesis lets the next reader
derive it again in good faith.

- **A CONSTRAINT WRITTEN AS A PRONOUN SILENTLY SWAPS PRINCIPALS BETWEEN WRITING AND READING, AND THE
  SENTENCE ARRIVES INTACT.** `boss` had just published *"a constraint on an action goes in the same line as
  the action"*, naming the victim as **a fresh session reading an inherited open item**. I restarted minutes
  later and **became that reader.** My own handoff item 4 read *"`boss` owns Aaron comms. Two questions are
  with him: send the one missed reminder manually (a real customer email — **his call**)…"* — I wrote "his
  call" meaning **Aaron**; both pronouns resolve by proximity to **`boss`**. ⟹ **Item 4 read alone GRANTED
  `boss` EXACTLY THE AUTHORITY ITEM 3 EXPLICITLY DENIED HIM**, and item 4 sat in the open-item register —
  the half that travels. **The two items did not merely disagree; the MORE VISIBLE one won.**
  🔑 **SAME LINE IS NECESSARY AND NOT SUFFICIENT — I DID co-locate the constraint, and it failed anyway
  because THE CONSTRAINT WAS A PRONOUN.** ⟹ **NAME THE PRINCIPAL, NEVER REFER TO THEM.** "Aaron decides"
  survives the trip; "his call" does not. Same for the actor — **"boss owns", not "I own"** — because a
  handoff is read by someone who is not the writer even when nominally the same agent.
  ⚠️ **WHY IT IS NASTIER THAN EVERY OTHER FAILURE IN THIS FILE: NO QUOTING, NO TRUNCATION, NO DROPPED HALF.
  THE SENTENCE ARRIVES PERFECT AND MEANS SOMETHING ELSE.** The others all leave visible damage. **There is
  no mangling to notice, so no reader has a reason to look.**
  🔑 **AND THE TWO PRONOUN CLASSES ARE DIFFERENT BUGS.** An **anaphoric** pronoun (`his`, `him`) has a
  **fixed wrong referent** — wrong identically for everyone, so one careful outside read finds it. An
  **indexical** (`me`, `I`, `here`, `now`) **resolves correctly FOR THE AUTHOR and wrongly for everyone
  else** — `boss` found *"not delegable to … OR ME"* in their own copy, where **`me` resolves to whoever is
  reading**, so every other agent reads the constraint as granting itself the exception. ⟹ **The author can
  re-read their own doc forever and it will never look wrong.** ⟹ **THE INSTRUMENT IS A CHANGE OF
  PRINCIPAL, NOT MERELY A FRESH SESSION** — a restart clears the author's context but not the author's
  identity, and a fresh `boss` session still resolves `me` correctly, by luck.

- **THE SAME ASYMMETRY RECURRED FOUR TIMES IN FORTY MINUTES: THE CAREFUL SCOPING LIVED IN THE TASK DOC, THE
  LOOSE FORM LIVED IN THE ARTEFACT THAT TRAVELS.** (1) my pronoun, above; (2) `boss`'s handoff carrying a
  claim of mine unscoped; (3) my handoff asserting a remediation-ordering constraint as **hard and
  irreversible** with the *"vacuous for the current rows"* half absent — ⚠️ **unscoped, that line makes a
  fresh session BLOCK A CURRENTLY-SAFE REMEDIATION, the mirror-image harm of the misreading it was written
  to prevent; both are available from the same sentence**; (4) a recovery count of **9** travelling with
  neither its true value (**7**) nor the warning that the obvious success check returns 9 and lies.
  🔑 **INSTANCE 4 EXISTS ONLY BECAUSE I DID NOT STOP AT INSTANCE 3.** I had a hit, fixed it, and the sweep
  was finished by any reasonable standard. ⟹ **A DISCRIMINATOR THAT FINDS SOMETHING IS NOT FINISHED — THAT
  IS THE MOMENT IT FEELS FINISHED.** Cost of continuing: one command.

- **❌ THREE MECHANISMS FOR *WHY* IT RECURS WERE PROPOSED AND ALL THREE ARE REFUTED. RECORDED SO NOBODY
  RE-DERIVES THEM.**
  - ❌ **"The document is composed deliberately, the message in flow, so scoping lands where deliberation
    is"** (mine). **Dead: all four loose items were INSIDE deliberately-composed documents.** Instance 1 is
    the cleanest kill — **the scoped item and the loose item were in the same document.**
  - ❌ **"Inherited claims arrive unscoped; self-corrected ones carry their scope"** (`boss`'s). **1 of 4 and
    contradicted by instance 1:** my item 3 was **inherited, explicitly attributed, and fully scoped**,
    while item 4 was **my own and loose** — the reverse of the prediction.
  - ❌ **"Duplication without synchronisation"** (mine, second attempt). **Killed by the control I failed to
    run —** `boss` **checked whether the CORRECTLY-scoped claims were also duplicated. They were, at the
    same rate.** ⟹ substrate, not cause. ⚠️ **And the fatal defect: in a fleet running task docs + daily
    memory + handoffs + bus messages, EVERY claim lives in more than one place — so it is satisfied by
    everything and predicts nothing. IT FIT ALL FOUR BECAUSE IT FITS ALL CLAIMS.**
  ✅ **WHAT SURVIVES, falsifiable, and predicts the whole table including instance 1: PROVENANCE PREDICTS
  RISK, EXAMINATION DETERMINES OUTCOME.** Inherited **and re-derived** came out correctly scoped.
  **Inheritance is not the hazard; SKIPPED EXAMINATION is — and inheritance is dangerous precisely because
  quoting exists to avoid paying that cost.**
  🔑 **This is the 2026-08-04 `cron-utils` finding at `CLAUDE.md:56` — *"deliberately duplicated code drifts
  silently, and the duplicate is where the bug survives"* — arriving on PROSE.** Note the correction it
  forces on the naive reading: **duplication is the substrate in both cases; what separates the drifted copy
  from the synchronised one is whether anyone re-examined it.**

- **THE CHECK STANDS INDEPENDENT OF THE MECHANISM, AND IT IS TWO DISJOINT DIRECTIONS. Run both before any
  handoff or broadcast ships.**
  1. **COPIES YOU CONTROL** — diff each corrected claim across your own artefacts (handoff vs task doc vs
     memory). **This works because it compares artefacts AGAINST EACH OTHER, not against your memory of
     what you corrected.** Found instances 3 and 4 in two commands.
     🔴 **RUN IT IN BOTH POLARITIES, OR IT MISSES A WHOLE CLASS — I shipped it one-directional and it took
     a fifth instance to notice.** Grepping for **what SHOULD be present** finds a *correction that failed
     to propagate*. It does **not** find a **SUPERSEDED ASSERTION — a claim still sitting there that later
     evidence downgraded** — because nothing is missing; something is **surplus**. ⟹ **Also grep for what
     should NO LONGER be there.** Live case: a handoff still asserting *"two independent defects that
     compose"* as fact, hours after the populations were measured as non-coincident and the mechanism
     re-labelled open. **The correct qualifiers were present *and so was the superseded headline*, which
     is the worse half and the one a reader quotes.**
     ⚠️ **The two polarities have different tells: a missing correction is found by a `0` where you expect
     `1`; a superseded assertion is found by a `1` where you expect `0` — and only the first is something
     you naturally think to look for.**
  2. **COPIES YOU DO NOT CONTROL** (`boss`'s) — grep for every claim **attributed to a peer** and confirm
     the scope came across with the sentence. **The attribution is the index**, and it indexes exactly the
     claims likeliest to have skipped examination. **This reaches the copy living in someone else's
     document, which direction 1 structurally cannot.**

  🔴 **AND THE CHECK HAS A DEFECT THAT BIT WHILE THIS ENTRY WAS BEING COMMITTED, SO FIX IT BEFORE USING IT:
  THESE RECORDS ARE HARD-WRAPPED MARKDOWN, SO ANY MULTI-WORD NEEDLE CAN SPAN A LINE BREAK AND `grep`
  RETURNS A CONFIDENT ZERO.** Verifying my own commit, a four-word phrase from the entry returned **0**
  against the very file that contained it — the phrase wrapped mid-sentence. **I was one step from reporting
  that the commit had not landed.** ⚠️ **Direction 1 is exactly the check that runs multi-word claim needles
  against prose files, so this failure mode is aimed straight at it.** ⟹ **Use a SINGLE-LINE needle (a
  heading, an identifier, a number), or flatten newlines before matching; and ALWAYS carry a positive
  control that is known present in both files being compared** — the control is what separates "the claim is
  missing" from "my needle wrapped." **Third broken probe of one session, and the only one that would have
  produced a false alarm rather than a false all-clear.**

  🔴 **AND THE SECOND HABITAT IS THE ONE THAT MATTERS FLEET-WIDE, BECAUSE IT IS THE PROBE WE ALL RUN MOST:
  `jq -r … | grep` IS A WRAPPING PROBE, NOT A LINE-ORIENTED ONE.** `jq -r` renders embedded newlines as
  **real** newlines, so a multi-word needle can straddle a break exactly as it does in wrapped markdown.
  ⚠️ **JSONL *looks* line-oriented — one record per line — and that is precisely what makes it dangerous:
  the assumption is reasonable, universal, and wrong.** `boss` found this in their own **load-bearing**
  verification (whether an unscoped claim had reached a principal) **after the result was already in
  circulation.** Re-run flattened, with wider needles and a **multi-word positive control**, the absence
  held and the conclusion was unchanged — **but it had been sound by luck, not by construction: the needles
  simply happened not to straddle a break, and nothing in the output would have said otherwise.**
  ⟹ **Use a SINGLE-TOKEN needle, or flatten AND SQUEEZE whitespace (`tr '\n' ' ' | tr -s ' '`), and carry
  a MULTI-WORD positive control — a single-word control cannot detect the failure, because the failure only
  affects needles long enough to wrap.**
  🔴 **THE SQUEEZE IS NOT OPTIONAL, AND I LEARNED IT BY SHIPPING THE REMEDY WITHOUT IT — FOURTH INSTANCE OF
  THIS BUG, LANDING ON THE FIX FOR THE THIRD.** An earlier revision of this bullet said only *"flatten
  before matching."* **Measured against this file: newline-flatten alone returned `0` on a needle that IS
  present; flatten-plus-squeeze returned `1`; an absent-control returned `0` under both, so the probe
  discriminates.** ⚠️ **Cause: hard-wrapped markdown INDENTS its continuation lines, so `tr '\n' ' '` yields
  SEVERAL spaces exactly where the needle expects one.** The remedy handled the newline and not the
  indentation that always accompanies it.
  🔑 **GENERAL FORM, AND IT IS THE INVERSE OF THE CONSTRUCTION LESSON BELOW: reasoning from the mechanism
  produces plausible-but-wrong DIAGNOSES, and by exactly the same route it produces plausible-but-INCOMPLETE
  REMEDIES.** I derived this fix from understanding *why* needles break and never ran it against the corpus
  it was written for. ⟹ **A REMEDY IS AN INSTRUMENT AND INHERITS EVERY RULE HERE — test it against a case it
  must handle, with a control, BEFORE publishing it.**
  ⚠️ **And a fifth instance arrived while writing this correction: searching for my own `SINGLE-TOKEN`
  returned `0` because I had originally written it lowercase — the case-mismatch failure from earlier in the
  same session, recurring inside the bullet documenting it.** *(Both were caught by an impossibility check —
  a `0` for text I had just written — never by inspecting the probe.)*

  🔴 **SIXTH, AND IT IS A HAZARD NEITHER OF US HAD LISTED: THE WRONG FILE, NOT THE WRONG NEEDLE.** `boss`
  went looking for a counterexample in the **root** `cortextos/CLAUDE.md`; the table they wanted lives in
  **`boss/CLAUDE.md`**. **The needle was correct, the corpus was not, and the result was a clean `0` that
  reads as a real absence.** ⚠️ **In a fleet where several files share the name `CLAUDE.md`, this is
  permanently available** — and it is the local-filesystem member of the same family as the 08-14
  wrong-GitHub-namespace and wrong-secret-context traps: **the query resolves, answers an adjacent question,
  and announces nothing.** ⟹ **Pin the corpus the way you pin a namespace: state the absolute path, and when
  a search returns nothing, confirm you searched the file you meant BEFORE concluding absence.**
  ✅ **AND IT IS THE FIRST OF THE SIX CAUGHT BY A CONTROL RATHER THAN BY A NUMBER LOOKING WRONG:** the
  multi-word positive control **also** returned `0`, so the empty result was never read as an absence.
  🔑 **That is the control rule paying out within ten minutes of being written — the control was alike in the
  respect under suspicion (same file, same match mode) and it fired.** ⚠️ **`boss` flagged it against their
  own zero-of-four claim rather than letting it stand, which is why it is here: it is the one data point
  that cuts against the finding they had just contributed.**
  🔑 **AND THAT GENERALISES PAST `grep`, AS THE STRONGEST STATEMENT THIS FILE CAN MAKE ABOUT CONTROLS: A
  CONTROL ONLY CONTROLS FOR FAILURE MODES IT CAN ITSELF EXHIBIT.** A one-word control against a wrapping
  hazard, a needle that cannot appear in the searched corpus against a contamination hazard, a lowercase
  control against a case hazard — **each passes cheerfully while the real needle fails, and each reads as
  rigour.** ⟹ **Before trusting a control, ask what it would take for the CONTROL to fail, and confirm that
  is the same thing that would make the measurement fail.** Every broken probe in this file and the one
  above it is an instance: **the control and the measurement have to be alike in the respect under
  suspicion, and in nothing else.**
  🔴 **BUT THAT RULE IS AN AUDIT INSTRUMENT, NOT A DISCOVERY ONE, AND READ ALONE IT MISLEADS** (`boss`'s
  limit, and they checked it against the evidence rather than asserting it). *"Ask what would make the
  control fail"* **presupposes you have already named the respect under suspicion.** Checked against the
  four broken probes across this entry and the one above it: **ZERO were found that way.** The wrapped
  needle came from verifying a commit and being surprised; the consumed control came from grepping for
  something else entirely; the case-mismatch and the unquoted `zsh` glob both surfaced because **a number
  looked too clean.** ⟹ **Nobody introspected their way to any of them, and the rule read alone invites
  exactly that — sitting and thinking harder about your own probe, which is the one thing that
  demonstrably did not work.**
  ⟹ **THE TWO COMPOSE RATHER THAN COMPETE: SOMETHING ELSE FINDS THE RESPECT UNDER SUSPICION; THE CONTROL
  RULE THEN TELLS YOU WHETHER YOUR CONTROL ACTUALLY COVERS IT.**
  🔑 **AND ON *WHAT* THAT SOMETHING ELSE IS, THE FOUR CASES ARE UNANIMOUS AND SLIGHTLY SURPRISING: A SECOND
  READER FOUND 0 OF 4. AN IMPOSSIBILITY CHECK ON THE NUMBERS FOUND 4 OF 4** — and all four were
  **self**-caught, just never by deliberate self-audit. Each was an **involuntary collision with a quantity
  that could not be true**: a control reporting present while the same block's grep reported absent; a
  `0` against a file just written and committed; a negative control returning 3; a `0` beside a control
  term returning 25. ⟹ **The intervention that works on a BROKEN INSTRUMENT is to PRODUCE A REDUNDANT
  NUMBER THAT MUST AGREE, AND THEN LOOK AT BOTH** — the same discipline as forcing every partition to sum
  to a total, and as insisting one term be free of the suspect predicate.
  ❌ **A FOURTH PROPOSED PARTITION DIED HERE TOO, AND IT IS RECORDED BECAUSE THE WAY IT DIED IS THE POINT.**
  I offered: *"second readers catch wrong CONCLUSIONS; impossibility checks catch broken INSTRUMENTS,"* on
  5-of-5 and 4-of-4 with no crossover. `boss` attacked it on request and it fell twice over.
  - **Out-of-sample counterexample:** `boss/CLAUDE.md`, 08-15 — a fix list that enumerated **four of seven**
    items, where `infra` **re-counted independently and found three more.** That is an **incomplete
    enumeration — a broken instrument — caught by a SECOND READER**, and **no quantity was impossible**: the
    four rows were internally consistent and read clean. **The crossover I said could not happen had already
    happened, on a night neither of us was sampling.**
  - 🔑 **AND THE FATAL OBJECTION, WHICH IS NOT THE COUNTEREXAMPLE: THE CATEGORIES WERE ASSIGNED AFTER THE
    ANSWER WAS KNOWN.** "Wrong conclusion" versus "broken instrument" **is not read off the failure — it is
    a judgement made once you already know who caught it.** The consumed control classes either way; so does
    the over-scoped shape argument, which becomes a bad *instrument* the moment you call the doc/message
    split a channel, **and that alone breaks the 5-of-5.** ⟹ **Ten events, two bins, labels assigned by the
    person computing the split: PARTLY DEFINITIONAL.** ⚠️ **Same defect as the refuted
    duplication-without-synchronisation above — it fits everything because THE FITTING HAPPENS AFTER THE
    FACT.** **Three of the four dead hypotheses in this entry died of exactly that.**
  ✅ **WHAT SURVIVES, and state it ONLY this way: THE TWO DETECTORS ARE NON-REDUNDANT — RUN BOTH, THEY FAIL
  DIFFERENTLY.** A team with only peer review **does** ship confident numbers from dead instruments, and the
  broken probes in this entry are real instances. ⚠️ **Never state it as "this class needs that detector" —
  that tells someone it is safe to skip one, which is the actual cost of the partition being wrong.**
  🔴 **AND THE CLOSE, WHICH CONSTRAINS EVERY FUTURE STUDY ANY OF US DESIGNS (`boss`'s): BLINDING IS THE
  RIGHT REMEDY AND THERE IS NO ONE HERE TO HAND IT TO.** The test needs a labeller who does not know who
  caught what. **Every agent who could plausibly label these events was present for all of them — and not by
  accident: THIS FLEET BROADCASTS FINDINGS IN REAL TIME AND THE BROADCAST CARRIES THE ATTRIBUTION.** ⟹ **The
  same practice that makes the peer review work — immediate, attributed, fleet-wide — is what destroys the
  blind labeller as a category. The contamination is a PRODUCT of the review protocol, not a lapse in it.**
  ⟹ **AN ORGANISATION CANNOT BLIND ITSELF RETROSPECTIVELY ABOUT FACTS IT HAS ALREADY BROADCAST. IF A DESIGN
  NEEDS BLINDING, THE BLINDING GOES IN THE RECORDING STEP, NEVER THE ANALYSIS STEP** — classify a failure at
  the moment it is found, **before** recording who found it: **label first, attribute second, in that order
  in the record.**
  ⚠️ **BE HONEST ABOUT WHAT THAT BUYS, OR IT GETS DISCARDED THE FIRST TIME SOMEONE NOTICES: prospective
  labelling does NOT blind you to attribution — the finder knows the find is theirs, and that is
  unavoidable. What it blinds you to is THE EMERGING DISTRIBUTION** — you label event 3 without yet knowing
  how events 4-10 will fall. **That is sufficient here, because the defect was never "I knew who found it";
  it was FITTING THE BINS TO A PATTERN I COULD ALREADY SEE.**
  🔑 **BOTH DIRECTIONS ARE LIVE AND ONLY A CONTROL CATCHES BOTH: a dead probe reports CLEAN while blind
  (false all-clear); a wrapped needle reports MISSING while the thing is present (false alarm, which
  manufactures work and erodes trust in the check itself).** Tonight produced three of the first kind and
  one of the second.

- **🔴 THE ACT OF DOCUMENTING A CONTROL CONSUMES THE CONTROL** (`boss`'s finding, and they then reproduced
  it on themselves). Their negative-control needle **returned 3** — because they had written that literal
  string into the daily record they were now searching. **The record of a measurement became an input to the
  next measurement** (same family as remediation-destroys-the-evidence). ⚠️ **And it happened AGAIN one
  message later: their replacement needles went into daily memory as literal strings and are now consumed
  for any future search of that file — BY THE ENTRY EXPLAINING WHY THAT HAPPENS.** My own controls checked
  clean, **by accident and not by discipline** — I happened to write needles only into shell commands and
  bus messages, never into the prose I later searched; a slightly more thorough note would have failed
  identically. ⟹ **RULE, stated so it survives being written down: DESCRIBE YOUR NEGATIVE-CONTROL NEEDLES,
  NEVER QUOTE THEM, IN ANY RECORD YOU WILL LATER SEARCH — or use random hex that cannot occur in prose.**
  *(No needles are quoted in this entry, deliberately.)*
  🔑 **`boss`'s ladder, and it is the sharper half: rule identified → violated in the very next message →
  caught by GREPPING, not by re-reading. PROXIMITY DID NOTHING.** Writing a rule down and recognising its
  next instance are **unrelated faculties.**

- **A MATCHING FIELD IS NOT EVIDENCE OF A WRITE** (`maintainer`'s, and it is not about Stripe). Arguing that
  a row's staleness was *total* rather than *partial*, I treated a field agreeing with the truth as evidence
  that an update had run. **It is equally consistent with a write that never happened and a value that never
  had to move** — a trial *starts* as `trialing`, so a correct status may simply be an original value that
  never needed to change. ⟹ **Scope such an argument to the rows whose value HAD to change; it is
  UNDETERMINED on the rest.** 🔑 **General form: this is inferring a PROCESS from a STATE that more than one
  history produces**, and it is the same error as concluding a record is unreachable because it is wrong —
  **a guard that tests one property tells you nothing about a different one.**

- **CONSTRUCTION RULES OUT CASES — AND IT ALSO MANUFACTURES PLAUSIBLE DEFECTS THE DATA NEVER EXERCISES.**
  Two opposite errors landed on one pair of files in one evening. I **spared a correct defensive `COALESCE`
  by reading source** (it looked wrong, it was doing its job; "fixing" it would have converted a staleness
  bug into data loss). Then I built a hypothesis **from that same source read** — the field is read only at
  the top level, with no fallback, and a code comment says the vendor moved it — and **`maintainer` refuted
  it by reading the DELIVERED PAYLOADS**: the field was present at the top level in every stored event, at
  an API version where it belongs there. ⟹ **The extraction path is HARMLESS IN PRACTICE AND
  DEFECTIVE-LOOKING IN SOURCE; the `COALESCE` was CORRECT-LOOKING IN SOURCE AND SUSPECTED IN PRACTICE.**
  🔑 **A CODE COMMENT DESCRIBING A HAZARD IS NOT EVIDENCE THE HAZARD OCCURRED.** ⟹ **Construction tells you
  what CAN happen, never what DOES. Each of us needed the other's instrument.**
  ⚠️ **`maintainer`'s method note, which is the reusable part: to ask what a consumer RECEIVED, read the
  stored event — it renders as delivered and states its API version. Re-fetching the live object renders at
  the CALLER's version: same object, different question.** They nearly shipped the invalid version and
  caught it because **the answer arrived faster and cleaner than the question deserved.**

- **A HAZARD THAT EXPIRES PRODUCES A RULE THAT EXPIRES** (`maintainer`'s, correcting me). I argued a
  remediation-ordering constraint should rest on my mechanism rather than theirs because **"mine does not
  decay." It decayed** — both were anchored on rows sitting near a **moving boundary**, and the boundary
  passed them. ⟹ **State such a constraint with both halves travelling: CORRECT GENERALLY, VACUOUS FOR THE
  CURRENT POPULATION** — "does not bind today" is not "was wrong." 🔑 **THE ONLY NON-EXPIRING STATEMENT IN
  AN INVESTIGATION IS THE DEFECT ITSELF, because it is not about any row.** Prefer it as the headline over
  any hazard, however vivid.

- **A CONFESSION IS A CLAIM AND GETS NO EXEMPTION** (`maintainer`'s refusal of my self-criticism). I wrote
  *"mine was the elegant sentence and it was the false one"*; they **declined it** — my partition was true,
  verified and load-bearing, and **one clause** was false. 🔑 **Over-claiming against yourself is still
  over-claiming, and it corrupts the record in the humble direction — the direction nobody audits.**
  ⟹ **State what was false at the granularity at which it was false.**

- **CLOSING NOTE ON THE THREE REFUTED SYNTHESES, and `boss`'s framing is the one to keep rather than mine.**
  I proposed three tidy unifiers in ninety minutes and all three died. My reading was that reaching for the
  unifier is a fault to suppress. **Theirs is better: every one was killed by a control inside ten minutes,
  and two of the three were killed by the person who proposed them — that is the system working, not
  failing.** ⟹ **The recordable tell is narrow and behavioural: A UNIFIER ARRIVES FEELING ALREADY CONFIRMED,
  AND THE MOMENT TO AUDIT IT IS WHEN THE SCOPED CLAIM ALREADY ANSWERS THE QUESTION.** All three times the
  narrow version was true and sufficient and I kept going.

## Learnings — 2026-08-16 (evening, 21:55–22:35Z)

Written by `grower`, on `boss`'s authorisation to consolidate the predicate-check set here rather than
leave it duplicated across three private `MEMORY.md` files. Participants: `boss`, `infra`, `grower`,
`marketing`. **Every attribution below was either verified by the author of this entry or corrected by
its own subject — and one of them was corrected by its subject against their own interest.**

### THE PREDICATE CHECK — FIVE LEGS

**The count is FIVE and it is stated here rather than carried in a name. It was FOUR ninety minutes
before this was written.**

| # | leg | attribution | how the attribution was established |
|---|---|---|---|
| 1 | **MUTATE THE DEFINITION** | test: `infra` · **precedence: `grower`** | first-party (author's own record) |
| 2 | **RUN THE PREDICATE YOU NAMED** | `boss` | timestamp **+ content**: coined `21:59:33.568Z`, `infra` acknowledged it as boss's `22:00:28.100Z` (+54.532s) |
| 3 | **READ WHAT YOU RAN** | `boss` named it; `infra` produced the incident **and** the mechanism sentence | timestamp **+ content**: coined `22:13:51.148Z`, `infra` credited boss `22:14:38.003Z` (+46.855s) |
| 4 | **NAME the predicate** | `infra` | timestamp **+ content**, cross-party: coined `21:55:40.894Z`, `boss` adopted it `21:56:40.707Z` (+59.813s) |
| 5 | **MUTATE THE INPUT** | **named by `boss`** `20:30:43.968Z`; **producing instance `marketing`'s `--ignored` mutation test** `20:29:39.752Z` | **settled ONLY by asking `marketing` directly — the instrument gets this row WRONG** |

`infra`'s mechanism sentence for leg 3, which is better than the name: **the act of running produces the
same internal state as the result.** `grower` has **not** reviewed leg 3 and must not be represented as
having agreed to it. Per `marketing`: the mutation test is **not anyone's invention** — it is ordinary
method; what is attributable is *the instance that made it load-bearing here* and *the sentence that put
it in the standing set.*

### 🔴 THE INSTRUMENT THAT SETTLED FOUR ROWS RETURNS THE SAME ANSWER ON THE ROW IT GETS WRONG

Bus message IDs are epoch-millisecond timestamps, so subtracting two of them is a real instrument needing
no witness — and it corrected two agents tonight, in the direction nobody audits. **`boss` twice
*under*-claimed legs they had coined**, deflecting credit to `infra`; `infra` then declined sole
authorship of three legs in one blanket sentence. Both are unverified claims that happen to flatter
someone else.

⚠️ **THEN IT FAILED, AND NOTHING IN ITS OUTPUT MARKED THE FAILURE. Run on all four pairs it returns
`first=A` 4 times out of 4. It is correct 3 times and wrong once.**

    leg 2   boss coins / infra acks         +54.532s   first=A   CORRECT
    leg 3   boss coins / infra credits      +46.855s   first=A   CORRECT
    leg 4   infra coins / boss adopts       +59.813s   first=A   CORRECT
    leg 5   marketing INSTANCE / boss RULE  +64.216s   first=A   WRONG

🔑 **SUBTRACTING THE IDS ANSWERS *WHO SENT FIRST*, NOT *WHO NAMED IT* — AND THOSE TWO PREDICATES COINCIDE
IN THREE CASES OUT OF FOUR.** On legs 2–4 the later message **explicitly credits the earlier one**, so
content and chronology agree. On leg 5 the earlier message is a **demonstration containing no rule**, and
the later one states the rule for the first time. `marketing` established this by **reading their own
sent message instead of answering from memory** — its only occurrence of the word is *"Mutation-tested,
cleanup done"*, which describes what they did, not a principle.
⚠️ **AND A SECOND CONDITION ON THE SAME INSTRUMENT, FOUND BY `infra` WHEN OUR TWO IDS FOR ONE `marketing`
MESSAGE DIFFERED BY 102ms: AN ID IDENTIFIES AN *INVOCATION*, NOT A LOGICAL MESSAGE.** Settled from the
writer rather than by comparing inboxes — `src/bus/message.ts` takes a **single** validated `to`, stamps
`Date.now()` **once per invocation** into `<epochMs>-<from>-<rand>`, and has **no fan-out loop**; so what
we call a broadcast is **N invocations spanning ~100ms**, and there is no per-recipient ID because there
is no one-message-to-many. ⟹ **Two IDs are comparable when both name sends within one conversation;
cross-inbox comparison orders different send events. Immaterial above about a second — every delta above
is 46.9–64.2s — and unsound below it.**
🔑 **STATED HERE BECAUSE OMITTING IT WOULD REPRODUCE THE LEG-5 FAILURE IN THE BLOCK THAT DOCUMENTS IT:**
a correctly-stated instrument applied outside the conditions where it holds, running clean, returning the
wrong answer, **with nothing in the output to warn the reader.**
⟹ **A TIMESTAMP ORDERS TRANSMISSION; ONLY READING THE MESSAGES ORDERS AUTHORSHIP. Never grade a row
"timestamp-settled" — the grade is *timestamp plus content*, and the content half is the load-bearing
one.** ⚠️ This is the *wrong line number that resolves* and the *wrong namespace that returns a real PR*,
now in a form that produces a **correct answer three times first**, which is what earns it the trust it
then spends.

### 🔴 THE ONLY ROW RESTING ON A CLAIM ABOUT AN ABSENT PARTY WAS THE ROW THAT WAS WRONG

Legs 1–4 concern agents who were in the thread. **Leg 5 credited `marketing`, who was not** — written
into a canonical artefact on two other agents' accounts. `grower` asked `marketing` directly rather than
recording it; `marketing` replied that *"marketing named first"* is **wrong**, that **`boss`** named it,
and supplied the timestamps that prove it.

🔑 **NOT A COINCIDENCE, AND IT IS `marketing`'s FRAMING: THE LEGS WITH THE SUBJECT PRESENT GOT CORRECTED
BY THE SUBJECT; THE ONE WITHOUT HAD NOBODY TO OBJECT.** Three agents each corrected an attribution about
themselves tonight. The fourth row had no such party and drifted unchallenged for two hours.
⟹ **A PREDICATE-CHECK BLOCK SHOULD CARRY WHO WAS ASKED, NOT ONLY WHO WAS CREDITED** (`marketing`'s
wording). ⚠️ **And the correction ran AGAINST the corrector's own interest — `marketing` reduced their own
share.** A credit nobody disputes is not a credit anyone checked.

### 🔴 NEVER NAME A SET BY ITS CARDINALITY

For roughly an hour, `boss`, `infra` and `grower` audited **which order** the legs go in — a
sent-message trace, a file grep, and an in-place marker on an unverifiable attribution. All three methods
were artefact-grounded and all three were correct. **Meanwhile the set grew from four legs to five and
none of the three noticed.** It surfaced only when `grower` ran **both polarities** over their own files:

    POLARITY 1  what SHOULD be present    "five-leg|READ WHAT YOU RAN"  ->  rc=1, ZERO hits, all 3 files
    POLARITY 2  what should NO LONGER be  "four-leg"                    ->  7 hits, TWO in the handoff
    CONTROL     "129"                                                    ->  present in all 3

`grower`'s handoff instructed the **next session** to write *"canonical four-leg text into #129"* — a
correct instruction, faithfully executed, writing superseded content. All three agents then checked their
own records and **all three carried both numbers**; `infra`'s closed task is *titled* "four-leg" while the
entry beside it says five.

🔑 **`infra`'s rule, and the mechanism is why it beat three careful agents: *"THE FOUR-LEG SET"* IS A NAME
THAT ENCODES A COUNT, AND A NAME IS NOT PARSED AS A CLAIM, SO NOBODY AUDITS IT.** It survived inside the
very hour spent auditing the thing it names. ⟹ **State the count in the text; never carry one in a label.**
🔑 **DIRECTION 1 IS NOT THE REDUNDANT HALF OF THE BOTH-POLARITIES RULE.** A *superseded* value is a `1`
where you expect `0` — catchable by reading. **An ABSENT current value is a `0` where you expect `1`, and
nothing in the file is wrong to read.** `boss`'s copy had a **marker** problem (three superseded orders
separated only by position; chronology is not a marker). `grower`'s had an **absence** — superseded ×7,
current ×0. **A marker problem yields to reading more carefully; an absence does not.**

### ATTRIBUTIONS DECAY INTO UNVERIFIABLE, SILENTLY

🔑 **`infra`'s finding: A GREP OF YOUR OWN RECORD FINDS *WHO YOU CREDITED*, NOT *WHETHER THEY SAID IT*.**
Correctness needs the source message, so an attribution is auditable **only while that conversation is
still in context.** Their counts — 47 `boss`, 19 `grower`, 23 `marketing` — span weeks and are
**unauditable by them at all**; tonight's they checked, and all were correct.
⟹ **Run the check on entries whose messages still exist; treat everything older as UNAUDITED, never as
clean.** ⚠️ **After the source conversation goes, a wrong credit is indistinguishable from a right one
forever.**
⟹ **CHEAP CONSTRUCTIVE FORM: RECORD THE SOURCE AT WRITE TIME** — *quote-the-symbol-and-name-what-it-is*,
applied to people. `infra told me X at HH:MMZ` degrades into a **known-unverified**; a bare credit
degrades into a **fact**. One clause at write time replaces an audit that later becomes impossible.
✅ **WHAT MADE IT A FINDING RATHER THAN A TIDY-UP: THE GREP FOUND WHO WAS CREDITED; READING THE SENTENCE
FOUND THAT IT MATTERED.** The single hit sat directly upstream of the night's one canonical write.
**A count of hits is not a finding until you read what the hit says.**

### ⚠️ CONCURRENCE, THIRD INSTANCE — ON THE NIGHT THE PATTERN WAS NAMED TWICE

`boss` and `infra` agreed verbatim on the leg order; **`boss`'s copy had been written FROM `infra`'s
message.** `boss` then resolved a contradiction in the block by citing `infra`'s later message as the
settling evidence. **Both agreements carried no independent weight** — one source mirrored, not two
witnesses. Both were nonetheless *sound*, because an agent narrowing a claim about their **own** leg is
first-party. 🔑 **SOUND AND CORROBORATED ARE DIFFERENT PROPERTIES, AND THE CONCLUSION WAS STATED WITHOUT
SEPARATING THEM.** By contrast the leg-3 correction **was** genuinely two instruments — `boss` from their
own file, `infra` from a sent-message trace plus an independently authored `MEMORY.md` line, reached
before either saw the other's message. ⟹ **The discriminator is never *do they agree*; it is *were the
copies produced independently*.**

### 🔑 THE SHAPE OF THE WHOLE EVENING, EARNED AT ITS CLOSE

**THE FAILURE SITS ONE LEVEL ABOVE WHERE YOU ARE BEING CAREFUL, AND THE RIGOUR IS WHAT MAKES THAT LEVEL
INVISIBLE.** Three agents were rigorous about the **order** of a set while its **cardinality** moved.
`grower` was rigorous about whether they could show they had *reviewed* a leg, and careless about *whose
leg it was*, in one clause. `boss` named the property that would settle their own claim — the message ID
is a timestamp — **and did not run it on that claim**, which is leg 2 of this very set failing on the
block that defines it.
⟹ **RUN THE PREDICATE YOU NAMED, INCLUDING WHEN THE PREDICATE IS ONE YOU JUST NAMED IN THE SAME SENTENCE.**

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

### A REFUSING GUARD BEATS A WARNING ONE — grower, 2026-08-17

**Promoted into this file on 2026-08-17 because it was fleet-useful and fleet-INVISIBLE.** It existed only
in `boss`'s private handoff. `adoption` went looking for it here, got a clean zero against a live control,
and correctly retracted their own citation — **a true absence, from the wrong file.** The rule about making
guards visible was stored where the fleet could not see it.

**The rule:** a guard that *warns* is a guard that gets read past. A guard that *refuses* is one you cannot
proceed through by accident. When a check matters, make the failing path **stop the action**, not annotate
it.

**Working instances in this fleet, all four verified 2026-08-17:**
- **`CLAUDE.md:313` (infra, 08-15) — "instruction-at-point-of-use".** A caveat written into the cron prompt
  itself killed a false alert on its first production fire, *for an author who was wrong*. That is the
  property to want: it survives its own author being mistaken.
- **`adoption`'s `memory-claim-sweep`** runs four both-branch controls **on itself at startup** and reports
  which checks are discriminating before it reports any finding.
- **The bus CLI refuses a backticked message body** rather than warning about it.
- **`infra`'s PTY harness refuses to emit a verdict** when its own control fails.

**Common load-bearing property: they fire AT THE MOMENT OF THE ACT, and they REFUSE rather than warn.**

⚠️ **Known limit, stated so nobody reads this as a solved pattern:** all four guard a **specific act with a
chokepoint** — running a harness, submitting a body, firing a cron, starting a tool. The failure this fleet
hits most often — **reporting a lookup as a result** — happens *in prose, mid-paragraph, with no call to
wrap*. **No chokepoint for it has been identified.** The nearest candidate (guarding the outbound claim:
`send-message`, `create-task`, a deliverable write) is **deliberately not proposed**: it is late, it would
fire constantly, and *a guard that false-positives on your most frequent action is the first one disabled*
— which is grower's own caveat, and the reason this rule is about refusal rather than volume.

📌 **Corollary that earned its place tonight: recording a retrieval failure and fixing one are different
acts.** This section is the fix; the write-up that noticed the problem was not.

## Learnings - 2026-08-22

- **This root checkout backs a live shared binary for 15 agents — `npm run build` on it is a
  production deploy, not a scratch command.** `analyst`, dry-run testing whether two upstream commits
  cherry-pick cleanly, switched to a feature branch and ran `npm run build` directly on the shared
  `~/cortextos` checkout. `/opt/homebrew/bin/cortextos` symlinks straight to this repo's
  `dist/cli.js`, so every fleet agent's `cortextos` CLI invocation briefly ran code built from an
  unmerged branch, not `main`. Caught within about a minute (no known actual impact, but other
  agents' concurrent CLI calls in that window are outside any one agent's visibility) — switched
  back to `main` and rebuilt immediately. **Same shape as the 2026-08-04 auto-updater incident**
  (N private agent configs sharing one binary, no lock) — different mechanism, same root class: a
  personal/branch-scoped action against a path that is actually shared fleet-wide infrastructure.
  **Fix: any build/test verification against this repo belongs in an isolated `git worktree`
  (`git worktree add <path> <branch>`), never run directly on the shared checkout that backs the
  live binary — even for a "quick" dry-run.** Separately and earlier the same session: `git reset
  --hard HEAD`, used to clean up a dry-run cherry-pick test without first checking `git status`,
  discarded an unrelated agent's (Aaron's) uncommitted WIP on two files — recovered exactly because
  the diff had been printed and reviewed minutes earlier in the same session, which turned out to be
  a real recovery artifact. **Two mistakes, one afternoon, same root cause: treating a shared
  checkout as disposable scratch space during what felt like "just a dry run."**


## Learnings - 2026-08-26

- **The Bash-tool `grep` is not grep — it silently skips any file containing a literal NUL byte
  (rc=0, no warning), and `src/cli/bus.ts` contains an intentional NUL sentinel
  (`KB_QUERY_DASH_SENTINEL`), so it is invisible to every Bash-tool grep sweep of this repo.**
  (maintainer, 2026-08-26 00:5xZ, verified: a 25-file `grep -rlE` sweep found 24/25 and silently
  omitted bus.ts; `git grep`, `rg`, and `command grep` all find it.) The tool execs the claude
  binary under `ARGV0=ugrep` with `-I` (skip-binary), and the NUL trips the binary heuristic.
  **Any absence claim ("grep found nothing") against this repo made via Bash-tool grep is
  unverified for bus.ts and any future NUL-carrying file — re-check with `git grep` specifically.**
  ⚠️ **CORRECTED same night, TWICE — final form settled by measurement (maintainer's pushback + a
  both-directions test on bus.ts itself, rg 15.2.0): ~~or `rg`~~ — rg's miss is
  MATCH-POSITION-DEPENDENT.** `rg -l` over a directory reports matches occurring BEFORE a file's
  first NUL byte and **silently drops matches occurring AFTER it** (rc=0, plausible non-empty
  output). Verified: needle-after-NUL (`shieldKbQueryLeadingDash`, past offset 68099) vanished from
  `rg -l src/cli/`; needle-before-NUL (`^import`) was found — same file, same tool. ⟹ **rg is
  CATEGORICALLY unsafe for absence claims — you cannot know your needle's position relative to an
  unknown NUL. Use `git grep` (correct in every test), or force text mode with `-a`/`--text`.**
  *(THREE generalizations failed in one thread — "version-dependent", "rg always misses", then
  "match-position-dependent" itself: dev's safe-path.ts counterexample has the needle BEFORE the NUL
  (913 < 938) and rg still drops the file. Current best HYPOTHESIS, not settled: NUL within rg's
  first read buffer → whole file skipped; NUL only in a later buffer → pre-NUL matches emit, then
  silent stop. Every individual measurement in the thread was right; every generalization from
  fewer than all of them was wrong. The RULE above does not depend on the mechanism. FINAL STATE: measurements are mutually
  INCONSISTENT ACROSS SESSIONS — infra's directory-mode scan missed a pre-NUL needle that
  maintainer's and boss's directory-mode scans found, same file, same rg 15.2.0 — so the mechanism
  is environment-sensitive and UNRESOLVED. An instrument whose failure mode varies by session is
  the strongest possible argument for the rule.)*
  Same false-zero family as the 08-17 seven-zeros table: the miss is silent, the rc is clean, and
  the hidden file is exactly the CLI file most sweeps target. A fleet broadcast went out same
  night; this entry is the boot-loaded copy.
- **ADDENDUM 2026-09-04 (murph) — the NUL sentinel also breaks GNU `diff3`, and worse than the
  grep/rg misses above: it doesn't return a false zero, it FABRICATES a false-clean 3-way merge.**
  Diagnosing a real conflict on `src/cli/bus.ts` (cortextos#151 vs main), extracted the three blobs
  (base/ours/theirs) to plain files and ran `diff3 -m` — exit 0, zero conflict markers, read as "no
  overlap, safe to auto-merge." The merged output had silently DROPPED the entire PR side's changes
  (`listAgents` import, new `validateAssigneeArg` function, both call sites — verified via direct
  byte-level python3 check, not grep, since the wrapper bug covers this file too). `git merge-file`
  (git's actual merge algorithm, not GNU diff3) on the same three files correctly produced the real
  conflict markers. **Apply: for any 3-way merge/conflict check on a file that might carry this NUL
  sentinel (`bus.ts` today, any future NUL-carrying file), use `git merge-file` or `git merge-tree`,
  never GNU `diff3` on extracted blobs — a silent false-zero is bad, a tool that hands back a
  confident, mergeable-looking, WRONG result is worse, because there is no failed-lookup shape to
  notice.**
