/**
 * Actor Guide Tool
 *
 * Returns the exact schema and examples for the actor tool.
 * The agent calls this before spawning subagents to get the format right.
 * Works around known issues where the model stringifies the operation envelope,
 * uses wrong subagent_type, or produces malformed JSON.
 */

import { tool } from "@opencode-ai/plugin"
import type { Plugin } from "@opencode-ai/plugin"

function createActorGuideTool() {
  return tool({
    description:
      "Read the exact JSON schema and examples for the actor tool. Call this before any actor tool call to get the format right. Returns the complete reference for spawning, checking, and managing subagents. Also read this when an actor call fails to diagnose the issue.",
    args: {
      section: tool.schema
        .string()
        .optional()
        .describe(
          "Optional: 'run', 'spawn', 'status', 'wait', 'cancel', 'send', 'models', 'troubleshoot', or 'all' (default). Returns only that section."
        ),
    },
    async execute(args) {
      const section = args.section ?? "all"

      const guide = `# Actor Tool Reference

## CRITICAL: The operation field MUST be a JSON object, NOT a string.

The #1 most common error (known issue) is stringifying the operation:
  WRONG: {"operation": "{\\"action\\": \\"run\\", ...}"}
  WRONG: {"operation": "run"}
  RIGHT: {"operation": {"action": "run", "subagent_type": "explore", ...}}

The operation value MUST be a nested JSON object with an "action" discriminator.

## Available subagent types

The subagent_type field accepts ONLY these values:
- **general** — general-purpose multi-step worker
- **explore** — fast, READ-ONLY codebase explorer (grep/glob/read only)
- Plus any custom agents defined in .opencode/agents/ with mode: "subagent"

WRONG subagent_type values (will fail validation):
- "build" — not a subagent type (it's a primary agent)
- "plan" — not a subagent type (it's a primary agent)
- "compose" — not a subagent type (it's a primary agent)
- "auto-mode" — this IS a valid subagent if configured, but don't guess

---

## run — Spawn and block until done

Use "run" for one-shot tasks where you need the result before continuing.
The call BLOCKS until the subagent finishes — your turn won't return until it completes.

\`\`\`json
{"operation":{"action":"run","subagent_type":"explore","description":"Find error recovery","prompt":"Search src/parser.ts for error-recovery patterns. Return file:line + one-sentence description."}}
\`\`\`

Required: action, subagent_type, description, prompt
Optional: model, actor_id, timeout_ms, command, context, task_id, output_schema

Key behaviors:
- Blocks until subagent completes (or timeout_ms expires)
- Result returned inline as the tool response
- Use for tasks you need results from before proceeding

---

## spawn — Spawn in background, get actor_id immediately

Use "spawn" for long-running work where you don't need to block.
Returns actor_id immediately; result arrives as a notification later.

\`\`\`json
{"operation":{"action":"spawn","subagent_type":"general","description":"Long search task","prompt":"Search the entire codebase for all TODO comments and summarize them."}}
\`\`\`

Required: action, subagent_type, description, prompt
Optional: model, actor_id, command, context, task_id, output_schema

Key behaviors:
- Returns actor_id immediately (non-blocking)
- Result appears as notification in the conversation later
- Your turn does NOT auto-wake — you see the result next time you respond to the user
- Use "wait" to explicitly block on the actor_id if you need the result now

---

## status — Check if an actor is done

\`\`\`json
{"operation":{"action":"status","actor_id":"explore-1"}}
\`\`\`

Required: action, actor_id

Returns: { status: "pending"|"running"|"idle"|"unknown", actor_id, turnCount, ... }

---

## wait — Block until actor completes

\`\`\`json
{"operation":{"action":"wait","actor_id":"explore-1","timeout_ms":600000}}
\`\`\`

Required: action, actor_id
Optional: timeout_ms (default 600000 = 10 min)

Key behaviors:
- Blocks until the actor completes (success/failure/cancelled) or timeout
- Returns: { status, actor_id, result?, error? }
- CAVEAT: "wait" is for ephemeral subagents (run/spawn). Persistent peers idle between turns and never produce a "done" outcome — wait on a peer blocks until it fails or is cancelled.

---

## cancel — Stop a running actor

\`\`\`json
{"operation":{"action":"cancel","actor_id":"explore-1"}}
\`\`\`

Required: action, actor_id

Idempotent — safe to call multiple times.

---

## send — Message another actor

\`\`\`json
{"operation":{"action":"send","to_actor_id":"explore-1","content":"Focus on the parser module first."}}
\`\`\`

Required: action, to_actor_id, content
Optional: to_session_id, type

Key behaviors:
- Fire-and-forget; returns within ~5ms regardless of receiver load
- Receiver picks up message at head of its next runLoop iteration
- On unknown to_actor_id: returns {inboxID: null, error: "receiver not found"} (does not throw)

---

## models — List available models

\`\`\`json
{"operation":{"action":"models"}}
\`\`\`

Optional: vision (boolean), limit (number)

---

## Context Inheritance

The "context" parameter controls what the subagent sees:

- **context="none"** (default): Subagent sees only the prompt. Clean slate.
- **context="state"**: Subagent gets checkpoint summaries injected (background knowledge, no full detail). Good for tasks that need project context.
- **context="full"**: Subagent sees your full conversation history. Use for state writers, evaluators, or when the subagent needs full awareness. NOTE: This feature has known issues in some versions — if the subagent returns empty results, try context="state" instead.

---

## actor_id vs task_id — Don't Confuse Them

- **actor_id**: Identifies a subagent SESSION (resumable across turns). Pass to run/spawn to resume an existing idle actor. Obtained from spawn/wait/status responses.
- **task_id**: A task tracker ID (T1, T2, ...) from the task tool. Pass to run/spawn to bind subagent findings to a task. The system checks for tasks/<task_id>/progress.md after the subagent finishes.

WRONG: Using a task ID (T4) as actor_id
WRONG: Using an actor_id (explore-1) as task_id
RIGHT: actor_id="explore-1" (from a prior spawn)
RIGHT: task_id="T4" (from the task tool)

---

## Writing Effective Prompts

The subagent sees NOTHING from your conversation — the prompt is its only context:
- Explain what you're trying to accomplish and why
- Say what you've already learned or ruled out
- Give enough context for judgment calls, not just narrow steps
- For short output, say so ("report in under 200 words")
- For investigation: hand over the question; prescribed steps become dead weight

---

## Examples

### Basic explore subagent
\`\`\`json
{"operation":{"action":"run","subagent_type":"explore","description":"Find error recovery","prompt":"Search src/parser.ts and adjacent files for error-recovery patterns. Return: each location's file:line + a one-sentence description of how it recovers."}}
\`\`\`

### Review with general subagent
\`\`\`json
{"operation":{"action":"run","subagent_type":"general","description":"Type checker spec review","prompt":"Read docs/spec.md §3 (Type System), then read src/types.ts and tests/types.test.ts. Report: (1) any §3 requirement not implemented; (2) any test that fails to cover a §3 requirement. Don't fix anything — just report findings."}}
\`\`\`

### Bound to a task
\`\`\`json
{"operation":{"action":"run","subagent_type":"explore","description":"Investigate T4 type checker failures","prompt":"Run bun test src/types.test.ts and report each failing case. For each failure: file:line of the assertion, the expected vs actual values, and the most likely root-cause hypothesis.","task_id":"T4"}}
\`\`\`

### Background spawn with wait
\`\`\`json
{"operation":{"action":"spawn","subagent_type":"general","description":"Analyze test coverage","prompt":"Analyze test coverage for src/auth/ and write the report to /tmp/auth-coverage.md. Return a summary and the file path."}}
\`\`\`
Then later:
\`\`\`json
{"operation":{"action":"wait","actor_id":"<actor_id from spawn>"}}
\`\`\`

---

## Delegation Budget

When spawning multiple subagents:
- Cap each subagent's expected output to ~2000 chars to prevent context blowout
- Use the artifact pattern: have subagents write full output to a file, return only the path
- If a subagent's task is complex, use "spawn" + "wait" instead of "run" to avoid blocking
- Monitor with "status" — if a subagent stalls, use "cancel" and retry with a simpler prompt

## Artifact Pattern

For heavy subagent work, instruct the subagent to:
1. Write full results to a file (e.g., /tmp/analysis-output.md)
2. Return only a summary + the file path in its final message
3. The parent reads the file for full details

This prevents LLM summary-collapse where the subagent loses important details when compressing its output.

---

## Troubleshooting — Common Errors and Fixes

### Error: "Invalid input: expected object, received string" at operation
**Cause**: You passed operation as a string instead of a JSON object.
**Fix**: Ensure the operation value is a nested object, not a stringified version.
  WRONG: {"operation": "{\\"action\\": \\"run\\"}"}
  RIGHT: {"operation": {"action": "run", "subagent_type": "explore", "description": "...", "prompt": "..."}}

### Error: "Invalid option: expected one of explore|general" at subagent_type
**Cause**: You used an invalid subagent_type like "build", "plan", or "compose".
**Fix**: Only "general", "explore", and custom subagent agents are valid. Primary agents (build, plan, compose) are NOT subagent types.
  WRONG: {"operation": {"action": "run", "subagent_type": "build", ...}}
  RIGHT: {"operation": {"action": "run", "subagent_type": "general", ...}}

### Error: "Actor service unavailable"
**Cause**: Actor.defaultLayer must be running. This is an infrastructure issue, not a format issue.
**Fix**: Restart the session. If persistent, check opencode logs.

### Subagent returns empty result with context="full"
**Cause**: Known issue with forkContext in some versions.
**Fix**: Use context="state" instead, or upgrade opencode.

### Subagent hangs indefinitely (run blocks forever)
**Cause**: Subagent may be waiting for a permission prompt it can't interact with (subagents are non-interactive).
**Fix**: Cancel the actor and simplify the prompt to avoid permission-triggering operations.

### TUI freezes after spawning subagent
**Cause**: Known issue in some versions.
**Fix**: Click "Main" in the status bar to return to parent session.

### actor_id resume doesn't work
**Cause**: In older versions, actor_id on run/spawn was dead code.
**Fix**: Upgrade opencode. If you must work around it, use spawn + send instead.

### Wrong subagent_type for /review or compose commands
**Cause**: Commands falling back to current agent type (e.g., "compose") instead of "general".
**Fix**: Always use subagent_type="general" for review subtasks.`

      if (section === "all") return guide

      const sections: Record<string, string> = {
        run: guide.split("## run —")[1]?.split("## spawn")[0] ?? "Not found.",
        spawn: guide.split("## spawn —")[1]?.split("## status")[0] ?? "Not found.",
        status: guide.split("## status —")[1]?.split("## wait")[0] ?? "Not found.",
        wait: guide.split("## wait —")[1]?.split("## cancel")[0] ?? "Not found.",
        cancel: guide.split("## cancel —")[1]?.split("## send")[0] ?? "Not found.",
        send: guide.split("## send —")[1]?.split("## models")[0] ?? "Not found.",
        models: guide.split("## models —")[1]?.split("## Context")[0] ?? "Not found.",
        troubleshoot: guide.split("## Troubleshooting")[1] ?? "Not found.",
      }

      return sections[section] ?? `Unknown section "${section}". Valid: run, spawn, status, wait, cancel, send, models, troubleshoot, all`
    },
  })
}

const plugin: Plugin = async (input) => {
  return {
    tool: {
      actor_guide: createActorGuideTool(),
    }
  }
}

export default plugin
