# Heartbeat Checklist - EXECUTE EVERY STEP. SKIP NOTHING.

This runs on your heartbeat cron (every 4 hours). Execute EVERY step in order.
Skipping steps = broken system. The dashboard monitors your compliance.

## Step 1: Update heartbeat (DO THIS FIRST)

```bash
cortextos bus update-heartbeat "<1-sentence summary of current work>"
```

If this fails, your agent shows as DEAD on the dashboard. Fix it before anything else.

**Note:** `update-heartbeat` (Step 1) and `log-event heartbeat agent_heartbeat` (Step 4) are NOT interchangeable.
- `update-heartbeat` refreshes the dashboard status-string field (what the dashboard reads to know you're alive).
- `log-event heartbeat …` appends to the activity feed (JSONL append-only event log).

Both are required every cycle. Skipping Step 1 leaves your dashboard view stale even though you're firing events.

**Beat on EVERY cron fire — even when idle-blocked, even when you're about to dive straight into work. Update-heartbeat is FIRST, before the work, every single fire.** Why (load-bearing): your heartbeat is the fleet's only freeze signal. A frozen session and an idle-but-not-beating session look identical from outside. If you skip the beat when idle ("nothing to report") or beat only *after* your work ("I'll update when done"), you look frozen — and the health-monitor burns cycles, or the real freeze next to you gets lost in the noise. If every healthy agent beats on every fire, a **missing** heartbeat becomes an *unambiguous* freeze signal. That one rule is what makes the whole fleet debuggable.

## Step 2: Sweep inbox for un-ACK'd messages

Messages arrive in real time via the fast-checker daemon — you don't need to poll for them. This step is a safety sweep for anything that wasn't ACK'd (e.g. a crash mid-processing).

Full reference: `.claude/skills/comms/SKILL.md`

```bash
cortextos bus check-inbox
```

For any messages returned: process and ACK each one:

```bash
cortextos bus ack-inbox "<message_id>"
```

Un-ACK'd messages are re-delivered after 5 minutes. Target: 0 un-ACK'd after this sweep.

## Step 3: Fleet health check (ORCHESTRATOR — do this before your own tasks)

Full reference: `.claude/skills/agent-management/SKILL.md`
Approvals reference: `.claude/skills/approvals/SKILL.md`
Human tasks reference: `.claude/skills/human-tasks/SKILL.md`

```bash
# Check all agent heartbeats
cortextos bus read-all-heartbeats

# Check all pending approvals
cortextos bus list-approvals --format json 2>/dev/null

# Check stale human tasks
cortextos bus list-tasks --project human-tasks --status pending 2>/dev/null
```

For each agent: if heartbeat is older than 5 hours, send an alert to that agent and flag in memory.

For any pending approval older than 4 hours: ping the user via Telegram.
For any [HUMAN] task pending longer than 4 hours: ping the user via Telegram.

```bash
# Example: ping user about stale approval or human task
cortextos bus send-telegram $CTX_TELEGRAM_CHAT_ID "Pending approval needs your decision: <title> — check dashboard"
cortextos bus send-telegram $CTX_TELEGRAM_CHAT_ID "[HUMAN] task waiting on you: <title> — blocking <agent> on <parent task>"
```

## Step 3b: Check own task queue + stale task detection

Full reference: `.claude/skills/tasks/SKILL.md`

```bash
cortextos bus list-tasks --agent $CTX_AGENT_NAME --status pending
cortextos bus list-tasks --agent $CTX_AGENT_NAME --status in_progress
```

- If you have pending tasks: pick the highest priority one
- If you have in_progress tasks older than 2 hours: either complete them NOW or update their status with a note
- If you have NO tasks: check GOALS.md for objectives, generate tasks for specialist agents

Stale tasks are visible on the dashboard. They make you look broken.

## Step 4: Log heartbeat event

Full reference: `.claude/skills/event-logging/SKILL.md`

```bash
cortextos bus log-event heartbeat agent_heartbeat info --meta '{"agent":"'$CTX_AGENT_NAME'"}'
```

## Step 5: Write daily memory

Full reference: `.claude/skills/memory/SKILL.md`

```bash
TODAY=$(date -u +%Y-%m-%d)
LOCAL_TIME=$(date +'%-I:%M %p %Z' 2>/dev/null || date)
MEMORY_DIR="$(pwd)/memory"
mkdir -p "$MEMORY_DIR"
cat >> "$MEMORY_DIR/$TODAY.md" << MEMORY

## Heartbeat Update - $(date -u '+%H:%M UTC') / $LOCAL_TIME
- WORKING ON: <task_id or "none">
- Status: <healthy/working/blocked>
- Inbox: <N messages processed>
- Next action: <what you will do next>
MEMORY
```

## Step 6: Check org goals state

Full reference: `.claude/skills/goal-management/SKILL.md`

```bash
cat $CTX_FRAMEWORK_ROOT/orgs/$CTX_ORG/goals.json
```

- If `daily_focus_set_at` is not today AND it is before 10 AM: trigger morning review now — read `.claude/skills/morning-review/SKILL.md`
- If `north_star` is empty: message user via Telegram to set it
- If any agent has an empty `goals.json` (focus and goals both empty): write their goals and regenerate GOALS.md

Also read your own GOALS.md for any manual overrides or notes you left yourself.

## Step 7: Resume work

Full reference: `.claude/skills/tasks/SKILL.md`

Pick your highest priority task and work on it. Tasks should trace back to your current goals.

When starting:
```bash
cortextos bus update-task "<task_id>" in_progress
```

When done:
```bash
cortextos bus complete-task "<task_id>" --result "<summary of what was produced>"
```

## Step 8: Guardrail self-check

Full reference: `.claude/skills/guardrails-reference/SKILL.md`

Ask yourself: did I skip any procedures this cycle? Did I rationalize not doing something I should have?

If yes, log it:
```bash
cortextos bus log-event action guardrail_triggered info --meta '{"guardrail":"<which one>","context":"<what happened>"}'
```

If you discovered a new pattern that should be a guardrail, add it to GUARDRAILS.md now.

## Step 9: Update long-term memory (if applicable)

Full reference: `.claude/skills/memory/SKILL.md`

If you learned something this cycle that should persist across sessions:
- Patterns that work/don't work
- User preferences discovered
- System behaviors noted
- Append to MEMORY.md

## Promotion check — is MEMORY.md behind today's daily memory?

**Run this BEFORE the KB re-ingest step below.** Nothing promotes between memory layers
automatically, and "MEMORY.md is current" and "MEMORY.md has not been touched in four hours"
otherwise produce the same output: none.

```bash
LATEST=$(ls -1 memory/2*-*-*.md 2>/dev/null | sort | tail -1)
if [ ! -f MEMORY.md ] || [ -z "$LATEST" ]; then
  MISS=""; [ -f MEMORY.md ] || MISS="MEMORY.md"; [ -n "$LATEST" ] || MISS="$MISS any memory/YYYY-MM-DD.md"
  echo "PROMOTION CHECK: NOT CHECKED — missing:$MISS (this is NOT a pass)"
else
  M=$(stat -f %m MEMORY.md 2>/dev/null || stat -c %Y MEMORY.md)
  D=$(stat -f %m "$LATEST" 2>/dev/null || stat -c %Y "$LATEST")
  GAP=$(( D - M ))
  if [ "$GAP" -gt 14400 ]; then
    echo "PROMOTION CHECK: UNPROMOTED — $LATEST is $((GAP/3600))h$(( (GAP%3600)/60 ))m newer than MEMORY.md (threshold 4h). Promote durable lessons to MEMORY.md NOW, before finishing this heartbeat."
  else
    echo "PROMOTION CHECK: OK — gap $((GAP/60))m vs $LATEST (threshold 4h)"
  fi
fi
```

**Three distinct outcomes on purpose.** `NOT CHECKED` is not a pass — a missing file must never read
as healthy. **Act on `UNPROMOTED` in this cycle**; deferring it is how the gap grew in the first place.

**Compares against the NEWEST daily memory file, not today's.** Looking only at today's file means that at every UTC midnight a real backlog silently becomes `NOT CHECKED` — the flag disappears exactly when yesterday's unpromoted work is still unpromoted.

**Threshold is one heartbeat interval (4h), matching the cron.** Bounded-latency detector, not
immunity: an agent that stops promoting is caught at the **next** heartbeat, so worst-case
onset-to-flag is ~2 intervals. A gap under 4h is by design invisible to it.

## Step 10: Re-ingest memory to knowledge base

Full reference: `.claude/skills/knowledge-base/SKILL.md`

Keep your memory collection searchable and current:

```bash
cortextos bus kb-ingest ./MEMORY.md ./memory/$(date -u +%Y-%m-%d).md \
  --org $CTX_ORG --agent $CTX_AGENT_NAME --scope private --force
```

This runs automatically on every heartbeat cycle. It ensures past experiences, user preferences, and learned patterns are semantically searchable for future tasks. Skip if GEMINI_API_KEY is not configured.

---

REMINDER: A heartbeat with 0 events logged and 0 memory updates means you did nothing visible.
Target: >= 2 events and >= 1 memory update per heartbeat cycle.
Invisible work is wasted work.
