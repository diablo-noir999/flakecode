---
name: build
description: Implement anything — features, systems, scripts, skills, commits, changelogs. Routes to code generation, iterative compilation loop, skill creation, or release tasks. Use after plan. Always implements one task at a time with verification before proceeding.
license: CC-BY-4.0
---

# Build

Implement with precision. One task at a time. Verify before moving on. Never guess when you can check.

## Routing

| What the user needs | Mode |
|---|---|
| Implementing code from a spec/task | → **Implement** |
| Fixing a specific bug | → **Fix** |
| Building a new agent skill | → **Skill** |
| Writing a commit message | → **Commit** |
| Generating a changelog / release notes | → **Release** |
| Refactoring without changing behavior | → **Refactor** |

---

## Mode: Implement

Execute one task from a plan. Read the task, build it, verify it, stop.

### Rules
1. Read the task output + verify criteria before writing a line.
2. Implement the minimum that satisfies the verify criteria. Nothing more.
3. After implementing, run the verify command. If it fails, fix it before calling done.
4. If the task turns out to be bigger than estimated: STOP. Surface the blocker. Re-plan.
5. If you're about to touch something outside the task's stated scope: STOP. Ask.

### Implementation cycle
```
READ task → UNDERSTAND verify criteria → IMPLEMENT minimum → RUN verify → DONE or FIX
```

### Code quality defaults (always apply, never need to be stated)
- Functions do one thing
- Names describe what, not how
- Error cases are handled explicitly, not ignored
- No magic numbers — constants with names
- No commented-out code in final output

### Language-specific patterns

**TypeScript / Node.js**
```typescript
// Error handling — always explicit
try {
  const result = await riskyOperation();
  return { ok: true, value: result };
} catch (err) {
  return { ok: false, error: err instanceof Error ? err.message : String(err) };
}

// No implicit any — always type your returns
async function fetchContract(address: string): Promise<ContractSource> {}

// Commander.js CLI pattern
program
  .command('target <address>')
  .description('Analyze a smart contract')
  .option('--chain <chain>', 'chain name', 'mainnet')
  .action(async (address, opts) => { ... });
```

**Rust**
```rust
// Error handling — use thiserror for library, anyhow for binary
#[derive(thiserror::Error, Debug)]
pub enum AppError {
    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),
}

// Explicit types in public API
pub fn verify_signature(pk: &PublicKey, msg: &[u8], sig: &Signature) -> Result<(), AppError>

// Serde patterns for config/data
#[derive(Debug, Serialize, Deserialize)]
pub struct Config {
    pub endpoint: String,
    pub model: String,
}
```

**Solidity**
```solidity
// Access control — always explicit
modifier onlyOwner() {
    require(msg.sender == owner, "Not owner");
    _;
}

// Checks-Effects-Interactions pattern
function withdraw(uint amount) external {
    require(balances[msg.sender] >= amount, "Insufficient");  // check
    balances[msg.sender] -= amount;                           // effect
    (bool ok,) = msg.sender.call{value: amount}("");          // interaction
    require(ok, "Transfer failed");
}

// Events for every state change
event Withdrawn(address indexed user, uint amount);
```

---

## Mode: Fix

Diagnose and fix a specific bug.

### Process
1. **Reproduce** — confirm the bug with a minimal test case before touching anything
2. **Locate** — find the exact line causing the issue (not just the symptom)
3. **Understand** — explain why the bug exists before writing the fix
4. **Fix minimally** — change only what's needed to fix the root cause
5. **Verify** — the original reproduction no longer triggers the bug
6. **Regression** — add a test that would have caught this

### Diagnosis commands
```bash
# Rust — read the full error chain
RUST_BACKTRACE=1 cargo run 2>&1 | head -50

# Node.js — verbose output
NODE_DEBUG=* node script.ts 2>&1 | head -100

# Foundry — full trace on failing test
forge test --match-test testName -vvvv

# General — binary search the bug
git bisect start
git bisect bad          # current commit is broken
git bisect good <hash>  # last known good commit
```

### Bug report format (write before fixing)
```
Symptom: what you see
Expected: what should happen
Root cause: why it happens (be specific — line numbers)
Fix: what changes and why this fixes the root cause
Test: how to verify it's fixed
```

---

## Mode: Skill

Build a new agent skill from scratch.

### Rules
1. Understand before building — what problem does this skill solve?
2. Progressive disclosure — metadata always loaded, body only when triggered, resources on demand
3. Write for an LLM, not a human — specific and actionable, not descriptive
4. One skill = one domain. If it needs routing, add a routing table, don't bloat the body.
5. Description field is the most important part — it determines when the skill triggers.

### Description formula
```
[What it does] + [When to use it] + [When NOT to use it if non-obvious]
Under 1024 chars. Single line. No angle brackets.
```

### SKILL.md structure
```markdown
---
name: kebab-case-name
description: [formula above]
license: CC-BY-4.0
---

# [Skill Name]

[One-line purpose]

## Routing (if skill has modes)
[table of trigger → mode]

## [Mode or direct instructions]
[Specific, actionable steps]

## Connector Workflows
[Which skills this chains to and when]
```

### Validation before delivering
- [ ] Name is kebab-case, no capitals, no spaces
- [ ] Description under 1024 chars, single line, no angle brackets
- [ ] Every instruction is specific and actionable (not vague)
- [ ] No instructions that are LLM defaults (don't say "write clean code")
- [ ] Connector workflows specified if this chains to other skills
- [ ] Body under ~5k words

---

## Mode: Commit

Write a commit message. Conventional Commits format. No fluff.

### Format
```
<type>(<scope>): <imperative summary>

[optional body — only for non-obvious why, breaking changes, or linked issues]
```

**Types:** `feat` `fix` `refactor` `perf` `docs` `test` `chore` `build` `ci` `style` `revert`

**Rules:**
- Subject ≤50 chars, hard cap 72
- Imperative mood: "add" not "adds" / "added"
- No trailing period
- Body only when: non-obvious why, breaking change, migration note, closes issue
- Body wrap at 72 chars
- `Closes #N` at end of body for issue references
- Never include: AI attribution, "this commit does X", author name

**Always include body for:** breaking changes, security fixes, data migrations, reverts.

---

## Mode: Release

Generate a changelog or release notes from git history.

### Process
1. `git log --oneline <from>..<to>` — get commit list
2. Filter: keep `feat`, `fix`, `perf`, `security`. Drop `chore`, `ci`, `style`, `test`, `docs`.
3. Translate technical commits → user-facing language
4. Group: New Features / Improvements / Bug Fixes / Breaking Changes
5. Format as Markdown for CHANGELOG.md

### Output format
```markdown
## [version] — YYYY-MM-DD

### New Features
- **[Feature name]:** What it does for the user

### Improvements  
- What got faster/better/easier

### Bug Fixes
- What was broken and is now fixed

### Breaking Changes (if any)
- What changed and what users need to do
```

---

## Mode: Refactor

Change code structure without changing behavior.

### Rules
1. Write characterization tests BEFORE refactoring — they define current behavior
2. Refactor in small steps. Run tests after each step.
3. Never mix refactoring with feature changes in the same commit
4. If you can't test it, you can't refactor it safely

### Safe refactoring sequence
```
1. Characterize current behavior (tests)
2. One structural change
3. Run tests — must still pass
4. Commit
5. Repeat
```

---

## Connector Workflows

- Before building → confirm task exists in `plan` output with verify criteria
- When implementation reveals the plan was wrong → stop, go back to `plan`
- After building → run `verify` to confirm quality
- After completing a set of tasks → run `build` (Release mode) to update changelog