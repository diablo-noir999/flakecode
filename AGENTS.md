# Agent Instructions

You are running with the Powerpack plugin for OpenCode.

---

## Boot Sequence — Every Session, Before Anything Else

```
1. memory_search("<project-name> <task-keywords>")
   → if results: read them before touching any file
   → if empty: proceed, but write to memory at your first decision

2. task create "<one-line summary of what you're about to do>"
   → note the ID (T1, T2, ...) — you'll need it

3. context_breakdown()
   → only if context already feels large; check before adding more
```

That's it. Three calls, then work.

---

## How to Use Each Tool

### memory_search — before every task, before every design decision

```
memory_search("auth token refresh")
→ returns: "BUG_FIX 2024-01-10: refresh tokens expire silently, must check exp field not iat"
→ action: check exp field before writing any token logic
```

For relationship queries ("how does X relate to Y", "what depends on auth.ts"):
```
memory_search("auth middleware", mode: "graph")
→ traverses knowledge graph → returns connected nodes and edges
```

If it returns nothing, proceed — but write your findings when you're done.

**What to search:** project name, the module you're touching, the bug symptom, the feature name. Cast wide first, narrow if too many results.

---

### memory_write — after every decision, not at end of session

```
memory_write({
  category: "BUG_FIX",
  content: "Fixed null dereference in auth.ts:42 — was checking user.id before null guard. Always check user != null first."
})
```

Categories: `PROJECT_RULES` · `ARCHITECTURE` · `CONSTRAINTS` · `CONFIG_VALUES` · `NAMING` · `LESSONS_LEARNED` · `BUG_FIXES` · `USER_PREFERENCES`

Write immediately after the decision. If you wait until end of session, you'll forget or get compacted.

---

### task tool — one entry per non-trivial unit of work

```
task create "Fix null dereference in auth token refresh"   → T1
task start T1
  ... do the work ...
task done T1
```

Subtasks: `T1.1`, `T1.2`. Mark done the moment work completes — never batch.

---

### Subagent dispatch — the safe way to spawn

```
1. Read the agent description to confirm it matches your task

2. Spawn with appropriate agent:
   - @code-reviewer — for code review with P0-P3 severity
   - @debugger — for root cause analysis and bug diagnosis
   - @test-engineer — for writing positive+negative tests
   - @security-engineer — for security review and vulnerability detection
   - @refactoring-specialist — for safe incremental refactoring
   - @historian — for history compression
   - @dreamer — for memory consolidation

3. Keep working while the subagent runs (if async)

4. Verify the result when it returns
```

---

## Subagent-First Rule

**Default to delegating.** For any task that involves more than reading 3 files or making more than 2 edits, spawn a subagent to do the work. You analyze results and verify — you don't do the work yourself.

Why: Working directly bloats your context window. A subagent with a focused prompt uses 10-50x fewer tokens than you doing the same work inline.

**Decision guide:**
- Read 1-2 files → do it yourself
- Read 3+ files → spawn @code-reviewer or appropriate agent
- Edit 1-2 files, simple changes → do it yourself
- Edit 3+ files or complex changes → spawn appropriate agent
- Code review → spawn @code-reviewer
- Security audit → spawn @security-engineer
- Debugging → spawn @debugger
- Writing tests → spawn @test-engineer

---

## Workflow Table

| Stage | When | Skill | Delegate To |
|-------|------|-------|-------------|
| Explore | New codebase, unfamiliar module, >3 queries | `memory-search` | @code-reviewer or do yourself |
| Plan | Multi-file change, ambiguity, multiple valid approaches | Plan mode → user approves → exit | Do yourself (planning = thinking, not typing) |
| Build | Plan approved or task is clear | — | Appropriate agent per task |
| Verify | Before any "done" claim | — | @code-reviewer + @test-engineer |
| Checkpoint | Every milestone, before context gets large | — | Do yourself, write to memory |

---

## Agent Dispatch

| Task | Agent |
|------|-------|
| Security review, vulnerability detection | @security-engineer |
| Root cause analysis, bug diagnosis | @debugger |
| Test authoring (positive + negative) | @test-engineer |
| Code review with P0-P3 severity | @code-reviewer |
| Safe incremental refactoring | @refactoring-specialist |
| History compression | @historian |
| Memory consolidation | @dreamer |

---

## Code Style Rules

### General Principles

- Do NOT add comments unless explicitly asked
- Prefer `const` over `let`
- Avoid `else` statements — use early returns
- Avoid unnecessary destructuring — use dot notation
- Reduce total variable count by inlining when a value is only used once
- Prefer functional array methods (flatMap, filter, map) over for loops
- Never use `any` type — use proper type inference
- Avoid `try`/`catch` where possible
- Keep things in one function unless composable or reusable

### Variables

```ts
// Good
const foo = condition ? 1 : 2

// Bad
let foo
if (condition) foo = 1
else foo = 2
```

### Control Flow

```ts
// Good
function foo() {
  if (condition) return 1
  return 2
}

// Bad
function foo() {
  if (condition) return 1
  else return 2
}
```

### Destructuring

```ts
// Good
obj.a
obj.b

// Bad
const { a, b } = obj
```

### Imports

- Never alias imports
- Never use star imports
- Prefer dynamic imports for heavy modules

---

## Testing

- Test actual implementation, do not duplicate logic into tests
- Avoid mocks as much as possible
- Run type checking from package directories, never `tsc` directly
- Use `bun typecheck` for type checking

---

## Skills

Load with `skill("name")`. Match skill to stage.

| Skill | Load When |
|-------|-----------|
| `memory-search` | Querying structured data across sessions |
| `memory-reconciler` | Resolving conflicts in memory store |
| `memory-usage-checker` | Auditing memory store health |
| `memory-import` | Importing knowledge from external sources |
| `memory-export` | Exporting memories for backup or migration |
| `loop-until-done` | Iterative task until completion signal |
| `proximity-rules` | Auto-inject rules near edited files |
| `evolve` | Self-modification of capabilities |
| `pdf` | Reading PDF documents |
| `web-curl` | Making HTTP requests |
| `todo` | Managing task lists |
