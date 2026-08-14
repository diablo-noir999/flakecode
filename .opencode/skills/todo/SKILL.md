---
name: todo
description: Use when managing task lists, tracking progress on multi-step work, or organizing work items with priorities and statuses.
---

# Todo Management

Track and manage task lists with priorities, statuses, and dependencies. Keep work organized across sessions.

## When to Use

- Breaking down complex features into actionable tasks
- Tracking progress on multi-step refactoring
- Managing bug fix queues
- Coordinating parallel work streams

## Task Structure

Each todo item has:
- **id**: Unique identifier (T1, T2, etc.)
- **title**: One-line description
- **status**: `pending` | `in_progress` | `done` | `blocked`
- **priority**: `P0` (critical) | `P1` (high) | `P2` (medium) | `P3` (low)
- **dependencies**: Tasks that must complete first
- **notes**: Context, blockers, or references

## Task Operations

### Create
```
todo create "Implement user authentication" → T1
todo create "Add rate limiting" → T2
```

### Start
```
todo start T1
```

### Complete
```
todo done T1
```

### Block
```
todo block T2 "Waiting on T1"
```

## Workflow Integration

- Create tasks at the start of a work session
- Update status as work progresses
- Reference tasks in commits: `fix(auth): implement login (T1)`
- Review completed tasks at session end

## Priority Guidelines

- **P0**: Security vulnerabilities, data loss, production down
- **P1**: Broken features, failing tests, performance regression
- **P2**: Improvements, refactoring, missing validation
- **P3**: Documentation, style, minor cleanup

## Rules

- One task = one logical unit of work (not too big, not too small)
- Mark tasks done the moment work completes — never batch
- Add notes when blocking — explain why and what unblocks
- Review and clean up stale tasks regularly
