---
name: spec-writer
description: >
  Generates a structured spec sheet for a software project or feature before any
  code gets written. Trigger this when the user asks to "write a spec", "create a
  spec sheet", "write a PRD", "plan out a project", "scope something", "define
  requirements", "plan a feature", or describes a project idea and seems ready to
  start building. Also trigger proactively when a user jumps straight to "let's
  build X" with a vague or compressed idea — intercept and spec it first rather
  than writing code immediately. Covers both one-shot specs (a single document
  describing the whole project) and phased specs (a numbered sequence of build
  steps for an existing or evolving codebase). This skill exists to prevent scope
  creep, missed edge cases, and shipping things nobody asked for.
---

# Spec Writer

## Purpose

A spec is the blueprint before construction. It forces clarity before code.
The failure mode it prevents: building fast in the wrong direction, missing
requirements, and discovering edge cases in production instead of on paper.

**Philosophy:** Paper is cheap, code is expensive. If the project can't be
described in one sentence, it's too big — scope it down before writing the spec,
not after.

**Two shapes a spec can take** — pick based on context, don't default blindly:

- **Flat spec**: one document describing a whole project end to end. Use for new
  projects, MVPs, or anything being scoped from zero.
- **Phased spec**: a numbered sequence of discrete steps/phases, each independently
  completable and checkpointable. Use when extending an existing system, when the
  user wants to work through something incrementally (e.g. with an AI pair, or
  solo over multiple sessions), or when the project naturally has hard dependency
  ordering (step N can't start before step N-1 is verified working).

Ask which shape fits if it isn't obvious — "are we scoping a new project from
scratch, or planning out the next chunk of work on something that already exists?"

---

## Process

### Phase 1: Gather Context (Never Skip)

Extract these before writing anything. Ask if not already provided:

1. **What are you building?** (one sentence — if they can't compress it, help them)
2. **Who is it for?** (a specific user, or "just me" — both are valid answers)
3. **Why does it need to exist?** (what friction does it remove? skip this only
   for pure learning/exploration projects, where "I want to understand X" is the
   answer)
4. **What's the context?** (hobby, production, client work, coursework, portfolio,
   internal tool — this changes how much rigor sections 9-10 below need)
5. **Flat or phased?** (see above — if extending existing code, phased is usually
   right)

### Phase 2: Check the Premise (Scale to Context)

This step is conditional on what's being built — don't force it where it doesn't fit:

- **User-facing product** (something other people will use or pay for): has the
  user talked to anyone who'd actually use it? Can they name a few? If validation
  is thin, note it as a risk in the spec — don't refuse to write the spec.
- **Internal tool / infra / dev tool**: the "user" is the builder or their team.
  Validation here is just: does this solve a friction point you've actually hit?
- **Learning project / exploration**: skip validation entirely. The goal is
  understanding, not adoption. Don't manufacture a fake pain point to fit the
  template — say plainly that this is exploratory.

### Phase 3: Write the Spec

Use the Flat Template or Phased Template below. Scale section depth to project
size — see "Scaling the Template" before writing.

### Phase 4: Pressure-Test

Before handing it back, check:

- Could a stranger read this and build the same thing you have in mind?
- What breaks the happy path? (empty input, network down, concurrent edits,
  unauthenticated access, malformed data)
- Is the scope small enough to actually finish?
- Are there explicit success criteria — how would you know this is done?
- Anywhere two builders would reasonably build different things from this text?

---

## Scaling the Template

Not every project needs all 13 sections at full depth. As a rule of thumb:

- **Weekend project / script**: collapse to Overview, Goals & Non-Goals, Core User
  Stories, Edge Cases, Success Criteria. Skip validation, data model detail, and
  Future Considerations.
- **Real project with users, even if small**: use most sections, but keep each
  tight — a paragraph, not a page.
- **Larger or team project**: use the full template, and consider the optional
  add-ons (below) for security/performance-sensitive work.

If a section genuinely doesn't apply, write "N/A — [why]" rather than omitting it
silently. The omission itself is information.

---

## Flat Template

```markdown
# [Project Name]

## 1. Overview
One paragraph: what this is, who it's for, why it exists.

## 2. Goals & Non-Goals
### Goals (what this WILL do)
- ...
### Non-Goals (what this explicitly WILL NOT do)
- ...
Non-goals prevent scope creep by making explicit what you're choosing not to build.

## 3. Users & Context
Who specifically uses this (or: "just the builder"). What friction does it remove?
If user-facing: validation status — talked to anyone? identified alternatives?

## 4. User Stories
5-15 stories: "As a [user], I want to [action] so that [outcome]."
Split into **Core** (MVP) and **Nice-to-Have** (v2+).

## 5. Functional Requirements
Per story: Input → Processing → Output → Error cases.

## 6. Data Model
What's stored, how entities relate. Stack-agnostic.

## 7. Architecture
App type, major components, how they communicate, external dependencies.
Match complexity to actual scale — a weekend project doesn't need microservices.

## 8. Tech Stack
Only after 2-7 are settled. Simplest stack that does the job.

## 9. Edge Cases & Error Handling
Empty input, downed dependencies, concurrent access, bad auth, malformed data —
what happens in each case?

## 10. Success Criteria
Specific and checkable, e.g. "user completes [action] with no errors,"
"response < X seconds," "all core stories pass manual test."

## 11. MVP Scope
The smallest version that solves the core friction and actually works. List
exactly what's in. Everything else → v2. More than ~7 features → cut more.

## 12. Future Considerations
Brief. Just enough to not paint yourself into a corner architecturally.

## 13. Open Questions
Anything unresolved — surface it now, not mid-build.
```

## Phased Template

Use when the work is a sequence of build steps, often on an existing codebase.

```markdown
# [Project Name] — [Phase/Version Name]

## Context
What exists already, what this phase adds, why it's sequenced this way.

## Non-Goals for This Phase
What's explicitly deferred to a later phase — keeps scope from bleeding forward.

## Steps
Numbered, each independently completable and verifiable before the next starts.
For each step:
- **Goal**: what this step accomplishes
- **Changes**: what gets built/modified
- **Verify**: how to confirm it works before moving on (a check, a test, a manual
  run — something concrete, not "looks right")

1. Step 1 — Goal / Changes / Verify
2. Step 2 — Goal / Changes / Verify
...

## Dependencies Between Steps
Note any step that can't start until another is verified (most steps in a phased
spec are sequential by nature — call out the rare ones that are NOT, since those
can run in parallel).

## Definition of Done for This Phase
What's true when every step is complete — concrete, checkable.

## Open Questions
Anything to resolve before or during this phase.
```

---

## Optional Add-Ons

Pull these in only when the project actually touches the relevant risk surface —
don't pad every spec with them by default.

- **Security checklist** (any project touching user data, auth, or external
  input): auth model, input validation, data exposure points, injection vectors,
  rate limiting.
- **Performance targets** (anything with a latency/scale expectation): define
  concrete numbers — "page loads < 2s on 3G," not "should be fast."
- **API contract** (anything with a consumed or exposed API): note whether the
  spec should pin down the schema (e.g. OpenAPI) now or leave it to implementation.
- **Accessibility**: relevant for user-facing UI; note it explicitly as in-scope
  or out-of-scope rather than letting it go unmentioned.

---

## Common Mistakes to Avoid

1. **Vague requirements.** "Should be fast" isn't a requirement. A number is.
2. **Missing edge cases.** The happy path is easy — what breaks it?
3. **No success criteria.** If "done" isn't defined, it never arrives.
4. **Scope too big.** Can't compress to one sentence → cut until it fits.
5. **Picking the stack before the spec.** Tool choice follows the problem, not
   the other way around.
6. **Skipping non-goals.** Unwritten boundaries get crossed silently.
7. **Forcing the validation/pain-point framing onto projects that don't need it.**
   Not every spec is a product pitch — some are just "I want to build this."
8. **Overengineering.** Match complexity to actual scale, not aspirational scale.
9. **Treating the spec as static.** It's a living document — update it as you learn.
10. **Flat-templating a phased project, or vice versa.** Pick the shape that
    matches how the work will actually get built.

---

## Example: Flat Spec, Compressed

**Input:** "I want to build a tool for freelancers to track invoices."

**Spec overview:** A web app for freelancers to create, send, and track invoices.
Users: freelancers with 1-20 clients currently using spreadsheets or nothing.
Friction: chasing unpaid invoices costs hours monthly. MVP: create invoice, send
via email, mark paid/unpaid. Non-goals: payment processing, accounting
integration, multi-currency (v2). Architecture: SPA + API + Postgres. Stack:
Next.js + Supabase. Success criteria: invoice created and sent in < 2 minutes;
payment status visible on dashboard.

## Example: Phased Spec, Compressed

**Input:** "Add session persistence to my existing CLI tool so users don't have
to re-auth every run."

**Spec overview:** Phase adds env-var-token-based session persistence to an
existing auth flow. Step 1: define token format and storage location. Step 2:
write token on successful auth. Step 3: check for valid token before prompting
re-auth. Step 4: add explicit logout/token-clear command. Each step verified by
a manual run before the next starts. Non-goal for this phase: multi-device token
sync (later phase).
