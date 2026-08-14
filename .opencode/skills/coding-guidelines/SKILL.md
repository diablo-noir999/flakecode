---
name: coding-guidelines
description: >
  Core coding principles: YAGNI ladder, anti-overcompilation, surgical changes,
  goal-driven execution. Use when: "coding guidelines", "how should I code",
  "best practices", or invoking /guidelines.
---

# Coding Guidelines

## The YAGNI Ladder (from Ponytail)

Before writing any code, stop at the first rung that holds:

1. Does this need to be built at all?
2. Does it already exist in this codebase?
3. Does the standard library do this?
4. Does a native platform feature cover it?
5. Does an already-installed dependency solve it?
6. Can this be one line?
7. Only then: write the minimum code that works.

## 4 Principles (from Karpathy)

### Think Before Coding
- State assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them — don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.

### Simplicity First
- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" that wasn't requested.
- If you write 200 lines and it could be 50, rewrite it.

### Surgical Changes
- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- Every changed line should trace directly to the user's request.

### Goal-Driven Execution
- Transform tasks into verifiable goals.
- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"

## Coding Standards

- Prefer `const` over `let`. Use ternaries or early returns instead of reassignment.
- Avoid `else` statements. Prefer early returns.
- Keep functions under 50 lines, files under 800 lines.
- No deep nesting (>4 levels) — use early returns.
- No hardcoded values — use named constants.
- Handle errors explicitly at every level. Never silently swallow errors.
- Validate all user input at system boundaries.
- Create new objects, never mutate existing ones.
