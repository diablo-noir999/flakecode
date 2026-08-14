---
name: validation-pipeline
description: >
  Run a validation pipeline before commit or completion. Checks: review, test,
  lint, typecheck. Use when: "validate before commit", "run checks", "pre-commit
  validation", or invoking /validate.
---

# Validation Pipeline

Run a sequence of checks before any commit or completion. Each step must pass before proceeding.

## Pipeline Steps

1. **Review** — Read the diff, check for obvious issues
2. **Test** — Run the project's test suite (`bun test`, `npm test`, `pytest`, etc.)
3. **Lint** — Run the linter (`bun run lint`, `eslint`, `ruff check`, etc.)
4. **Typecheck** — Run type checking (`bun run typecheck`, `tsc --noEmit`, etc.)

## Rules

- Each step must pass before the next starts
- If a step fails, stop and fix before continuing
- If a step doesn't exist (no test runner configured), skip it
- Report results as: `PASS: step` or `FAIL: step — reason`
- The pipeline is the minimum gate before any commit
