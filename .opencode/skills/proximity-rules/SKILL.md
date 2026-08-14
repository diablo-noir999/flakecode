---
name: proximity-rules
description: Automatically discovers and injects relevant rules near files being edited. This skill works in the background.
hidden: true
---

# Proximity Rules

This skill is automatically loaded by the rules-injector hook. It discovers AGENTS.md, CLAUDE.md, and other rule files near the directory being edited, and injects them into the agent's context.

## How It Works

When you edit or write a file, the hook:
1. Walks up from the target directory toward the project root
2. Looks for rule files (AGENTS.md, CLAUDE.md, .rules, etc.)
3. Injects relevant rules into your context
4. Caches results for performance

## Rule File Locations

The hook checks these files in order:
- AGENTS.md
- CLAUDE.md
- .rules
- CONVENTIONS.md
- CONTRIBUTING.md

## Configuration

Disable via opencode config:
```jsonc
{
  "powerpack": {
    "rulesInjector": { "enabled": false }
  }
}
```
