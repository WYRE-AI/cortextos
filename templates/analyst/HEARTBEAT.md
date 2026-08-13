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

## Step 2: Check inbox

```bash
cortextos bus check-inbox
```

Process ALL messages. ACK every single one:

```bash
cortextos bus ack-inbox "<message_id>"
```

Un-ACK'd messages are re-delivered in 5 minutes. Do not ignore them.
Target: 0 un-ACK'd messages after this step.

## Step 3: System health check (ANALYST — do this before your own tasks)

Full reference: `.claude/skills/agent-management/SKILL.md`

```bash
cortextos bus read-all-heartbeats        # all agent heartbeats
cortextos bus list-crons <agent>         # per-candidate: cron last-fire vs its heartbeat
```

**Raw heartbeat-age is NOT a reliable freeze signal — it false-positives on idle and on fire-batching.** A >5h heartbeat is a *candidate*, not a verdict. Use the freeze-test:

**The reliable signal: did the agent process its MOST-RECENT DELIVERED fire?** — NOT "is the heartbeat older than some fire timestamp." The daemon **batches** queued fires: after a quiet gap it delivers them together, so an intermediate fire shows as "fired" in `list-crons` but never produced a separate invocation → a healthy agent legitimately has no heartbeat for it. Age-based detection reads that as a freeze; it isn't.

Freeze-test, per stale candidate:
1. **Don't escalate on raw age.** Wait for the recovery signal — a fire that *just* fired may be processed any moment (batched agents can lag up to a full inter-fire interval). Re-check after it lands.
2. **Decisive tell — did others revive while this one didn't?** When a shared fire (or a fleet `--continue` reload) revives the rest of a stale cluster but one agent stays stuck, that one is frozen (the reviving fire came and went). A wide reload is a free test: if everyone returns fresh except one, that one is down.
3. **Cross-check the watchdog.** `[watchdog] <agent> alive` means the session *process* is up → stale heartbeat there is idle-suppression, not a dead session.

Escalate (calibrated — include the *evidence*, not just the age):
```bash
# CONFIRMED freeze (failed the fire-test, batching ruled out):
cortextos bus send-message $CTX_ORCHESTRATOR_AGENT normal "Agent <name> FROZEN — missed <fire>, others revived. Recommend restart."
cortextos bus log-event action agent_unresponsive warning --meta '{"agent":"<name>","status":"confirmed-freeze","evidence":"<missed-fire>"}'
```
- **Ambiguous** (missed fires but could be batching): DO NOT escalate yet — name it, watch the next fire.
- **Impact-scale urgency:** a frozen idle/gated agent (nothing in flight) is low-urgency; the **orchestrator** frozen is high — and it can't restart itself, so THAT escalation goes to the operator (human), not into the orchestrator's own dead inbox.
- **Never wake the principal on ambiguous data.** A false "systemic freeze!" to the human is worse than a few hours' wait.

## Step 3b: Check own task queue + stale task detection

```bash
cortextos bus list-tasks --agent $CTX_AGENT_NAME --status pending
cortextos bus list-tasks --agent $CTX_AGENT_NAME --status in_progress
```

- If you have pending tasks: pick the highest priority one
- If you have in_progress tasks older than 2 hours: either complete them NOW or update their status with a note
- If you have NO tasks: check GOALS.md for objectives, then message the orchestrator

Stale tasks are visible on the dashboard. They make you look broken.

## Step 4: Log heartbeat event

```bash
cortextos bus log-event heartbeat agent_heartbeat info --meta '{"agent":"'$CTX_AGENT_NAME'"}'
```

## Step 5: Write daily memory

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

## Step 6: Check GOALS.md

Read GOALS.md for any new objectives from the user.
If goals changed since last check, create tasks to address them:

```bash
cortextos bus create-task "<title>" --desc "<description>" --assignee $CTX_AGENT_NAME --priority normal
```

## Step 7: Resume work

Pick your highest priority task and work on it.

When starting:
```bash
cortextos bus update-task "<task_id>" in_progress
```

When done:
```bash
cortextos bus complete-task "<task_id>" "<summary of what was produced>"
```

## Step 8: Update long-term memory (if applicable)

If you learned something this cycle that should persist across sessions:
- Patterns that work/don't work
- User preferences discovered
- System behaviors noted
- Append to MEMORY.md

---

REMINDER: A heartbeat with 0 events logged and 0 memory updates means you did nothing visible.
Target: >= 2 events and >= 1 memory update per heartbeat cycle.
Invisible work is wasted work.
