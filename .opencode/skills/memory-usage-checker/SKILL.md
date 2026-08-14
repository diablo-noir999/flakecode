---
name: memory-usage-checker
description: Use when auditing memory store health, checking retrieval patterns, or identifying underused and overused memories to optimize the memory system.
---

# Memory Usage Checker

Audit the memory store to understand how memories are being used, which ones are retrieved most/least, and where the memory system could be improved.

## When to Use

- Periodic health check of the memory store
- Before a major refactor to understand what knowledge is actively used
- When memory retrieval seems slow or noisy
- To identify memories that should be promoted or pruned

## Usage Metrics

### Retrieval Statistics
- **retrieval_count**: How often each memory is retrieved
- **last_retrieved_at**: When the memory was last accessed
- **seen_count**: How many sessions have seen this memory

### Health Indicators
- **Active**: Retrieved in the last 7 days
- **Dormant**: Not retrieved in 30+ days
- **Stale**: References code that no longer exists
- **Orphaned**: Never retrieved since creation

### Category Distribution
Count memories per category to detect imbalances:
- Too many LESSONS_LEARNED but few ARCHITECTURE entries?
- Missing CONSTRAINTS or CONFIG_VALUES?
- Duplicate memories in different categories?

## Recommendations

Based on metrics, suggest:
- **Promote**: High-value dormant memories that should be refreshed
- **Prune**: Stale/orphaned memories consuming space
- **Merge**: Overlapping memories that could be consolidated
- **Split**: Large memories covering multiple topics

## Output Format

```json
{
  "total_memories": 42,
  "by_category": { "ARCHITECTURE": 12, "BUG_FIX": 8, ... },
  "by_health": { "active": 20, "dormant": 15, "stale": 5, "orphaned": 2 },
  "top_retrieved": [{ "id": "mem_1", "retrieval_count": 23, "content_preview": "..." }],
  "never_retrieved": [{ "id": "mem_5", "content_preview": "..." }],
  "recommendations": [
    { "action": "prune", "id": "mem_5", "reason": "Created 60 days ago, never retrieved" }
  ]
}
```

## Rules

- This is a read-only audit — never modify memories directly
- Present findings with actionable recommendations
- Focus on the most impactful improvements first
