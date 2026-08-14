---
name: readme
description: Generate or rewrite a README.md for any repository. Use this whenever the user asks to create, write, update, or rewrite a README — or when they say things like "make a readme", "update the readme", "readme for this project", "document this repo". Always triggers for any README-related request.
---

# README Generator

Creates or rewrites a README.md that reads like a real developer wrote it — no em dashes, no inflated commentary, no AI-isms.

## Step 1: Understand the repo

Before writing anything, gather context. Use bash to:

```bash
# Get repo structure
find . -maxdepth 2 -not -path '*/node_modules/*' -not -path '*/.git/*' -not -path '*/target/*' -not -path '*/__pycache__/*'

# Check package metadata
cat package.json 2>/dev/null || cat Cargo.toml 2>/dev/null || cat pyproject.toml 2>/dev/null || cat go.mod 2>/dev/null

# Check for existing README
cat README.md 2>/dev/null
```

Also read the main entry point or core source file if it's small enough to understand what the project actually does.

## Step 2: Determine mode

- **No README exists** — create one from scratch
- **README exists** — rewrite/update it, preserving any sections that are still accurate, improving what isn't

## Step 3: Write the README

Follow these rules strictly:

### Tone and style
- Write like a developer talking to another developer
- Short sentences. No padding.
- No em dashes (—). Use a comma, period, or restructure the sentence instead.
- No phrases like: "seamlessly", "robust", "powerful", "intuitive", "effortlessly", "straightforward", "at its core", "under the hood", "out of the box", "designed to", "built to", "aims to", "it's worth noting", "in order to"
- No bullet points that start with an adjective ("Simple installation", "Powerful features") — just state the thing
- Don't over-explain obvious things
- If something is a WIP or incomplete, say so plainly

### Structure (use only what the project actually needs)

```markdown
# Project Name

One or two sentences. What it does, not what it aspires to be.

## Install

Exact commands. Nothing else.

## Usage

Minimal working example. Real code, not pseudocode.

## Config (if applicable)

Only if there's non-obvious configuration.

## How it works (if applicable)

Only for projects where the internals aren't obvious. Keep it short.

## Contributing (if applicable)

Only if the project is open source and actually wants contributions.

## License

One line.
```

Omit any section that doesn't apply. Don't add sections just to look complete.

### Badges
Only add badges if the repo already has CI, a published package, or a license file. Don't invent them.

### Code blocks
Always specify the language for syntax highlighting. Use the actual commands, not placeholders like `<your-value>` unless a value is genuinely required from the user.

## Step 4: Output

Write the README.md to the repo root. If one already existed, overwrite it. Then confirm what changed in one sentence.

Do not narrate your process to the user beyond that confirmation.