---
name: context
description: Session hygiene — manage context window, compact history, sync with external state, and keep agent state lean. Use mid-session when the window gets heavy, before switching tasks, or when resuming after a break.
---

# context

## Purpose
Maintain a healthy context window across long sessions. Prevents drift, hallucination from stale context, and token waste. Keep agent grounded in current reality.

## Modes

### Window mode (default)
Audit the current context window:
- Estimate tokens used and remaining
- Identify the largest consumers (files, tool outputs, long exchanges)
- Flag stale references (files discussed but no longer relevant)
- Recommend what to /compact or explicitly drop

### Compact mode
Summarize earlier conversation history into a tight state block:
- What task is in progress
- What decisions have been made and why
- What files have been modified
- What's blocked or pending
- Output as a single structured block the agent can re-read cold

### Handoff mode
Prepare a session handoff document for resuming in a new context:
- Current task state
- Uncommitted changes summary
- Open questions
- Next concrete step
Writes to `.claude/session-handoff.md`

### Sync mode
Synchronize agent knowledge with external state. Run at session start or after external changes:
1. Read CLAUDE.md (or generate if missing via `recon`)
2. Run `git status` + `git log --oneline -10` — what changed since last session?
3. Check for new/modified files in key directories
4. Read `.claude/session-handoff.md` if it exists
5. Summarize: "here's the current state of the project"

#### Post-merge sub-mode
After a `git merge` or `git pull`:
1. Identify files changed in the merge
2. Re-read affected files
3. Flag conflicts with current working context
4. Update mental model of affected modules

#### Dependency sync sub-mode
Check if dependencies changed:
1. Read package.json / Cargo.toml / pyproject.toml
2. Compare against last known state
3. Flag new dependencies, removed dependencies, version bumps
4. Note any that affect current task

### Prune mode
Given a list of loaded files, identify which ones are no longer needed for the current task and can be dropped from context.

## When to use
- At session start (sync mode)
- Every ~30 messages in a long session
- Before switching from one task to another without starting fresh
- When you notice the agent referencing stale information
- After git pull/merge (sync post-merge)
- Before running a swarm session (compact first, seed after)

## Chains to
`compress` (agentConfig) if CLAUDE.md is bloated
`recon` (codebase) if pruning made you lose important context
`triage` (now in `plan`) if sync reveals unexpected changes