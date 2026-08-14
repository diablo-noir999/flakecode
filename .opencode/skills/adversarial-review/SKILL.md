---
name: adversarial-review
description: Cross-perspective adversarial code review. Spawns 2-3 specialized reviewers (security, performance, correctness) in parallel, each from a different angle, then merges and deduplicates findings into a unified report. Use when: "adversarial review", "cross-review", "multi-perspective review", "review from multiple angles", or after a code change needs rigorous validation.
---

# Adversarial Review

You are the orchestrator for a cross-perspective adversarial review. The goal is to catch issues that single-perspective reviews miss by having specialized reviewers attack the same code from different angles.

## Workflow

### Step 1 — Identify the diff scope

Determine what to review:
- If a specific diff or branch is mentioned, use that
- If a file set is named, read those files
- If neither, ask the user what to review (don't guess)

Get the diff: `git diff <base-ref>` or read the specified files.

### Step 2 — Spawn parallel reviewers

Spawn 2-3 `general` subagents in parallel, each with a different persona injected from `references/`. Each reviewer gets:
- The diff or file contents
- Their persona (read from the references directory)
- An instruction to return ONLY structured findings

Recommended reviewers (pick 2-3 based on the change):

| Change type | Reviewers |
|-------------|-----------|
| API / endpoint | security, correctness |
| Data processing | performance, correctness |
| Auth / payments | security, correctness, performance |
| Infrastructure / CI | security, performance |
| UI / frontend | correctness, performance |
| Database / ORM | performance, correctness |

### Step 3 — Collect and merge

When all reviewers return, merge findings:
1. **Deduplicate** — same file:line + same issue type = one finding (keep the more detailed one)
2. **Resolve conflicts** — if reviewers disagree on severity, keep the higher severity
3. **Tag sources** — each finding shows which reviewer(s) flagged it

### Step 4 — Present unified report

Format the output as:

```
## Adversarial Review

**Reviewers:** <list of perspectives used>
**Scope:** <what was reviewed>

### Findings

| # | Severity | Category | Finding | Evidence | Reviewers |
|---|----------|----------|---------|----------|-----------|

### Summary

<1-2 sentences: total findings, most critical theme, recommended next step>
```

Severity scale: P0 (critical — ship blocker) > P1 (high — fix before merge) > P2 (medium — fix soon) > P3 (low — nice to have).

## Rules

1. **Each reviewer operates independently.** Never let one reviewer's findings influence another's prompt.
2. **Findings need evidence.** Every finding must cite `file:line` or a specific code pattern. No vibes.
3. **Dedup is structural, not semantic.** Same file:line + same category = duplicate. Different file:line = separate finding even if the theme is similar.
4. **Don't over-review.** If the diff is trivial (<20 lines, no risk signals), use 1-2 reviewers, not 3.
5. **Respect reviewer boundaries.** Security reviewer finds vulns, not style issues. Performance reviewer finds hot paths, not logic bugs. Each stays in their lane.