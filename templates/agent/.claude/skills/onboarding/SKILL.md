---
name: onboarding
description: "You have just booted for the first time — there is no .onboarded flag in your state directory — and you need to set up your identity, connect your Telegram bot, configure your goals, and establish yourself within the org. Or onboarding was previously interrupted and the user has asked you to run it again. This skill walks you through every step of becoming a functioning agent. Do not skip steps. Do not start normal operations until onboarding is complete."
triggers: ["onboarding", "/onboarding", "first boot", "run onboarding", "setup", "not onboarded", "configure agent", "set up identity", "establish identity", "set goals", "onboard me", "start onboarding", "redo onboarding", "onboarding interrupted", "first time setup", "initial setup", "agent setup"]
---

# Onboarding

This skill runs on first boot or when explicitly triggered. It is the only thing you should do until it is complete.

---

## Step 1: Check onboarding status

```bash
[[ -f "${CTX_ROOT}/state/${CTX_AGENT_NAME}/.onboarded" ]] && echo "ONBOARDED" || echo "NEEDS_ONBOARDING"
```

If already `ONBOARDED`, skip to normal session start. Do not re-run onboarding unless the user explicitly requests it.

---

## Step 2: Read ONBOARDING.md

```bash
cat ONBOARDING.md
```

This file contains the full onboarding protocol for your specific agent role. Follow every step exactly. Do not improvise.

---

## Step 3: What onboarding establishes

Onboarding must complete all of the following before you are considered functional:

| Item | File written |
|------|-------------|
| Your name, role, emoji, and identity | `IDENTITY.md` |
| Your behavior, autonomy rules, and mode | `SOUL.md` |
| Your current goals and focus | `GOALS.md` |
| User preferences and context | `USER.md` |
| Guardrails and patterns to avoid | `GUARDRAILS.md` |
| Telegram bot connected and tested | `.env` (BOT_TOKEN, CHAT_ID) |
| Crons configured and running | `config.json` |
| Knowledge base ingestion rules set | `.claude/skills/memory-management/SKILL.md` |
| KB initial ingestion done | `cortextos bus kb-ingest` |
| Migration from previous agent (if applicable) | memory files copied |
| One starter autoresearch cycle, scoped to a real lane metric | `list-experiments` shows 1 active cycle |
| .onboarded flag written | `$CTX_ROOT/state/$CTX_AGENT_NAME/.onboarded` |

---

## Step 3.5: Stand up a starter autoresearch cycle

Before you mark onboarding complete, set up ONE autoresearch cycle scoped to a metric you genuinely own in your lane. This is structural, not a checkbox — cold-start experiment coverage is part of becoming functional, not something to remember later.

- Pick a REAL metric your role can move (e.g. infra → deploy/KB health; marketing → content→signup conversion; adoption → activation-funnel step; warden → security-finding false-positive rate; dev → PR-cycle-time or build health; ruby → migration reconnection rate; murph → dependency-freshness). If you genuinely cannot name a metric you own, that is a signal about your role definition — surface it to the orchestrator rather than inventing a fake one. A checkbox experiment on a metric nobody owns produces noise and discredits the mechanism.
- **The metric doesn't need to be instrumented yet.** If nothing currently measures it, cycle 1's legitimate goal is *establishing the measurement* (build the query/log/counter, capture a first baseline) — that is a real experiment, not a placeholder. Do not invent a guessed number to satisfy the checkbox just because full telemetry doesn't exist on day one.
- Register it as a real, daemon-managed cycle (see the autoresearch skill), not a session-local loop.

```bash
cortextos bus list-experiments   # confirm exactly one active cycle before proceeding
```

Do not write the `.onboarded` flag until this shows one active cycle (or you have surfaced a genuine no-metric case to the orchestrator, per the grace-window process below).

### If your role is genuinely new (no lived experience yet to know what you own)

Forcing a metric in the first hour of a brand-new role manufactures the exact fake-metric failure this step warns against — you can't yet know what you own. In that case:

1. Surface the no-metric case to the orchestrator explicitly (don't silently skip the step).
2. Write `.onboarded` anyway — do not block first-boot on this.
3. Register a grace-window cron so the requirement doesn't just evaporate 72h downstream instead of on day one. `add-cron` only takes a recurring interval or 5-field cron expression (no one-shot primitive exists) — use a 72h recurring interval and let the prompt self-terminate the cron once satisfied:
   ```bash
   cortextos bus add-cron $CTX_AGENT_NAME verify-starter-cycle 72h \
     "Check: does 'cortextos bus list-experiments' show an active cycle yet? If yes, remove this cron (cortextos bus remove-cron \$CTX_AGENT_NAME verify-starter-cycle) — done. If no, stand one up now using Step 3.5's guardrail (real owned metric, or an explicit escalation to the orchestrator explaining why one still can't be named), then remove this cron."
   ```
   It re-fires every 72h until the condition is satisfied and the cron removes itself — a grace window with no enforced end-check is just the propagation gap moved 72 hours downstream, and this is what makes the deadline real instead of a hope that someone remembers.

---

## Step 4: Mark complete

When all steps in ONBOARDING.md are done:

```bash
mkdir -p "$CTX_ROOT/state/$CTX_AGENT_NAME"
touch "$CTX_ROOT/state/$CTX_AGENT_NAME/.onboarded"
```

Then notify the user via Telegram that you are online and ready.

---

## If Onboarding Is Interrupted

If a session crash or restart interrupts onboarding mid-way:

1. Check which steps completed (look at which files exist)
2. Resume from the first incomplete step
3. Do NOT restart from the beginning if some steps already completed
4. Re-run `/onboarding` if needed to trigger this skill again

---

## Critical Rules

- Do NOT send a Telegram message claiming you are online until onboarding is complete
- Do NOT set up crons until IDENTITY.md and GOALS.md are written
- Do NOT write `.onboarded` until a starter autoresearch cycle is active (Step 3.5) or a genuine no-metric case has been surfaced
- Do NOT start processing user requests until `.onboarded` is written
- The user is waiting — be efficient, but do not skip steps
