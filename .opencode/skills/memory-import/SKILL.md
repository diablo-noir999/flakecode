---
name: memory-import
description: Use when importing memories from external sources — other projects, documentation files, conversation exports, or structured data files into the project memory store.
---

# Memory Import

Import memories from external sources into the project memory store. Supports multiple input formats and provides validation before committing.

## When to Use

- Migrating from another project's memory store
- Importing knowledge from documentation files (AGENTS.md, README, etc.)
- Bootstrapping a new project with existing institutional knowledge
- Importing memories from conversation exports

## Supported Sources

### Markdown Files
Parse structured markdown into memory entries:
- Headers become categories
- Bullet points become individual memories
- Code blocks preserve technical details

### JSON/JSONL Files
Direct import of structured memory data:
```json
[
  { "category": "ARCHITECTURE", "content": "Uses PostgreSQL with Drizzle ORM" },
  { "category": "CONSTRAINTS", "content": "Must support Node 18+" }
]
```

### Conversation Exports
Extract memories from conversation histories:
- Identify decisions and their reasoning
- Extract bug fixes and their root causes
- Capture architectural choices and tradeoffs

## Import Process

1. **Parse** source into raw memory entries
2. **Validate** each entry has required fields (category, content)
3. **Deduplicate** against existing memories
4. **Score** importance based on content and source
5. **Commit** to memory store with provenance tag

## Deduplication

Before importing, check for existing memories:
- Exact match → skip
- Semantic overlap (>80% similarity) → flag for review
- Partial match → merge if complementary

## Output

```json
{
  "imported": 12,
  "skipped_duplicates": 3,
  "flagged_for_review": 1,
  "total_new": 12
}
```

## Rules

- Always preview before committing — show what will be imported
- Tag imported memories with source provenance
- Never overwrite existing memories without explicit confirmation
- Preserve the original category and importance when available
