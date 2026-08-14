import { Context, Effect, Layer } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { and, eq, isNull, or, gt, type SQL } from "drizzle-orm"
import { Bus } from "../bus"
import { Config } from "../config"
import type { SessionID } from "../session/schema"
import { TaskTable, TaskEventTable } from "./task.sql"
import type { Task, TaskEvent } from "./schema"
import { Created as TaskCreated, Updated as TaskUpdated, type UpdatedKind } from "./events"
import { RecoverableError } from "@/tool/recoverable"

const DAY_MS = 24 * 60 * 60 * 1000

const notFoundMessage = (id: string) =>
  `Task ${id} not found. Use \`task list\` to see valid task IDs, or \`task create\` to add one.`

type TaskRow = typeof TaskTable.$inferSelect
type TaskEventRow = typeof TaskEventTable.$inferSelect

function fromTaskRow(row: TaskRow): Task {
  return {
    id: row.id,
    session_id: row.session_id as SessionID,
    parent_task_id: row.parent_task_id ?? undefined,
    status: row.status,
    summary: row.summary,
    owner: row.owner ?? undefined,
    created_at: row.created_at,
    last_event_at: row.last_event_at,
    ended_at: row.ended_at ?? undefined,
    cleanup_after: row.cleanup_after ?? undefined,
  }
}

function fromEventRow(row: TaskEventRow): TaskEvent {
  return {
    id: row.id,
    task_id: row.task_id,
    at: row.at,
    kind: row.kind as TaskEvent["kind"],
    summary: row.summary ?? undefined,
  }
}

function nextChildId(parentId: string | undefined, siblings: string[]): string {
  const prefix = parentId ? `${parentId}.` : "T"
  const used = siblings
    .filter((s) => (parentId ? s.startsWith(prefix) : /^T\d+$/.test(s)))
    .map((s) => {
      const tail = s.slice(prefix.length)
      return /^\d+$/.test(tail) ? Number(tail) : 0
    })
  const next = used.length > 0 ? Math.max(...used) + 1 : 1
  return `${prefix}${next}`
}

export interface Interface {
  readonly create: (input: {
    session_id: SessionID
    summary: string
    parent_id?: string
    owner?: string
  }) => Effect.Effect<Task>

  readonly list: (input: {
    session_id?: SessionID
    status?: Task["status"]
    owner?: string
    include_terminal?: boolean
    include_archived?: boolean
  }) => Effect.Effect<Task[]>

  readonly get: (input: { session_id: SessionID; id: string }) => Effect.Effect<Task | undefined>

  readonly block: (input: { session_id: SessionID; id: string; event_summary?: string }) => Effect.Effect<Task>
  readonly unblock: (input: { session_id: SessionID; id: string; event_summary?: string }) => Effect.Effect<Task>
  readonly done: (input: { session_id: SessionID; id: string; event_summary?: string }) => Effect.Effect<Task>
  readonly abandon: (input: { session_id: SessionID; id: string; event_summary?: string }) => Effect.Effect<Task>
  readonly rename: (input: { session_id: SessionID; id: string; summary: string }) => Effect.Effect<Task>

  readonly start: (input: { session_id: SessionID; id: string; owner?: string; event_summary?: string }) => Effect.Effect<Task>

  readonly events: (input: { session_id: SessionID; task_id: string }) => Effect.Effect<TaskEvent[]>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/TaskRegistry") {}

export const layer: Layer.Layer<Service, never, Bus.Service | Config.Service | Database.Service> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const bus = yield* Bus.Service
    const database = yield* Database.Service
    const config = yield* Config.Service
    const db = database.db

    const cleanupAfter = Effect.fn("TaskRegistry.cleanupAfter")(function* (now: number) {
      const cfg = yield* config.get()
      const days = (cfg as any).checkpoint?.task_archive_days ?? 7
      return now + days * DAY_MS
    })

    const insertEvent = (
      session_id: SessionID,
      task_id: string,
      kind: TaskEvent["kind"],
      summary: string | undefined,
      now: number,
    ) => {
      Effect.runFork(
        Effect.gen(function* () {
          yield* db.insert(TaskEventTable)
            .values({ session_id, task_id, at: now, kind, summary: summary ?? null })
            .run().pipe(Effect.orDie)
        })
      )
    }

    const publishCreated = (task: Task) =>
      Effect.runFork(bus.publish(TaskCreated, { sessionID: task.session_id, task }))

    const publishUpdated = (task: Task, kind: UpdatedKind) =>
      Effect.runFork(bus.publish(TaskUpdated, { sessionID: task.session_id, task, kind }))

    const create = Effect.fn("TaskRegistry.create")(function* (input: {
      session_id: SessionID
      summary: string
      parent_id?: string
      owner?: string
    }) {
      const now = Date.now()
      const siblings = yield* db
        .select({ id: TaskTable.id })
        .from(TaskTable)
        .where(
          and(
            eq(TaskTable.session_id, input.session_id),
            input.parent_id ? eq(TaskTable.parent_task_id, input.parent_id) : isNull(TaskTable.parent_task_id),
          ),
        )
        .all().pipe(Effect.orDie)
      const id = nextChildId(
        input.parent_id,
        siblings.map((s) => s.id),
      )

      const row: TaskRow = {
        id,
        session_id: input.session_id,
        parent_task_id: input.parent_id ?? null,
        status: "open",
        summary: input.summary,
        owner: input.owner ?? null,
        created_at: now,
        last_event_at: now,
        ended_at: null,
        cleanup_after: null,
      }
      yield* db.insert(TaskTable).values(row).run().pipe(Effect.orDie)
      insertEvent(input.session_id, id, "created", undefined, now)
      const task = fromTaskRow(row)
      publishCreated(task)
      return task
    })

    const list = Effect.fn("TaskRegistry.list")(function* (input: {
      session_id?: SessionID
      status?: Task["status"]
      owner?: string
      include_terminal?: boolean
      include_archived?: boolean
    }) {
      const now = Date.now()
      const conds: SQL[] = []
      if (input.session_id) conds.push(eq(TaskTable.session_id, input.session_id))
      if (input.status) conds.push(eq(TaskTable.status, input.status))
      if (input.owner) conds.push(eq(TaskTable.owner, input.owner))
      if (!input.include_terminal) {
        const nonTerminal = or(
          eq(TaskTable.status, "open"),
          eq(TaskTable.status, "in_progress"),
          eq(TaskTable.status, "blocked"),
        )
        if (nonTerminal) conds.push(nonTerminal)
      }
      if (!input.include_archived) {
        const notArchived = or(isNull(TaskTable.cleanup_after), gt(TaskTable.cleanup_after, now))
        if (notArchived) conds.push(notArchived)
      }
      const where = conds.length > 0 ? and(...conds) : undefined
      const rows = yield* db.select().from(TaskTable).where(where).orderBy(TaskTable.created_at).all().pipe(Effect.orDie)
      return rows.map(fromTaskRow)
    })

    const get = Effect.fn("TaskRegistry.get")(function* (input: { session_id: SessionID; id: string }) {
      const row = yield* db
        .select()
        .from(TaskTable)
        .where(and(eq(TaskTable.session_id, input.session_id), eq(TaskTable.id, input.id)))
        .get().pipe(Effect.orDie)
      return row ? fromTaskRow(row) : undefined
    })

    const events = Effect.fn("TaskRegistry.events")(function* (input: { session_id: SessionID; task_id: string }) {
      const rows = yield* db
        .select()
        .from(TaskEventTable)
        .where(and(eq(TaskEventTable.session_id, input.session_id), eq(TaskEventTable.task_id, input.task_id)))
        .orderBy(TaskEventTable.at)
        .all().pipe(Effect.orDie)
      return rows.map(fromEventRow)
    })

    const block = Effect.fn("TaskRegistry.block")(function* (input: {
      session_id: SessionID
      id: string
      event_summary?: string
    }) {
      const now = Date.now()
      yield* db.update(TaskTable)
        .set({ status: "blocked", last_event_at: now })
        .where(and(eq(TaskTable.session_id, input.session_id), eq(TaskTable.id, input.id)))
        .run().pipe(Effect.orDie)
      insertEvent(input.session_id, input.id, "blocked", input.event_summary, now)
      const updated = yield* get({ session_id: input.session_id, id: input.id })
      if (!updated) return yield* Effect.die(new RecoverableError(notFoundMessage(input.id)))
      publishUpdated(updated, "blocked")
      return updated
    })

    const unblock = Effect.fn("TaskRegistry.unblock")(function* (input: {
      session_id: SessionID
      id: string
      event_summary?: string
    }) {
      const now = Date.now()
      yield* db.update(TaskTable)
        .set({ status: "open", last_event_at: now })
        .where(and(eq(TaskTable.session_id, input.session_id), eq(TaskTable.id, input.id)))
        .run().pipe(Effect.orDie)
      insertEvent(input.session_id, input.id, "unblocked", input.event_summary, now)
      const updated = yield* get({ session_id: input.session_id, id: input.id })
      if (!updated) return yield* Effect.die(new RecoverableError(notFoundMessage(input.id)))
      publishUpdated(updated, "unblocked")
      return updated
    })

    const start = Effect.fn("TaskRegistry.start")(function* (input: {
      session_id: SessionID
      id: string
      owner?: string
      event_summary?: string
    }) {
      const now = Date.now()
      const existing = yield* get({ session_id: input.session_id, id: input.id })
      if (!existing) return yield* Effect.die(new RecoverableError(notFoundMessage(input.id)))

      if (existing.status === "done" || existing.status === "abandoned") {
        yield* Effect.logWarning(`refusing to start terminal task ${input.id} (status=${existing.status})`)
        return existing
      }

      const owner = input.owner ?? existing.owner
      if (existing.status === "in_progress" && owner === existing.owner) return existing

      yield* db.update(TaskTable)
        .set({ status: "in_progress", owner: owner ?? null, last_event_at: now })
        .where(and(eq(TaskTable.session_id, input.session_id), eq(TaskTable.id, input.id)))
        .run().pipe(Effect.orDie)
      insertEvent(input.session_id, input.id, "started", input.event_summary, now)
      const updated = yield* get({ session_id: input.session_id, id: input.id })
      if (!updated) return yield* Effect.die(new RecoverableError(notFoundMessage(input.id)))
      publishUpdated(updated, "started")
      return updated
    })

    const done = Effect.fn("TaskRegistry.done")(function* (input: {
      session_id: SessionID
      id: string
      event_summary?: string
    }) {
      const now = Date.now()
      const cleanup = yield* cleanupAfter(now)
      yield* db.update(TaskTable)
        .set({
          status: "done",
          ended_at: now,
          cleanup_after: cleanup,
          last_event_at: now,
        })
        .where(and(eq(TaskTable.session_id, input.session_id), eq(TaskTable.id, input.id)))
        .run().pipe(Effect.orDie)
      insertEvent(input.session_id, input.id, "done", input.event_summary, now)
      const updated = yield* get({ session_id: input.session_id, id: input.id })
      if (!updated) return yield* Effect.die(new RecoverableError(notFoundMessage(input.id)))
      publishUpdated(updated, "done")
      return updated
    })

    const abandon = Effect.fn("TaskRegistry.abandon")(function* (input: {
      session_id: SessionID
      id: string
      event_summary?: string
    }) {
      const now = Date.now()
      const cleanup = yield* cleanupAfter(now)
      yield* db.update(TaskTable)
        .set({
          status: "abandoned",
          ended_at: now,
          cleanup_after: cleanup,
          last_event_at: now,
        })
        .where(and(eq(TaskTable.session_id, input.session_id), eq(TaskTable.id, input.id)))
        .run().pipe(Effect.orDie)
      insertEvent(input.session_id, input.id, "abandoned", input.event_summary, now)
      const updated = yield* get({ session_id: input.session_id, id: input.id })
      if (!updated) return yield* Effect.die(new RecoverableError(notFoundMessage(input.id)))
      publishUpdated(updated, "abandoned")
      return updated
    })

    const rename = Effect.fn("TaskRegistry.rename")(function* (input: {
      session_id: SessionID
      id: string
      summary: string
    }) {
      const now = Date.now()
      yield* db.update(TaskTable)
        .set({ summary: input.summary, last_event_at: now })
        .where(and(eq(TaskTable.session_id, input.session_id), eq(TaskTable.id, input.id)))
        .run().pipe(Effect.orDie)
      insertEvent(input.session_id, input.id, "renamed", input.summary, now)
      const updated = yield* get({ session_id: input.session_id, id: input.id })
      if (!updated) return yield* Effect.die(new RecoverableError(notFoundMessage(input.id)))
      publishUpdated(updated, "renamed")
      return updated
    })

    return Service.of({
      create,
      list,
      get,
      events,
      block,
      unblock,
      done,
      abandon,
      rename,
      start,
    })
  }),
)

export const defaultLayer = Layer.suspend(() =>
  layer.pipe(Layer.provide(Bus.defaultLayer), Layer.provide(Config.defaultLayer), Layer.provide(Database.node.implementation as Layer.Layer<never>)),
)

export * as TaskRegistry from "./registry"
