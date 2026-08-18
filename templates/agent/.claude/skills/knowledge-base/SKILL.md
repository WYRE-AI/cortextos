---
name: knowledge-base
description: "You are about to research a topic, answer a factual question about the org, or look up context about a person, project, or tool. Before searching the web or asking the user, query the knowledge base first — the answer may already exist from a previous research session. After you complete any substantial research, ingest your findings so future agents do not repeat the same work. The KB is the org's shared memory across all agents."
triggers: ["knowledge base", "kb", "search knowledge", "query knowledge", "ingest", "rag", "semantic search", "what do we know about", "check knowledge", "save to kb", "index documents", "search docs", "look up", "query kb", "kb query", "kb ingest", "store research", "preserve findings", "check existing knowledge", "has anyone researched", "kb setup", "initialize knowledge base"]
---

# Knowledge Base (RAG)

The knowledge base lets you search indexed documents using natural language — memory files, research notes, org knowledge. Query before searching externally. Ingest after completing research.

---

## Query (before starting research)

```bash
cortextos bus kb-query "your question" \
  --org $CTX_ORG \
  --agent $CTX_AGENT_NAME
```

Use this:
- Before starting any research task — check if knowledge already exists
- When referencing named entities (people, projects, tools) — check for existing context
- When answering factual questions about the org — query before searching externally

---

## Ingest (after completing research)

```bash
# Ingest to shared org collection (visible to all agents)
cortextos bus kb-ingest /path/to/docs \
  --org $CTX_ORG \
  --scope shared

# Ingest to your private collection (only visible to you)
cortextos bus kb-ingest /path/to/docs \
  --org $CTX_ORG \
  --agent $CTX_AGENT_NAME \
  --scope private
```

Ingest after:
- Completing substantive research worth sharing with the whole org — **`--scope shared`** (always ingest your findings)
- Writing or updating your own MEMORY.md, daily memory, or handoff docs — **`--scope private --agent $CTX_AGENT_NAME`**, always, even when the entry documents fleet-wide findings. A daily memory file mixes personal log with research; ingesting the whole file to `shared` (2026-08-17 incident: a ~6,000-line daily memory file landed in `shared-wyre`, became 60% of that collection, and dominated retrieval for every agent) buries genuine shared findings under bulk personal content instead of surfacing them. If a memory entry contains something the whole org should find by search, extract just that finding into its own doc and ingest THAT to `shared` — don't ingest the memory file itself there.
- Learning important facts about the org, users, or systems that are not yet written down anywhere — **`--scope shared`** if the fact belongs in shared org knowledge, **`--scope private`** if it's personal working context

---

## List Collections

```bash
cortextos bus kb-collections --org $CTX_ORG
```

---

## Checking Available Collections

List all KB collections for the org:

```bash
cortextos bus kb-collections --org $CTX_ORG
```

If no collections appear, the KB may not be configured yet — check that `GEMINI_API_KEY` is set in `orgs/$CTX_ORG/secrets.env`.

---

## Workflow Pattern

```
1. User asks question about <topic>
2. kb-query "<topic>" — check existing knowledge
3. If found → answer from KB, cite source
4. If not found → research externally
5. After research → kb-ingest findings
6. Answer user with fresh knowledge now in KB
```
