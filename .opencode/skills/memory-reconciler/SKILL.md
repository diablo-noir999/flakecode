---
name: memory-reconciler
description: Use when memory entries conflict with actual codebase state, when deduplicating redundant memories, or when merging overlapping knowledge entries into a single authoritative record.
---

# Memory Reconciler

Reconcile memory entries against the actual codebase state and against each other. Detects duplicates, resolves conflicts, and merges overlapping knowledge into authoritative records.

## When to Use

- Memory entries contradict each other or the current code
- Multiple memories describe the same concept in different ways
- After large refactors, memories reference code that no longer exists
- Periodic maintenance to keep the memory store clean and accurate

## Reconciliation Process

### 1. Conflict Detection

Compare memory entries for contradictions:
- Same file/rule described differently
- Outdated information superseded by newer decisions
- Conflicting architectural descriptions

### 2. Duplicate Detection

Use `normalized_hash` to find near-duplicates:
- Same content with different wording
- Same concept at different levels of detail
- Entries that say the same thing in different categories

### 3. Staleness Check

Verify memories against current codebase:
- Does the referenced file still exist?
- Is the described behavior still accurate?
- Has the code changed since the memory was created?

### 4. Merge Strategy

When combining memories:
- Keep the most recent and specific version
- Preserve all unique facts from both entries
- Update the category if the merged content changes type
- Bump importance score if the combined entry is more valuable

## Output Format

For each reconciliation action:
```json
{
  "action": "merged" | "superseded" | "deleted" | "updated",
  "memory_ids": ["mem_1", "mem_2"],
  "reason": "Description of why this action was taken",
  "new_content": "Merged content (if applicable)"
}
```

## Rules

- Never delete memories without a reason — supersede instead
- Preserve the most specific and recent information
- Log all reconciliation actions for auditability
- Run reconciliation periodically, not on every memory write
