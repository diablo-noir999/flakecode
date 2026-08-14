import { Context, Effect, Layer } from "effect"
import { and, asc, desc, eq, gt, sql } from "drizzle-orm"
import { Database } from "../database/database"
import { SessionV1 } from "../v1/session"
import { PartTable, SessionTable } from "../session/sql"
import { HistoryFtsTable } from "./fts.sql"
import { extract, DEFAULT_KINDS, type Kind } from "./extract"
import { makeResolver, type Resolver } from "./resolve"
import { makeGlobalNode } from "../effect/app-node"

const BATCH = 500

export function backfillAll(enabled: ReadonlySet<Kind> = new Set(DEFAULT_KINDS)) {
  return Effect.gen(function* () {
    if (enabled.size === 0) return

    const { db } = yield* Database.Service
    const resolver = makeResolver()
    const sessions = yield* db
      .select({ id: SessionTable.id, project_id: SessionTable.project_id })
      .from(SessionTable)
      .orderBy(desc(SessionTable.time_updated))
      .all()
      .pipe(Effect.orDie)

    for (const session of sessions) {
      yield* scanSession(session, resolver, enabled).pipe(
        Effect.catchCause(() => Effect.void),
      )
      yield* Effect.sleep("50 millis")
    }
  })
}

function scanSession(
  session: { id: string; project_id: string },
  resolver: Resolver,
  enabled: ReadonlySet<Kind>,
) {
  return Effect.gen(function* () {
    const { db } = yield* Database.Service
    let cursor = ""
    while (true) {
      const parts = yield* db
        .select()
        .from(PartTable)
        .where(
          and(
            eq(PartTable.session_id, session.id as any),
            gt(PartTable.id, cursor as any),
            sql`NOT EXISTS (SELECT 1 FROM history_fts WHERE history_fts.part_id = ${PartTable.id})`,
          ),
        )
        .orderBy(asc(PartTable.id))
        .limit(BATCH)
        .all()
        .pipe(Effect.orDie)
      if (parts.length === 0) return

      yield* writeBatch(parts, session.project_id, resolver, enabled)
      cursor = parts[parts.length - 1]!.id
      yield* Effect.sleep("10 millis")
    }
  })
}

function writeBatch(
  parts: Array<{ id: string; session_id: string; message_id: string; data: unknown; time_created: number }>,
  projectID: string,
  resolver: Resolver,
  enabled: ReadonlySet<Kind>,
) {
  return Effect.gen(function* () {
    const { db } = yield* Database.Service
    type ToWrite = {
      part: (typeof parts)[number]
      kind: Kind
      body: string
      tool_name: string | null
      time: number
    }
    const writes: ToWrite[] = []
    for (const p of parts) {
      const role = yield* resolver.role(p.message_id)
      const fullPart = {
        id: p.id,
        sessionID: p.session_id,
        messageID: p.message_id,
        ...(p.data as object),
      } as SessionV1.Part
      const extracted = extract(fullPart, role, enabled)
      if (!extracted) continue
      writes.push({
        part: p,
        kind: extracted.kind,
        body: extracted.body,
        tool_name: extracted.tool_name,
        time: p.time_created,
      })
    }
    if (writes.length === 0) return
    yield* db.transaction((tx) =>
      Effect.gen(function* () {
        for (const w of writes) {
          yield* tx
            .insert(HistoryFtsTable)
            .values({
              part_id: w.part.id,
              session_id: w.part.session_id,
              message_id: w.part.message_id,
              project_id: projectID,
              kind: w.kind,
              tool_name: w.tool_name,
              body: w.body,
              time_created: w.time,
            })
            .onConflictDoUpdate({
              target: HistoryFtsTable.part_id,
              set: { kind: w.kind, tool_name: w.tool_name, body: w.body, time_created: w.time },
            })
            .run()
            .pipe(Effect.orDie)
        }
      }),
    ).pipe(Effect.orDie)
  })
}

export interface Interface {
  readonly init: () => Effect.Effect<void, never, Database.Service>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/History.Backfill") {}

export const layer: Layer.Layer<Service, never, never> = Layer.effect(
  Service,
  Effect.gen(function* () {
    return Service.of({
      init: () => backfillAll().pipe(Effect.catchCause(() => Effect.void), Effect.forkDetach, Effect.asVoid),
    })
  }),
)

export const node = makeGlobalNode({ name: "history-backfill", layer, deps: [Database.node] })
