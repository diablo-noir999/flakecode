---
name: brain-map
description: Generate an Obsidian-style knowledge vault from session checkpoints, memory DB entries, and knowledge graph data. Creates an interconnected map at .mimocode/context/ with raw/wiki/output structure.
---

# brain-map

## Purpose
Transform scattered session data into a structured, interconnected knowledge hierarchy at `.mimocode/context/`. Inspired by Karpathy's Obsidian RAG pattern (raw → wiki → output) and the Information Hierarchy concept. This is the `/brain-map` command.

## Modes

### Build mode (default)

Runs the full pipeline: gather → raw → wiki → output.

#### Phase 1: Gather Data

Collect raw material from two sources:

1. **Session checkpoints** — use `bash` to list and read checkpoint files:
   ```
   ls ~/.local/share/mimocode/memory/sessions/*/checkpoint.md
   ```
   Read each checkpoint file. Extract sections: topic, active intent (§1), task tree (§4), current work (§5), discovered knowledge (§7), design decisions (§10).

2. **Memory DB** — use `memory_search` with broad queries (mode: fts) to retrieve all memories. Categories to query: `PROJECT_RULES`, `ARCHITECTURE`, `BUG_FIXES`, `LESSONS_LEARNED`, `CONSTRAINTS`, `CONFIG_VALUES`, `NAMING`, `USER_PREFERENCES`.

3. **Knowledge graph** — if the knowledge graph is populated, note node/edge counts for the index.

#### Phase 2: Create Raw Staging

Create directory structure with `bash` (`mkdir -p`), then write files with the `write` tool.

```
.mimocode/context/raw/sessions/<session-id>.md
.mimocode/context/raw/memories/<category>.md
```

- **Sessions**: one file per session containing the full extracted checkpoint sections (preserve original text, do not summarize).
- **Memories**: one file per category listing all memories with timestamps and content.

#### Phase 3: Create Wiki (Codified Knowledge)

Write these files under `.mimocode/context/wiki/`:

1. **`index.md`** — Hub note:
   ```yaml
   ---
   created: YYYY-MM-DD
   tags: [brain-map, index]
   ---
   ```
   - Brief project overview (synthesized from most recent checkpoint §5 and §10)
   - Links to all other wiki notes via `[[wiki/note-name]]`
   - Stats: session count, memory count, graph node/edge count

2. **`architecture.md`** — Cross-session design decisions:
   - Merge all §10 (Design decisions) from all sessions
   - Merge `ARCHITECTURE` category memories
   - Deduplicate, tag with `#architecture` `#decision`
   - Wikilinks to related topic notes

3. **`progress.md`** — Done vs remaining:
   - Done: completed tasks from §4 task trees, tagged `#completed`
   - Remaining: §2 (next concrete action), §11 (open notes), tagged `#remaining`
   - Links to relevant session notes

4. **`rules.md`** — Project rules:
   - All `PROJECT_RULES` category memories, tagged `#rule`

5. **`topics/<topic>.md`** — One per major topic discovered from memory content and checkpoint sections:
   - Each links back to `[[wiki/index]]`
   - Frontmatter includes `related: ["wiki/index"]`

#### Phase 4: Create Output Deliverables

Write under `.mimocode/context/output/`:

1. **`status.md`** — Current project snapshot:
   - Active intent from most recent session
   - Current task tree status
   - Files being worked on
   - Live resources

2. **`session-map.md`** — Chronological timeline:
   - Each session as a timeline entry (date, topic, key outcomes)
   - Wikilinks to session raw notes and related wiki topics

### Merge mode

Invoke as `/brain-map merge`:

1. Read two `.mimocode/context/` directories (source and target)
2. Find overlapping topics by name
3. Merge: deduplicate memories, combine timelines, merge wikilinks
4. Write merged result to the target vault

## Conventions

- **Wikilinks**: `[[wiki/topic-name]]` or `[[wiki/topics/specific-topic]]`
- **Tags in frontmatter**: `#architecture`, `#bug-fix`, `#completed`, `#remaining`, `#rule`, `#decision`
- **Frontmatter on every note**:
  ```yaml
  ---
  created: YYYY-MM-DD
  tags: [tag1, tag2]
  related: ["wiki/index"]
  ---
  ```
- **Date format**: YYYY-MM-DD

## Rules

1. ALWAYS create directory structure first (`mkdir -p`)
2. ALWAYS use the `write` tool for file creation (not `edit`)
3. Preserve ALL original content — include full checkpoint sections, do not summarize
4. Ensure every wiki note links back to `wiki/index`
5. If no sessions exist yet, create a minimal `index.md` noting the vault is empty
6. One topic note per major theme — split when a topic gets too large

## Chains to
`context` (handoff) if vault generation is part of session wrap-up
`checkpoint` if you want to save the vault state as a milestone