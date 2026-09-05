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

## Step 3: Check task queue + stale task detection

Full reference: `.claude/skills/tasks/SKILL.md`

```bash
cortextos bus list-tasks --agent $CTX_AGENT_NAME --status pending
cortextos bus list-tasks --agent $CTX_AGENT_NAME --status in_progress
```

- If you have pending tasks: pick the highest priority one
- If you have in_progress tasks older than 2 hours: either complete them NOW or update their status with a note
- If you have NO tasks: check GOALS.md for objectives, then message the orchestrator

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

## Step 6: Check GOALS.md

Read GOALS.md. Goals are refreshed daily by the orchestrator each morning.

- If goals were updated today: you should already have tasks. If not, create them now — see `.claude/skills/tasks/SKILL.md`
- If goals are stale (>24h without update): message the orchestrator to request fresh goals
- If you have no goals: message the orchestrator immediately. Don't idle.

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

If you are blocked, see `.claude/skills/human-tasks/SKILL.md` for the human task and approval workflow.
If you need an approval before acting, see `.claude/skills/approvals/SKILL.md`.

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


### 🔴 KB-INGEST CANONICAL RULE v2 (2026-08-20, boss) — supersedes any timeout-based ingest guidance elsewhere in this file

Fleet-wide convergence, task `task_1786847095641_72740459` (full derivation there — 6 agents, one night):
kb-ingest time scales with file size / chunk count, so any FIXED timeout eventually fails as memory files
grow — it is not a service defect and a bigger number is not a fix. Separately: the harness's own Bash-tool
default call cap (~120s) kills an ingest regardless of an inner `timeout N` argument, so several "raised the
timeout and it still failed" reports tonight never actually tested a raised timeout at the tool-call layer.

**RUN EACH FILE AS A BACKGROUND / UNCAPPED CALL. NEVER GATE COMPLETION ON A TIMEOUT, EXIT CODE, OR ELAPSED TIME.**
```bash
cortextos bus kb-ingest "$f" --org "$CTX_ORG" --agent "$CTX_AGENT_NAME" --scope private --force \
  > "/tmp/kb-ingest-${CTX_AGENT_NAME}-$(date -u +%Y%m%d-%H%M%S)-$$-$(basename "$f").log" 2>&1 &
```
`$$` alone collides across concurrent agent sessions on a shared host — `$CTX_AGENT_NAME` in the
filename is required, not cosmetic (infra, 2026-08-25: a single heartbeat's log came back
interleaved with 7+ other agents' ingest output under the un-namespaced path). `$CTX_AGENT_NAME-$$`
alone is still not sufficient: PIDs get reused across days on a long-running box, and time-of-day-only
labels (`hb2342`, `hb0342`) collide identically — infra, 2026-09-05, caught its own prior-day 429 log
being misread as current via an hb-time-only filename. The UTC date+time component kills both the
cross-agent and cross-day/cross-hour collisions in one form.

⚠️ **`${BASHPID}` was tried and reverted the same day (CodeRabbit's original suggestion on PR #178):
it is a BASH-ONLY special variable and is UNDEFINED in zsh, which is the actual shell every agent's
Bash tool (and this box's `$SHELL`) executes commands in — verified directly (`ZSH_VERSION` set,
`BASH_VERSION` empty, `${BASHPID}` expands to nothing). Shipping it produced literal double-hyphen,
empty-differentiator filenames in the real execution environment despite passing verification via an
explicit `bash script.sh` subprocess — a different, non-representative shell context. `$$` remains
the working differentiator here; it does not distinguish two `&`-launched siblings from the exact
same loop iteration, but the Step 10 loop always launches DISTINCT files per iteration (basename
already differentiates), so that theoretical gap does not occur in the documented usage.** PID
remains only as the final tiebreaker
for two calls landing in the same second.

The only valid completion signal is the literal text `Ingest complete` appearing in that log — not `rc=0`,
not a chunk count alone, not silence. If it hasn't appeared by the time you move on to other work, check
back next cycle rather than declaring failure; do not kill the process and do not infer failure from elapsed
time.

Each file (`MEMORY.md`, today's daily, yesterday's daily) still gets its own independent attempt regardless
of another file's outcome — a `MEMORY.md` miss is not a reason to skip the daily file (infra's finding,
2026-08-20).

This does **not** replace the 503/429 retry rules elsewhere in this section — those cover an intermittent
embedding-service-availability failure (2026-08-18), a different phenomenon from the size-scaling problem
this rule fixes. Both can be true in the same cycle; one diagnosis does not rule out the other.

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
