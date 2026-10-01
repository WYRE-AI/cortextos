# Buzz/Nostr subsystem — parked, not adopted (2026-10-01 upstream sync)

Per boss's ruling: upstream's new Buzz/Nostr messaging subsystem (grandamenium/cortextos) is a
product decision for Aaron, not a merge decision. Files are KEPT on disk (future adoption
material); all call sites wiring it into the live daemon/CLI are STRIPPED so runtime behavior
matches pre-merge. This file is the map for whoever runs that future adoption session.

## Files kept on disk, unregistered (dead code until adopted)
- `src/buzz/{dispatcher,event,identity,index,relay-client}.ts` — the subsystem itself
- `bus/send-buzz.sh`
- `docs/runbook/buzz-adapter-setup.md`
- `src/cli/buzz.ts` — standalone CLI subcommand, kept but unregistered (see cli/index.ts below)

## Call sites stripped (clean auto-merges that silently wired it in — no conflict markers)
- `src/daemon/agent-manager.ts` — import of BuzzRelayClient/BuzzDispatcher/loadBuzzConfig/NostrEvent,
  `buzzClients` class field, `maybeRegisterBuzzAgent()` method + its call from `registerAgent()`,
  shutdown-path cleanup of org Buzz relay connections. STRIPPED.
- `src/cli/add-agent.ts` — `--buzz-channel <uuid>` option that scaffolds `buzz.json` for a new
  agent. STRIPPED (option removed).
- `src/cli/index.ts` — `import { buzzCommand } from './buzz.js'` + `program.addCommand(buzzCommand)`.
  STRIPPED (buzz.ts itself kept on disk, just not registered — resolved as part of my bucket).
- `src/daemon/fast-checker.ts` — KEPT, not stripped: `buzzMessages` queue field,
  `queueBuzzMessage()`, the drain-loop in `pollCycle()`, and the static
  `formatBuzzTextMessage()` formatter are all self-contained (no import from
  `src/buzz/*`, just a message-shaped queue mirroring the Telegram/Slack ones) and
  are now simply unfed since `agent-manager.ts`'s `maybeRegisterBuzzAgent()` call
  site (the only thing that ever called `queueBuzzMessage`) was stripped. Dead
  code, zero runtime effect, ready to wire back up on adoption — left in place
  rather than stripped per the "harmless and self-contained" carve-out. Separately
  (axis 1, not Buzz, noted here only for completeness): also stripped a clean
  non-conflicting `connector?: MessageConnector` field + constructor option that
  upstream's connector-abstraction PR had added to this file — unrelated to Buzz,
  follows the same "take ours, park full adoption" ruling as agent-manager.ts.

- `src/daemon/agent-process.ts` — stripped a clean non-conflicting `connector`
  field/constructor-option plus a whole `setConnector()`/`getConnector()` method
  pair (axis 1, not Buzz — same ruling, noted here for completeness). Nothing
  else in this file or in the resolved `agent-manager.ts` called them.

## Addendum: axis-1/axis-2 findings beyond Buzz, same "silent clean merge" shape

- **`src/cli/bus.ts`**: a dangling reference to the deleted `slack-routing.js`
  (`resolveGatedDisplayIdentity`/`GatedDisplayIdentity` — upstream's fail-closed
  persona/display-identity gate, exactly the hardening concept murph's follow-up
  task `task_1790871245210_64848240` is scoped to port later) was feeding THREE
  brand-new CLI commands (`send-slack`, `slack-test-send`,
  `slack-discover-channels`) that upstream added wholesale, built against their
  OWN `SlackAPI.postMessage(channel, message, identity)` 3-arg signature — which
  does not match our kept `src/slack/api.ts` (`postMessage(req)`, single object
  arg) at all. None of these three commands existed in our fork before this
  merge. Removed all three + both helper functions (`resolveSlackDisplayIdentity`,
  `resolveSlackBotToken`) — our existing `bus/send-slack.sh` (same name, kept by
  murph) already covers this. Worth re-deriving properly, not just re-pasting,
  whenever murph's identity-gate port lands — this merge's version was never
  compatible with our architecture to begin with.
- **`src/telegram/{index,media,poller,transcribe}.ts`** — the closest call of the
  whole sync. These 4 files showed as a clean, non-conflicting `M` (no conflict
  markers at all) because upstream's connector refactor turned them into 2-line
  `@deprecated` re-export shims pointing at `../connectors/telegram/*.ts`, and
  git's merge found nothing to conflict against since our side's real
  implementations didn't textually collide with a near-total deletion. Caught
  only by a deliberate post-resolution repo-wide grep for the connector import
  path, AFTER the main hunk-by-hunk pass was already done — a normal `git status`
  / conflict-marker sweep would never have surfaced this on its own. Restored all
  4 to our own implementation at their original path (`index.ts`/`transcribe.ts`
  byte-identical to the relocated copy minus import depth; `media.ts` likewise).
  `poller.ts` additionally got a genuine, self-contained upstream improvement
  ported IN rather than discarded: exponential backoff with jitter +
  `retry_after` 429-hint honoring (`computePollBackoffMs`/`RETRY_AFTER_CEILING_MS`,
  capped per-attempt, hint itself capped at 5min so a hostile/buggy hint can't
  freeze the poller for an hour) replacing the old fixed-interval
  log-and-continue — this has nothing to do with the connector abstraction, it
  just happened to be relocated alongside it. `tests/unit/telegram/poller.test.ts`
  had ALREADY been auto-merged correctly importing from the restored path with
  matching new backoff tests, so no test-side fix was needed.
  **Lesson for whoever reviews this merge next: a conflict-marker sweep is not a
  completeness check by itself — run a repo-wide grep for the new
  architecture's import paths (`connectors/`, `slack-routing`, `buzz/`) across
  the WHOLE tree after the hunk-by-hunk pass, not just within files that showed
  as UU.**

## To re-adopt later
1. Re-wire the 4 call sites above (git history has the exact upstream diff if easier than
   re-deriving).
2. `src/cli/add-agent.ts`'s buzz.json scaffolding assumed a `buzz-admin generate-key` operator
   step — check that tool still exists / is documented before re-enabling.
3. Confirm no naming collision with this fork's own future messaging-channel work.
