---
name: plan
description: Plan, spec, and triage anything — features, projects, systems, research, or messy backlogs. Routes to spec-driven task breakdown, architecture design, stress-testing ideas, TDD creation, or task prioritization. Use after recon and before build. Produces atomic tasks with verification criteria.
license: CC-BY-4.0
---

# Plan

Never build without a plan. Never plan without understanding. The plan is the contract between what you intend and what gets built.

## Routing

| What the user needs | Mode |
|---|---|
| A new project or long-term initiative | → **Project** |
| A single feature or component | → **Feature** |
| An architectural decision with tradeoffs | → **Architecture** |
| Stress-testing or challenging an existing plan | → **Challenge** |
| A quick task (≤3 files, obvious steps) | → **Quick** |

---

## Mode: Project

Full project planning. Use for anything that will take more than a week.

### Phase 1: Specify
Answer these before anything else:
```
What: One sentence — what does this build/do?
Why: The problem it solves, for whom
Success: How you know it's done (measurable)
Scope IN: What is explicitly included
Scope OUT: What is explicitly excluded
Constraints: Time, compute, dependencies, team size
```

### Phase 2: Design (skip if obvious)
Only when there are real architectural decisions to make:
```
Components: What are the major pieces?
Interfaces: How do they talk to each other?
Data: What state needs to persist, where?
Failure modes: What breaks first under load/attack/bad input?
Decision log: Key tradeoffs made and why
```

### Phase 3: Breakdown
Produce atomic tasks. Each task must:
- Have a single clear output
- Have a verification command or criteria
- Be completable in 1-4 hours
- State dependencies on other tasks

**Task format:**
```
[ID] Title
  What: one sentence
  Output: the artifact produced
  Verify: the exact command or check that confirms it's done
  Deps: [IDs of tasks that must complete first]
```

### Phase 4: Sequence
Order tasks by dependency. Flag parallel tasks explicitly. Identify the highest-risk task (most unknowns) — do it first.

### Output structure
```
.specs/
├── PROJECT.md      ← vision, success criteria, scope
├── ROADMAP.md      ← phases and milestones  
├── TASKS.md        ← atomic task list with IDs
└── STATE.md        ← decisions made, blockers, current focus
```

---

## Mode: Feature

Single feature planning. Use for well-scoped additions to existing projects.

### Template
```markdown
## Feature: [Name]

**Context:** What exists now, what's missing
**Goal:** What changes after this is built
**Approach:** How to build it (brief)
**Tasks:**
  1. [Task] → verify: [how]
  2. [Task] → verify: [how]
  3. [Task] → verify: [how]
**Risk:** What's most likely to go wrong
**Out of scope:** What this explicitly does not include
```

Keep it under 30 lines. If it needs more, it's a project not a feature.

---

## Mode: Architecture

Structured decision-making for architectural choices.

### Process
1. **State the decision** — one sentence, e.g. "Choose between X and Y for Z"
2. **List constraints** — what the solution must satisfy (non-negotiable)
3. **List preferences** — what the solution should satisfy (negotiable)
4. **Evaluate options** — score each against constraints + preferences
5. **State the choice** — with explicit reasoning
6. **Record the tradeoffs** — what you gave up by choosing this

### Decision record format
```markdown
## Decision: [Title]
**Date:** [YYYY-MM-DD]
**Status:** Accepted / Superseded by [ID]

**Context:** Why this decision was needed
**Options considered:**
  - Option A: [pros / cons]
  - Option B: [pros / cons]
**Decision:** [Chosen option]
**Rationale:** [Why this over the others]
**Consequences:** [What this makes easier / harder]
```

Save to `DECISIONS.md` in project root. Never delete old decisions — mark as Superseded.

---

## Mode: Challenge

Stress-test a plan, idea, or architectural decision before committing.

Uses adversarial reasoning to find weaknesses before they become bugs or wasted work.

### 5 challenge types — pick the most relevant:

**1. Assumption hunt (Socratic)**
List every assumption the plan makes. For each: what if it's wrong?

**2. Pre-mortem (Gary Klein)**
Imagine it's 3 months from now and the project failed. What went wrong? Work backwards.

**3. Adversary attack (Red team)**
You are an attacker / competing team / hostile reviewer. What do you exploit?

**4. Counter-argument (Hegelian)**
Steelman the opposing position. What's the strongest case against this plan?

**5. Evidence audit (Popper)**
What would falsify this? What single result would prove the plan wrong?

### Output
For each challenge:
```
Challenge: [What the challenge is]
Severity: HIGH / MEDIUM / LOW
Response: [How the plan handles it, or why it doesn't]
Action: [Change to plan, or explicit acceptance of risk]
```

End with: overall confidence assessment: HIGH / MEDIUM / LOW / PIVOT

---

## Mode: Quick

For tasks ≤3 files or ≤5 obvious steps. No overhead.

Just list:
```
Goal: [one sentence]
Steps:
  1. [action] → [verify]
  2. [action] → [verify]
  3. [action] → [verify]
```

If listing reveals >5 steps or any ambiguity: STOP. Upgrade to Feature mode.

---

## Auto-sizing Rules

| Scope | Mode |
|---|---|
| One command / one fix | Quick |
| One component / one endpoint | Feature |
| Multi-component / multi-week | Project |
| Has competing approaches | Architecture |
| Has unknown unknowns | Challenge first, then re-plan |

---

## Mode: Triage

Classify and prioritize an unstructured backlog of tasks, bugs, ideas, or TODOs into an actionable ordered list. Use at the start of a session or when the task list is unclear.

### Input
Any of:
- A list of TODO comments from the codebase (`grep -r "TODO\|FIXME\|HACK" .`)
- A GitHub issues list
- A freeform brain dump of tasks
- A PIPELINE.md / spec with mixed-priority items
- Open questions from a previous session handoff

### Process
1. **Classify** each item: bug / feature / refactor / debt / question / blocked
2. **Score** each item on: urgency (1-3), impact (1-3), effort (1-3)
3. **Detect dependencies**: which items block others?
4. **Cluster** related items that should be batched
5. **Output** a numbered priority list with: classification, score, dependency, recommended mode (`build`/`verify`/`plan`)

### Output format
```
# Triage Result — [date]

## Critical (do now)
1. [task] — bug, urgency:3, impact:3, effort:1 → build (fix mode)

## High (this session)
2. [task] — feature, urgency:2, impact:3, effort:2 → plan → build

## Deferred (next session)
3. [task] — debt, urgency:1, impact:2, effort:3 → plan (architecture)

## Blocked
4. [task] — blocked on: [dependency] — revisit after #2
```

## Connector Workflows

- Before planning → run `recon` if you haven't already
- After producing tasks → hand off to `build` with TASKS.md as context
- When plan has significant risks → run `verify` (Challenge mode) before `build`
- After project completes → update STATE.md, archive to DECISIONS.md
- After sync (context) reveals unexpected changes → triage first