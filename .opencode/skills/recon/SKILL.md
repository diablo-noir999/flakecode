---
name: recon
description: Understand anything — codebases, papers, systems, APIs, dependencies. Routes to deep codebase navigation, research synthesis, threat modeling, or dependency analysis based on what needs to be understood. Use before planning or building anything unfamiliar.
license: CC-BY-4.0
---

# Recon

Investigate before acting. Never assume what you don't know. Build a map, then use it.

## Routing

Read the request. Understand what needs investigating. Pick the approach that fits.

---

## Codebase

Navigate an unfamiliar or large codebase with surgical precision.

### Rules
1. Never read files top-to-bottom. Trace execution paths.
2. Start from the entry point closest to what you care about.
3. Use grep/ripgrep before opening files: `rg "fn verify" --type rust`
4. Read function signatures first, bodies only if signature isn't enough.
5. Verify against source, not memory. If unsure, re-read.

### Mission Cycle
```
BRIEFING → RECON → PLAN → EXECUTE → VERIFY → DEBRIEF
```

**Briefing:** What is the one thing we need to understand? State it as a question.
Example: "How does env::commit() get the journal into the STARK receipt?"

**Recon:** Trace the path that answers the question.
- `tokei .` — get size map first. Start with the smallest relevant component.
- `rg "<symbol>" --type <lang>` — find entry points
- `Ctrl+Click` (VS Code) or `cargo doc --open` for Rust — jump to definition
- `git log --oneline --follow <file>` — understand why decisions were made

**Notebook:** If it took investigation to find, it deserves a note.
Format: `file:function()` or `file (L10-25)` — pointers, not copies.

```
.notebook/
├── INDEX.md        ← map of what's been investigated
├── <topic>.md      ← one file per investigation thread
```

**Debrief:** After tracing, write a 3-5 line summary:
```
What: [what this component does]
How: [the key mechanism]
Why: [design decision if found in git/docs]
Gotchas: [anything that will bite you later]
Next: [what to trace next if needed]
```

### Navigation Commands (Rust/TS/Solidity)
```bash
# Size map — always run first
tokei .

# Find all usages of a symbol
rg "symbol_name" --type rust
rg "functionName" --type ts
rg "functionName" --include="*.sol" .

# Find definition
rg "fn symbol_name|pub fn symbol_name" --type rust
rg "function functionName|const functionName" --type ts

# Understand history of a file
git log --oneline --follow src/path/to/file.rs

# Find all public API entry points
rg "^pub fn" --type rust
rg "^export" --type ts
rg "^function\|external\|public" --include="*.sol" .

# Call graph (Solidity)
slither <contract.sol> --print call-graph
```

---

## Research

Synthesize a paper, spec, RFC, or article into actionable knowledge.

### Rules
1. Never summarize abstractly. Extract what is **actionable**.
2. Structure output as: Problem → Key Insight → Technique → Limitations → Relevance to current work.
3. For academic papers: abstract + conclusion first, then methods only if insight isn't clear.
4. Flag: what is proven vs claimed vs assumed.

### Output Format
```markdown
## [Paper/Spec Title]

**Problem:** One sentence — what gap does this address?
**Key Insight:** The core idea in plain language.
**Technique:** How it works, stripped of jargon.
**Numbers that matter:** Key benchmarks, sizes, costs.
**Limitations:** What the authors admit doesn't work.
**Relevance:** How this applies to current work.
**Cite as:** [Author et al., Year] — [venue/arXiv ID]
```

### For Ethereum EIPs / RFCs
Focus on: motivation, specification (normative language only), backwards compatibility, security considerations. Skip: rationale, reference implementation unless debugging.

---

## System

Understand a running system, API, or service by probing it.

### Rules
1. Read the OpenAPI/docs first if they exist.
2. Make the simplest possible request first — understand the response shape before edge cases.
3. Map: inputs → outputs → side effects → error cases.
4. Check rate limits and auth model before writing any automation against it.

### Output Format
```markdown
## [System Name]

**Entry points:** [endpoints / CLI commands / SDK methods]
**Auth model:** [API key / OAuth / none]
**Rate limits:** [requests/min, daily cap]
**Key data shapes:** [main request/response structures]
**Error cases:** [what fails and how it signals]
**Gotchas:** [anything not in the docs]
```

---

## Dependencies

Understand a set of libraries before using them.

### For each dependency, answer:
1. Is it actively maintained? (`git log` recency, GitHub issues)
2. Does it have `no_std` support? (critical for zkVM guest programs)
3. What are its transitive dependencies? (`cargo tree` / `npm ls`)
4. Are there known CVEs? (`cargo audit` / `npm audit`)
5. Is there a simpler alternative?

### Commands
```bash
# Rust
cargo tree --package <crate>        # dependency tree
cargo audit                         # known CVEs
cargo +nightly udeps                # unused dependencies

# Node
npm ls --depth=2                    # dependency tree
npm audit                           # known CVEs
npx depcheck                        # unused dependencies
```

---

## Zoom Out (from mattpocock/zoom-out)

When you don't know an area of code well, go up a layer of abstraction.

### What to produce
A map of all relevant modules and callers, using the project's domain glossary:
- What is this module's responsibility?
- What depends on it? (callers)
- What does it depend on? (dependencies)
- Where does it fit in the architecture?
- What are the key abstractions/interfaces?

### How to do it
1. Read the file's exports and imports
2. Find callers: `grep -r "import.*from.*this-module" .`
3. Find dependencies: read the import statements
4. Check for ADRs or docs in the area
5. Produce a one-paragraph summary with a diagram if helpful

## Connector Workflows

- After recon on a codebase or system → hand off to `plan`
- After recon on a paper or spec → hand off to `plan` or directly to `build`
- When recon reveals a security concern → hand off to `verify`