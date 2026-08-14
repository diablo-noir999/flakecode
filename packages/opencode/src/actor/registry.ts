import { Effect, Layer, Context, Schedule } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { inArray, eq, and, lte, sql } from "drizzle-orm"
import { Bus } from "@/bus"
import type { SessionID, MessageID } from "@/session/schema"
import { ActorRegistryTable } from "./actor.sql"
import { SessionTable } from "@opencode-ai/core/session/sql"
import type { Actor, ActorStatus, ActorOutcome, ContextMode, Lifecycle, SpawnMode, ToolWhitelist, Liveness, SpawnConfig } from "./schema"
import { deriveLiveness } from "./schema"
import * as Events from "./events"
import { Log } from "@/util/log"
import { randomUUID } from "node:crypto"

const log = Log.create({ service: "actor.registry" })

const STUCK_THRESHOLD_MS = 5 * 60 * 1000
const SCAN_INTERVAL_MS = 60 * 1000

const PROCESS_INSTANCE_ID = randomUUID()

type ActorRow = typeof ActorRegistryTable.$inferSelect

function fromRow(row: ActorRow): Actor {
  return {
    sessionID: row.session_id,
    actorID: row.actor_id,
    mode: row.mode,
    parentActorID: row.parent_actor_id ?? undefined,
    status: row.status,
    lastOutcome: row.last_outcome ?? undefined,
    lifecycle: row.lifecycle,
    agent: row.agent,
    description: row.description,
    contextMode: row.context_mode,
    contextWatermark: row.context_watermark ?? undefined,
    background: Boolean(row.background),
    tools: row.tools ?? undefined,
    lastTurnTime: row.last_turn_time,
    turnCount: row.turn_count,
    lastActivityTime: row.last_activity_time ?? undefined,
    lastError: row.last_error ?? undefined,
    resumable: Boolean(row.resumable),
    spawnConfig: row.spawn_config ?? undefined,
    checkpoint: row.checkpoint ?? undefined,
    originalActorID: row.original_actor_id ?? undefined,
    time: {
      created: row.time_created,
      updated: row.time_updated,
      completed: row.time_completed ?? undefined,
    },
  }
}

export interface Interface {
  readonly register: (input: {
    sessionID: SessionID
    actorID: string
    mode: SpawnMode
    parentActorID?: string
    agent: string
    description: string
    contextMode: ContextMode
    contextWatermark?: MessageID
    background: boolean
    lifecycle: Lifecycle
    tools?: ToolWhitelist
    resumable?: boolean
    spawnConfig?: SpawnConfig
    originalActorID?: string
  }) => Effect.Effect<Actor>

  readonly updateStatus: (
    sessionID: SessionID,
    actorID: string,
    patch: {
      status: ActorStatus
      lastOutcome?: ActorOutcome | undefined
      lastError?: string | undefined
    },
  ) => Effect.Effect<void>
  readonly updateTurn: (sessionID: SessionID, actorID: string) => Effect.Effect<void>
  readonly updateAgent: (sessionID: SessionID, actorID: string, agent: string) => Effect.Effect<void>
  readonly updateCheckpoint: (sessionID: SessionID, actorID: string, checkpoint: Record<string, unknown>) => Effect.Effect<void>
  readonly get: (sessionID: SessionID, actorID: string) => Effect.Effect<Actor | undefined>
  readonly liveness: (
    sessionID: SessionID,
    actorID: string,
    stallMs?: number,
  ) => Effect.Effect<{ liveness: Liveness; actor: Actor } | undefined>
  readonly listBySession: (sessionID: SessionID) => Effect.Effect<Actor[]>
  readonly listActive: () => Effect.Effect<Actor[]>
  readonly listByParent: (sessionID: SessionID, parentActorID: string) => Effect.Effect<Actor[]>
  readonly listPeerChildren: (
    parentSessionID: SessionID,
    parentActorID: string,
  ) => Effect.Effect<{ actor: Actor; title: string }[]>
  readonly listResumable: () => Effect.Effect<Actor[]>
  readonly renderForAgent: (sessionID: SessionID) => Effect.Effect<string>
  readonly agentTypeFor: (sessionID: SessionID, actorID: string) => Effect.Effect<string>
  readonly isSystemSpawned: (sessionID: SessionID, actorID: string) => Effect.Effect<boolean>
  readonly servesCheckpoint: (sessionID: SessionID, actorID: string | undefined) => Effect.Effect<boolean>
  readonly allocateActorID: (sessionID: SessionID, agentType: string) => Effect.Effect<string>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/ActorRegistry") {}

export const layer: Layer.Layer<Service, never, Bus.Service | Database.Service> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const bus = yield* Bus.Service
    const database = yield* Database.Service
    const db = database.db

    const instanceID = PROCESS_INSTANCE_ID

    const register = Effect.fn("ActorRegistry.register")(function* (input: {
      sessionID: SessionID
      actorID: string
      mode: SpawnMode
      parentActorID?: string
      agent: string
      description: string
      contextMode: ContextMode
      contextWatermark?: MessageID
      background: boolean
      lifecycle: Lifecycle
      tools?: ToolWhitelist
      resumable?: boolean
      spawnConfig?: SpawnConfig
      originalActorID?: string
    }) {
      const now = Date.now()
      const row = {
        session_id: input.sessionID,
        actor_id: input.actorID,
        mode: input.mode,
        parent_actor_id: input.parentActorID ?? null,
        status: "pending" as const,
        last_outcome: null,
        lifecycle: input.lifecycle,
        agent: input.agent,
        description: input.description,
        context_mode: input.contextMode,
        context_watermark: input.contextWatermark ?? null,
        background: input.background,
        tools: input.tools ?? null,
        last_turn_time: now,
        turn_count: 0,
        last_activity_time: null,
        last_error: null,
        instance_id: instanceID,
        resumable: input.resumable ?? false,
        spawn_config: input.spawnConfig ?? null,
        checkpoint: null,
        original_actor_id: input.originalActorID ?? null,
        resume_count: 0,
        time_completed: null,
        time_created: now,
        time_updated: now,
      }
      yield* db.insert(ActorRegistryTable).values(row).run().pipe(Effect.orDie)
      yield* bus.publish(Events.ActorRegistered, {
        sessionID: input.sessionID,
        actorID: input.actorID,
        mode: input.mode,
        parentActorID: input.parentActorID,
        description: input.description,
        agent: input.agent,
        background: input.background,
      })
      return fromRow(row)
    })

    const updateStatus = Effect.fn("ActorRegistry.updateStatus")(function* (
      sessionID: SessionID,
      actorID: string,
      patch: {
        status: ActorStatus
        lastOutcome?: ActorOutcome | undefined
        lastError?: string | undefined
      },
    ) {
      const now = Date.now()
      const isTerminal = patch.status === "idle" && patch.lastOutcome !== undefined
      const set: Record<string, unknown> = {
        status: patch.status,
        time_updated: now,
        ...(isTerminal ? { time_completed: now } : {}),
      }
      if (patch.lastOutcome !== undefined) set.last_outcome = patch.lastOutcome
      if (patch.lastError !== undefined) set.last_error = patch.lastError
      else if (patch.lastOutcome !== undefined && patch.lastOutcome !== "failure") set.last_error = null
      yield* db
          .update(ActorRegistryTable)
          .set(set)
          .where(
            and(eq(ActorRegistryTable.session_id, sessionID), eq(ActorRegistryTable.actor_id, actorID)),
          )
          .run().pipe(Effect.orDie)
      const row = yield* db
          .select()
          .from(ActorRegistryTable)
          .where(
            and(eq(ActorRegistryTable.session_id, sessionID), eq(ActorRegistryTable.actor_id, actorID)),
          )
          .get().pipe(Effect.orDie)
      if (!row) return
      yield* bus.publish(Events.ActorStatusChanged, {
        sessionID,
        actorID,
        status: row.status,
        ...(row.last_outcome ? { lastOutcome: row.last_outcome } : {}),
        turnCount: row.turn_count,
        lastTurnTime: row.last_turn_time,
        ...(row.last_error ? { error: row.last_error } : {}),
      })
    })

    const updateTurn = Effect.fn("ActorRegistry.updateTurn")(function* (sessionID: SessionID, actorID: string) {
      const now = Date.now()
      yield* db
          .update(ActorRegistryTable)
          .set({
            last_turn_time: now,
            turn_count: sql`${ActorRegistryTable.turn_count} + 1`,
            time_updated: now,
          })
          .where(
            and(eq(ActorRegistryTable.session_id, sessionID), eq(ActorRegistryTable.actor_id, actorID)),
          )
          .run().pipe(Effect.orDie)
    })

    const updateAgent = Effect.fn("ActorRegistry.updateAgent")(function* (
      sessionID: SessionID,
      actorID: string,
      agent: string,
    ) {
      yield* db
          .update(ActorRegistryTable)
          .set({ agent, time_updated: Date.now() })
          .where(
            and(eq(ActorRegistryTable.session_id, sessionID), eq(ActorRegistryTable.actor_id, actorID)),
          )
          .run().pipe(Effect.orDie)
    })

    const updateCheckpoint = Effect.fn("ActorRegistry.updateCheckpoint")(function* (
      sessionID: SessionID,
      actorID: string,
      checkpoint: Record<string, unknown>,
    ) {
      const now = Date.now()
      yield* db
          .update(ActorRegistryTable)
          .set({ checkpoint, time_updated: now })
          .where(
            and(eq(ActorRegistryTable.session_id, sessionID), eq(ActorRegistryTable.actor_id, actorID)),
          )
          .run().pipe(Effect.orDie)
    })

    const get = Effect.fn("ActorRegistry.get")(function* (sessionID: SessionID, actorID: string) {
      const row = yield* db
          .select()
          .from(ActorRegistryTable)
          .where(
            and(eq(ActorRegistryTable.session_id, sessionID), eq(ActorRegistryTable.actor_id, actorID)),
          )
          .get().pipe(Effect.orDie)
      return row ? fromRow(row) : undefined
    })

    const liveness = Effect.fn("ActorRegistry.liveness")(function* (
      sessionID: SessionID,
      actorID: string,
      stallMs?: number,
    ) {
      const actor = yield* get(sessionID, actorID)
      if (!actor) return undefined
      return { liveness: deriveLiveness(actor, Date.now(), stallMs), actor }
    })

    const listBySession = Effect.fn("ActorRegistry.listBySession")(function* (sessionID: SessionID) {
      const rows = yield* db.select().from(ActorRegistryTable).where(eq(ActorRegistryTable.session_id, sessionID)).all().pipe(Effect.orDie)
      return rows.map(fromRow)
    })

    const listActive = Effect.fn("ActorRegistry.listActive")(function* () {
      const rows = yield* db
          .select()
          .from(ActorRegistryTable)
          .where(
            and(
              inArray(ActorRegistryTable.status, ["pending", "running"]),
              eq(ActorRegistryTable.background, true),
            ),
          )
          .all().pipe(Effect.orDie)
      return rows.map(fromRow)
    })

    const listByParent = Effect.fn("ActorRegistry.listByParent")(function* (
      sessionID: SessionID,
      parentActorID: string,
    ) {
      const rows = yield* db
          .select()
          .from(ActorRegistryTable)
          .where(
            and(
              eq(ActorRegistryTable.session_id, sessionID),
              eq(ActorRegistryTable.parent_actor_id, parentActorID),
            ),
          )
          .all().pipe(Effect.orDie)
      return rows.map(fromRow)
    })

    const listPeerChildren = Effect.fn("ActorRegistry.listPeerChildren")(function* (
      parentSessionID: SessionID,
      parentActorID: string,
    ) {
      const rows = yield* db
          .select({ actor: ActorRegistryTable, title: SessionTable.title })
          .from(ActorRegistryTable)
          .innerJoin(SessionTable, eq(SessionTable.id, ActorRegistryTable.session_id))
          .where(
            and(
              eq(SessionTable.parent_id, parentSessionID),
              eq(ActorRegistryTable.mode, "peer"),
              eq(ActorRegistryTable.parent_actor_id, parentActorID),
            ),
          )
          .all().pipe(Effect.orDie)
      return rows.map((row) => ({ actor: fromRow(row.actor), title: row.title }))
    })

    const listResumable = Effect.fn("ActorRegistry.listResumable")(function* () {
      const rows = yield* db
          .select()
          .from(ActorRegistryTable)
          .where(
            and(
              eq(ActorRegistryTable.resumable, true),
              inArray(ActorRegistryTable.status, ["pending", "running"]),
            ),
          )
          .all().pipe(Effect.orDie)
      return rows
        .filter((row) => row.instance_id !== instanceID)
        .map(fromRow)
    })

    const renderForAgent = Effect.fn("ActorRegistry.renderForAgent")(function* (sessionID: SessionID) {
      const actors = yield* listBySession(sessionID)
      const active = actors.filter((actor) => actor.background && (actor.status === "pending" || actor.status === "running"))
      if (active.length === 0) return ""

      const lines: string[] = []
      lines.push("## Active Actors")
      lines.push("")
      lines.push(`You have ${active.length} background actor(s) registered. Interact via the \`actor\` tool.`)
      lines.push("")
      const now = Date.now()
      for (const actor of active) {
        const idleMs = now - actor.lastTurnTime
        const idle = idleMs < 60_000 ? `${Math.floor(idleMs / 1000)}s` : `${Math.floor(idleMs / 60_000)}m`
        lines.push(`- actor_id: ${actor.actorID} (${actor.status}, last activity ${idle} ago)`)
        lines.push(`  description: ${actor.description}`)
        lines.push(`  agent: ${actor.agent}`)
      }
      return lines.join("\n")
    })

    const agentTypeFor = Effect.fn("ActorRegistry.agentTypeFor")(function* (
      sessionID: SessionID,
      actorID: string,
    ) {
      if (actorID === "main") return "main"
      const actor = yield* get(sessionID, actorID)
      return actor?.agent ?? "main"
    })

    const isSystemSpawned = Effect.fn("ActorRegistry.isSystemSpawned")(function* (
      sessionID: SessionID,
      actorID: string,
    ) {
      if (actorID === "main") return false
      const actor = yield* get(sessionID, actorID)
      if (!actor) return false
      return SYSTEM_SPAWNED_AGENT_TYPES.has(actor.agent)
    })

    const servesCheckpoint = Effect.fn("ActorRegistry.servesCheckpoint")(function* (
      sessionID: SessionID,
      actorID: string | undefined,
    ) {
      if (!actorID || actorID === "main") return true
      const actor = yield* get(sessionID, actorID)
      if (!actor) return true
      if (SYSTEM_SPAWNED_AGENT_TYPES.has(actor.agent)) return false
      return actor.mode !== "subagent"
    })

    const allocateActorID = Effect.fn("ActorRegistry.allocateActorID")(function* (
      sessionID: SessionID,
      agentType: string,
    ) {
      const existing = yield* db
          .select({ actor_id: ActorRegistryTable.actor_id })
          .from(ActorRegistryTable)
          .where(and(eq(ActorRegistryTable.session_id, sessionID), eq(ActorRegistryTable.agent, agentType)))
          .all().pipe(Effect.orDie)
      const prefix = `${agentType}-`
      let max = 0
      for (const row of existing) {
        if (row.actor_id.startsWith(prefix)) {
          const n = parseInt(row.actor_id.slice(prefix.length), 10)
          if (Number.isFinite(n) && n > max) max = n
        }
      }
      return `${agentType}-${max + 1}`
    })

    yield* Effect.sync(() => {
      const now = Date.now()
      db.run(sql`
        UPDATE actor_registry
        SET status = 'idle',
            last_outcome = 'failure',
            last_error = 'orphaned: process restarted',
            time_updated = ${now},
            time_completed = ${now}
        WHERE status IN ('pending', 'running')
          AND instance_id != ${instanceID}
          AND (resumable IS NULL OR resumable = 0)
      `)
    })
    log.info("orphan recovery complete", { instanceID })

    const scanStuck = Effect.gen(function* () {
      const cutoff = Date.now() - STUCK_THRESHOLD_MS
      const stuck = yield* db
          .select()
          .from(ActorRegistryTable)
          .where(
            and(
              eq(ActorRegistryTable.status, "running"),
              lte(ActorRegistryTable.last_turn_time, cutoff),
            ),
          )
          .all().pipe(Effect.orDie)
      for (const row of stuck) {
        const entry = fromRow(row)
        yield* bus.publish(Events.ActorStuck, {
          sessionID: entry.sessionID,
          actorID: entry.actorID,
          description: entry.description,
          lastTurnTime: entry.lastTurnTime,
          stuckDuration: Date.now() - entry.lastTurnTime,
        })
      }
    })

    yield* scanStuck.pipe(
      Effect.repeat(Schedule.fixed(SCAN_INTERVAL_MS)),
      Effect.ignore,
      Effect.forkScoped,
    )

    return Service.of({
      register,
      updateStatus,
      updateTurn,
      updateAgent,
      updateCheckpoint,
      get,
      liveness,
      listBySession,
      listActive,
      listByParent,
      listPeerChildren,
      listResumable,
      renderForAgent,
      agentTypeFor,
      isSystemSpawned,
      servesCheckpoint,
      allocateActorID,
    })
  }),
)

const SYSTEM_SPAWNED_AGENT_TYPES = new Set<string>(["checkpoint-writer", "title", "summary", "compaction"])

export const defaultLayer = layer.pipe(Layer.provide(Bus.defaultLayer))

export * as ActorRegistry from "./registry"
