---
name: memory-export
description: Use when exporting memories for backup, migration to another project, or generating documentation from accumulated project knowledge.
---

# Memory Export

Export the project memory store to portable formats for backup, migration, or documentation generation.

## When to Use

- Creating backups of project knowledge
- Migrating memories to a new project or tool
- Generating documentation from accumulated decisions
- Sharing institutional knowledge with team members

## Export Formats

### Markdown (Human-Readable)
Organized by category with metadata:
```markdown
# Project Memory: Auth System

## ARCHITECTURE
- Uses JWT with RS256 signing
- Refresh tokens stored in httpOnly cookies

## BUG_FIXES
- auth.ts:87 — was checking iat, must check exp (fixed 2024-01-10)
```

### JSON (Machine-Readable)
Full memory data with all metadata:
```json
{
  "project": "my-project",
  "exported_at": "2024-01-15T10:00:00Z",
  "memories": [
    {
      "id": "mem_1",
      "category": "ARCHITECTURE",
      "content": "Uses JWT with RS256 signing",
      "importance": 80,
      "created_at": "...",
      "retrieval_count": 12
    }
  ]
}
```

### Knowledge Graph (Relationships)
Export memory relationships and dependencies:
```json
{
  "nodes": [...],
  "edges": [...]
}
```

## Export Options

- **filter**: Export only specific categories or importance ranges
- **include_metadata**: Include timestamps, retrieval counts, provenance
- **redact**: Remove sensitive information (tokens, keys, credentials)
- **compress**: Minimize output size by removing low-value memories

## Output

Report what was exported:
```json
{
  "format": "markdown",
  "memories_exported": 42,
  "categories": ["ARCHITECTURE", "BUG_FIX", "CONSTRAINTS"],
  "file_path": "memory-export.md"
}
```

## Rules

- Never export raw database dumps — always format for readability
- Redact secrets, tokens, and credentials automatically
- Include export metadata (date, project, version) in the output
- Preserve memory relationships in graph exports
