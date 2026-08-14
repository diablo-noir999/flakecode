---
name: checkpoint
description: Save progress state at a meaningful milestone — commit, tag, write session notes, update CHANGELOG. Use at natural stopping points, before risky changes, or at end of session.
---

# checkpoint

## Purpose
Make progress durable and recoverable. "I'll commit later" is how work gets lost.

## Modes

### Save mode (default)
At any meaningful stopping point:
1. `git diff --stat` — what's changed?
2. Classify changes: are these coherent enough for one commit or should they be split?
3. Write commit message following project convention (from CLAUDE.md)
4. Stage and commit
5. Update `.claude/session-handoff.md` with current state

### Pre-risky mode
Before a large refactor, migration, or destructive operation:
1. Commit or stash current clean state
2. Create a recovery branch: `git checkout -b checkpoint/[task-name]-$(date +%Y%m%d)`
3. Confirm: "safe to proceed, recovery point at [branch]"

### Milestone mode
At the end of a feature or significant chunk of work:
1. Commit all changes
2. Update CHANGELOG.md with what was built
3. Tag if appropriate: `git tag v[x.y.z]`
4. Write a brief "what was accomplished" note to `.claude/milestones.md`
5. Identify: what's the next natural unit of work?

### Rollback mode
When something went wrong and you need to recover:
1. Identify: last known good commit
2. Options: `git revert` (safe, keeps history) vs `git reset` (destructive, use carefully)
3. Recommend: `git revert` for shared branches, `git reset --soft` for local-only work
4. Execute chosen strategy

## Completion Criteria (before marking done)

Before marking any task as complete, verify ALL conditions:

1. **Tests pass** — run the test command, confirm green
2. **No regressions** — existing tests still pass
3. **Type check clean** — no new type errors
4. **Code matches spec** — output satisfies the original requirements
5. **No known gaps** — no TODOs, FIXMEs, or incomplete sections left behind

If ANY condition fails: do NOT mark done. Fix first, or explicitly document what's deferred.

### When to Skip Criteria
- Emergency hotfix (user says "urgent" or "hotfix")
- Documentation-only changes (no code modified)
- Explicit user override: "skip checks" or "just commit"

## Review mode (silent gate)

Before every commit, run a lightweight internal review. No user interaction required.

### Board members (anti-sycophancy)
Apply these lenses to staged changes silently:

| Lens | What it catches |
|------|-----------------|
| Sceptic | Overclaims, hype words, "revolutionary", "game-changing" |
| End User | Missing "what do I do Monday" guidance, unclear instructions |
| Numbers | Unsourced stats, weak evidence, magic numbers |
| Veteran | Patterns that have failed before, known anti-patterns |
| Editor | Tone issues, AI tells, verbose prose, dead code |
| Strategist | Does this change serve the stated goal? |

### Voting
Each lens emits: `approve` | `flag <reason>` | `veto <reason>`

- **Soft veto** (Sceptic, Editor): flags for revision, doesn't block
- **Hard veto** (End User, Numbers, Veteran, Strategist): blocks commit until resolved

### Threshold
- 0 hard vetoes required to pass
- If hard veto: surface the issue to user, don't commit
- If only soft vetoes: commit but note the flags in commit message body

### Security layer (from claude-code security-guidance)

Three layers of security review:

**Layer 1 — Pattern warnings** (instant, regex-based):
On every Edit/Write, check for known-dangerous patterns:
- `yaml.load` without `Loader=SafeLoader`
- `pickle.load` on untrusted data
- `eval()`, `exec()` on user input
- Hardcoded secrets (`sk-`, `password=`, `api_key=`)
- Raw `innerHTML` (XSS)
- `subprocess.call` with `shell=True`
- Path traversal (`../`, user-controlled paths)
- SQL injection (string concatenation in queries)

**Layer 2 — Diff review** (after each turn):
When finishing a turn, review the diff for:
- Injection vulnerabilities (XSS, SQL, command)
- Hardcoded secrets or credentials
- Missing input validation
- Unsafe deserialization
- Path traversal

**Layer 3 — Commit review** (on git commit):
Before commit, trace data flow across changed files:
- Does user input reach sensitive sinks?
- Are auth checks in place?
- Are errors handled securely?

### When to skip review
- Trivial changes (< 10 lines, docs-only, typo fixes)
- Explicit user override: `--no-review` or "skip review"
- Emergency fixes (user explicitly says "urgent" or "hotfix")

## Chains to
`context` (handoff) if ending the session
`triage` if milestone review surfaces new tasks
`build` (release) if milestone warrants a release