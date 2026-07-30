# DRAFT — upstream issue for grandamenium/cortextos (do not file without Aaron's sign-off)

Status: **draft only**. Written 2026-07-29 from the 2026-07-27 upstream-sync
review (merge `975a1e8c`). File against `grandamenium/cortextos` once approved.

---

Title: **Tier-2 handoff-fire circuit breaker can never trip for codex-app-server / opencode — the 10-min handoff grace outspaces its 15-min window**

## Summary

The cooperative-handoff loop backstop in `src/daemon/fast-checker.ts` counts
Tier-2 handoff fires in a rolling 15-minute window and trips at 3
(`ctxHandoffFires`, persisted via `loadCtxCircuit`/`saveCtxCircuit`). The
runtime-aware post-boot handoff grace window (`handoffGraceMs`) added for the
same runtimes suppresses soft context actions for **10 minutes** after each
fresh session start on `codex-app-server` and `opencode`.

Those two mechanisms interact arithmetically: after every handoff-driven
restart, the next Tier-2 fire is at least ~10 minutes away, so at most **2**
fires ever land inside any 15-minute window. The cap of 3 is unreachable for
exactly the runtimes the grace was widened for. (Claude agents keep the 2-min
grace, so the backstop still works there.)

## Impact

On a codex/opencode agent whose runtime fails to actually reset context on a
handoff restart — the regression the backstop's own comment names as its
reason to exist, and most plausible on these two newer adapters — the
handoff → restart treadmill loops indefinitely at ~10-minute cadence:
continuous restarts, fleet handoff-lease churn, and Telegram noise, with the
circuit breaker never tripping.

## Why the existing test doesn't catch it

The "cooperative-restart loop backstop trips the breaker" test simulates
refires by zeroing `ctxHandoffFiredAt` directly and never changes
`session_id`, so `ctxSessionStartedAt` stays 0 and the grace gate never
engages. It validates instantaneous refires that a real post-grace runtime
can never produce.

## Suggested fix

Either of:

1. Convert the Tier-2 backstop to consecutive-without-recovery semantics:
   increment per fire, reset only on confirmed recovery (usage back below the
   warn threshold), mirroring the Tier-3 force-restart counter. This is the
   same "windowed cap made unreachable by enforced spacing" pathology that
   motivated converting the Tier-3 counter, and the fix generalizes.
2. Size the window per runtime: `> 2 × handoffGraceMs(runtime) + slack`
   (i.e. ~25 min for codex/opencode), keeping windowed semantics.

Option 1 is preferred — it removes the arithmetic coupling entirely instead
of re-tuning it, and the codebase already has the pattern to copy.

Either way, the backstop test should drive the treadmill through `session_id`
changes with mocked time advancing past `handoffGraceMs(runtime)` so the
grace gate is actually exercised.
