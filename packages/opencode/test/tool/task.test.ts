import { describe, expect } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Effect } from "effect"
import { Agent } from "../../src/agent/agent"
import { Database } from "@opencode-ai/core/database/database"
import { Config } from "../../src/config/config"
import { TaskTool } from "../../src/tool/task"
import { ToolRegistry } from "../../src/tool/registry"
import { Session } from "../../src/session/session"
import { MessageID, SessionID } from "../../src/session/schema"
import { Truncate } from "@/tool/truncate"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { testEffect } from "../lib/effect"
import type * as Tool from "../../src/tool/tool"

const layer = LayerNode.compile(
  LayerNode.group([
    Agent.node,
    Config.node,
    Session.node,
    ToolRegistry.node,
    Truncate.node,
    Database.node,
    RuntimeFlags.node,
  ]),
)

const it = testEffect(layer)

function makeCtx(sessionID?: string): Tool.Context {
  return {
    sessionID: (sessionID ?? SessionID.descending()) as any,
    messageID: MessageID.ascending(),
    agent: "build",
    abort: new AbortController().signal,
    messages: [],
    metadata() {
      return Effect.void
    },
    ask() {
      return Effect.void
    },
  }
}

describe("task tool", () => {
  it.effect("create returns a new task with id and status", () =>
    Effect.gen(function* () {
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const ctx = makeCtx()

      const result = yield* def.execute(
        {
          operation: {
            action: "create",
            summary: "Fix the login bug",
          },
        },
        ctx,
      )

      expect(result.metadata.id).toBeDefined()
      expect(result.metadata.status).toBe("open")
      expect(result.output).toContain("Created")
      expect(result.output).toContain("Fix the login bug")
    }),
  )

  it.effect("create with parent_id creates a subtask", () =>
    Effect.gen(function* () {
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const ctx = makeCtx()

      const parent = yield* def.execute(
        {
          operation: {
            action: "create",
            summary: "Parent task",
          },
        },
        ctx,
      )

      const child = yield* def.execute(
        {
          operation: {
            action: "create",
            summary: "Child task",
            parent_id: parent.metadata.id,
          },
        },
        ctx,
      )

      expect(child.metadata.id).toContain(".")
      expect(child.metadata.id).toMatch(/^T\d+\.\d+$/)
    }),
  )

  it.effect("list returns empty array when no tasks exist", () =>
    Effect.gen(function* () {
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const ctx = makeCtx()

      const result = yield* def.execute(
        {
          operation: {
            action: "list",
          },
        },
        ctx,
      )

      expect(result.metadata.count).toBe(0)
      expect(result.output).toBe("No tasks.")
    }),
  )

  it.effect("list returns created tasks", () =>
    Effect.gen(function* () {
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const ctx = makeCtx()

      yield* def.execute(
        {
          operation: { action: "create", summary: "Task 1" },
        },
        ctx,
      )

      yield* def.execute(
        {
          operation: { action: "create", summary: "Task 2" },
        },
        ctx,
      )

      const result = yield* def.execute(
        {
          operation: { action: "list" },
        },
        ctx,
      )

      expect(result.metadata.count).toBe(2)
      expect(result.output).toContain("Task 1")
      expect(result.output).toContain("Task 2")
    }),
  )

  it.effect("get returns task details", () =>
    Effect.gen(function* () {
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const ctx = makeCtx()

      const created = yield* def.execute(
        {
          operation: { action: "create", summary: "Get me" },
        },
        ctx,
      )

      const result = yield* def.execute(
        {
          operation: { action: "get", id: created.metadata.id! },
        },
        ctx,
      )

      expect(result.metadata.id).toBe(created.metadata.id)
      expect(result.metadata.status).toBe("open")
      expect(result.output).toContain("Get me")
    }),
  )

  it.effect("get returns not found for non-existent task", () =>
    Effect.gen(function* () {
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const ctx = makeCtx()

      const result = yield* def.execute(
        {
          operation: { action: "get", id: "T999" },
        },
        ctx,
      )

      expect(result.output).toContain("not found")
    }),
  )

  it.effect("start transitions task to in_progress", () =>
    Effect.gen(function* () {
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const ctx = makeCtx()

      const created = yield* def.execute(
        {
          operation: { action: "create", summary: "Start me" },
        },
        ctx,
      )

      const result = yield* def.execute(
        {
          operation: { action: "start", id: created.metadata.id! },
        },
        ctx,
      )

      expect(result.metadata.status).toBe("in_progress")
    }),
  )

  it.effect("block transitions task to blocked", () =>
    Effect.gen(function* () {
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const ctx = makeCtx()

      const created = yield* def.execute(
        {
          operation: { action: "create", summary: "Block me" },
        },
        ctx,
      )

      yield* def.execute(
        {
          operation: { action: "start", id: created.metadata.id! },
        },
        ctx,
      )

      const result = yield* def.execute(
        {
          operation: { action: "block", id: created.metadata.id!, event_summary: "Waiting for API" },
        },
        ctx,
      )

      expect(result.metadata.status).toBe("blocked")
    }),
  )

  it.effect("unblock transitions task back to open", () =>
    Effect.gen(function* () {
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const ctx = makeCtx()

      const created = yield* def.execute(
        {
          operation: { action: "create", summary: "Unblock me" },
        },
        ctx,
      )

      yield* def.execute(
        {
          operation: { action: "start", id: created.metadata.id! },
        },
        ctx,
      )

      yield* def.execute(
        {
          operation: { action: "block", id: created.metadata.id!, event_summary: "Blocked" },
        },
        ctx,
      )

      const result = yield* def.execute(
        {
          operation: { action: "unblock", id: created.metadata.id!, event_summary: "Unblocked" },
        },
        ctx,
      )

      expect(result.metadata.status).toBe("open")
    }),
  )

  it.effect("done transitions task to done", () =>
    Effect.gen(function* () {
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const ctx = makeCtx()

      const created = yield* def.execute(
        {
          operation: { action: "create", summary: "Done me" },
        },
        ctx,
      )

      yield* def.execute(
        {
          operation: { action: "start", id: created.metadata.id! },
        },
        ctx,
      )

      const result = yield* def.execute(
        {
          operation: { action: "done", id: created.metadata.id!, event_summary: "Completed" },
        },
        ctx,
      )

      expect(result.metadata.status).toBe("done")
    }),
  )

  it.effect("abandon transitions task to abandoned", () =>
    Effect.gen(function* () {
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const ctx = makeCtx()

      const created = yield* def.execute(
        {
          operation: { action: "create", summary: "Abandon me" },
        },
        ctx,
      )

      const result = yield* def.execute(
        {
          operation: { action: "abandon", id: created.metadata.id!, event_summary: "No longer needed" },
        },
        ctx,
      )

      expect(result.metadata.status).toBe("abandoned")
    }),
  )

  it.effect("rename updates task summary", () =>
    Effect.gen(function* () {
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const ctx = makeCtx()

      const created = yield* def.execute(
        {
          operation: { action: "create", summary: "Old summary" },
        },
        ctx,
      )

      const result = yield* def.execute(
        {
          operation: { action: "rename", id: created.metadata.id!, summary: "New summary" },
        },
        ctx,
      )

      expect(result.output).toContain("New summary")
    }),
  )

  it.effect("list filters by status", () =>
    Effect.gen(function* () {
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const ctx = makeCtx()

      const task1 = yield* def.execute(
        {
          operation: { action: "create", summary: "Open task" },
        },
        ctx,
      )

      yield* def.execute(
        {
          operation: { action: "create", summary: "Another task" },
        },
        ctx,
      )

      yield* def.execute(
        {
          operation: { action: "done", id: task1.metadata.id!, event_summary: "Done" },
        },
        ctx,
      )

      const openResult = yield* def.execute(
        {
          operation: { action: "list", status: "open" },
        },
        ctx,
      )

      expect(openResult.metadata.count).toBe(1)

      const doneResult = yield* def.execute(
        {
          operation: { action: "list", status: "done", include_terminal: true },
        },
        ctx,
      )

      expect(doneResult.metadata.count).toBe(1)
    }),
  )

  it.effect("list includes terminal tasks when include_terminal is true", () =>
    Effect.gen(function* () {
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const ctx = makeCtx()

      const task = yield* def.execute(
        {
          operation: { action: "create", summary: "Terminal task" },
        },
        ctx,
      )

      yield* def.execute(
        {
          operation: { action: "done", id: task.metadata.id!, event_summary: "Done" },
        },
        ctx,
      )

      const withoutTerminal = yield* def.execute(
        {
          operation: { action: "list" },
        },
        ctx,
      )

      expect(withoutTerminal.metadata.count).toBe(0)

      const withTerminal = yield* def.execute(
        {
          operation: { action: "list", include_terminal: true },
        },
        ctx,
      )

      expect(withTerminal.metadata.count).toBe(1)
    }),
  )
})
