---
name: compress
description: Reduce noise — compress communication, memory files, and agent instructions. Routes to caveman terse mode, file compression, CLAUDE.md refactoring, or documentation generation. Use to cut token usage, clean up agent configs, or generate concise docs.
license: CC-BY-4.0
---

# Compress

Cut the noise. Every word that doesn't carry information wastes tokens and attention.

## Routing

| What the user needs | Mode |
|---|---|
| Terse communication mode for this session | → **Caveman** |
| Compress a markdown/memory file | → **File** |
| Clean up CLAUDE.md / AGENTS.md | → **AgentConfig** |
| Generate docs from code or commits | → **Docs** |

---

## Mode: Caveman

Respond terse like smart caveman. All technical substance stays. Only fluff dies.

### Activation
`/compress caveman` → full mode (default)
`/compress caveman lite` → drop filler, keep sentence structure
`/compress caveman ultra` → extreme compression, abbreviations, arrows for causality

### Persistence
ACTIVE EVERY RESPONSE until explicitly stopped. Off only: "stop caveman" / "normal mode".

### Rules
Drop: articles (a/an/the), filler (just/really/basically/actually/simply), pleasantries (sure/certainly/of course/happy to), hedging phrases.

Keep exact: technical terms, code blocks, error messages, file paths, numbers.

Pattern: `[thing] [action] [reason]. [next step].`

| Level | What changes |
|---|---|
| **lite** | No filler/hedging. Keep articles + full sentences |
| **full** | Drop articles, fragments OK, short synonyms |
| **ultra** | Abbreviate (DB/auth/req/res/fn/impl), arrows (X → Y) |

### Auto-clarity exceptions
Drop caveman for: security warnings, irreversible actions, multi-step sequences where order matters and fragments risk misread. Resume caveman after.

### Examples
❌ "Sure! I'd be happy to help you with that. I noticed that on line 42..."
✅ "L42: null check missing. Add guard before `.email`."

❌ "You might want to consider using async/await here for better readability"
✅ "Use async/await. Cleaner, same perf."

---

## Mode: File

Compress a natural language file (.md, .txt) to save input tokens. Overwrites original. Backs up as `<filename>.original.md`.

### Process
1. Read the file
2. Apply compression rules below
3. Validate: all technical content preserved, no code modified
4. If validation fails: report error, leave original untouched

### Compression rules

**Remove:**
- Articles: a, an, the
- Filler: just, really, basically, actually, simply, essentially
- Pleasantries: "sure", "certainly", "happy to", "I'd recommend"
- Hedging: "it might be worth", "you could consider", "generally speaking"
- Redundant phrasing: "in order to" → "to", "make sure to" → "ensure"
- Connective fluff: "however", "furthermore", "additionally", "that being said"

**Preserve EXACTLY (never modify):**
- Code blocks (fenced ``` and indented)
- Inline code (`backtick content`)
- URLs, file paths, commands, version numbers
- Technical terms, proper nouns

**Compress:**
- Short synonyms: "big" not "extensive", "fix" not "implement a solution for"
- Fragments OK: "Run tests before commit" not "You should always run tests before committing"
- Merge redundant bullets that say the same thing differently

**CRITICAL:** Anything inside ``` ... ``` copied EXACTLY. Never reorder lines, shorten commands, or simplify code.

### Boundaries
- ONLY compress: .md, .txt, extensionless files
- NEVER modify: .py, .js, .ts, .json, .yaml, .toml, .env, .lock

---

## Mode: AgentConfig

Refactor bloated CLAUDE.md, AGENTS.md, or similar agent instruction files. Apply progressive disclosure: essentials at root, everything else in linked files.

### 5-phase process

**Phase 1: Find contradictions**
Identify conflicting instructions. For each: quote both sides, ask user to resolve before proceeding.

**Phase 2: Extract essentials**
Root file gets ONLY what applies to 100% of tasks:

| Keep in root | Move out |
|---|---|
| One-sentence project description | Language conventions |
| Non-standard package manager | Testing guidelines |
| Custom build/test commands | Code style details |
| Critical overrides | Architecture patterns |

**Phase 3: Group the rest**
Common categories: `typescript.md`, `rust.md`, `testing.md`, `code-style.md`, `git-workflow.md`, `architecture.md`

Aim for 3-8 linked files. Not too granular, not too broad.

**Phase 4: Create structure**
```
project-root/
├── CLAUDE.md           # ≤50 lines, links to everything else
└── .claude/
    ├── [topic].md
    └── ...
```

**Phase 5: Flag for deletion**
Delete if: redundant (agent already knows), too vague to be actionable, states defaults, outdated.

### Root file template
```markdown
# [Project Name]

[One-sentence description]

## Quick Reference
- **Package Manager:** [if not npm]
- **Build:** `[command]`
- **Test:** `[command]`

## Guidelines
- [Topic](.claude/topic.md)
- [Topic](.claude/topic.md)
```

### Validation
- [ ] Root file under 50 lines
- [ ] Root contains ONLY universal information
- [ ] All links to sub-files work
- [ ] No contradictions remain
- [ ] Every instruction specific and actionable
- [ ] Connector paths use relative skill names, not absolute paths

---

## Mode: Docs

Generate documentation from code or git history.

### From code → README
Structure:
```markdown
# [Project Name]

[One-sentence description]

## What it does
[Problem + solution, 2-3 sentences]

## Quick start
[Minimal working example — the fastest path to value]

## Installation
[Commands only, no prose]

## Usage
[Key commands/API with examples]

## Architecture (if non-obvious)
[One diagram or bullet list of components]

## Contributing
[Only if open source]
```

Rules: lead with value, not with how it was built. Examples before explanation. No "this project aims to".

### From git → Changelog
```bash
git log --oneline <from>..<to>
```
Filter: keep `feat`, `fix`, `perf`, `security`. Drop `chore`, `ci`, `style`, `test`, `docs`.
Translate: technical commit → user-facing language.
Group: New Features / Improvements / Bug Fixes / Breaking Changes.

### From code → Inline comments
Only comment the *why*, not the *what*. If code needs a comment to explain what it does, the code should be clearer.

Good: `// ML-DSA sigs are 3309 bytes — batch here to amortize STARK proving cost`
Bad: `// Loop through transactions`

---

## Connector Workflows

- After compressing agent config → run `recon` (Codebase mode) to verify the refactored config doesn't lose critical context
- Caveman mode applies across all other skills when active — `build`, `verify`, `plan`, `recon` all respond in caveman style
- File compression useful before long `recon` or `plan` sessions to reduce memory file token cost