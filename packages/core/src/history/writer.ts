export * as HistoryWriter from "./writer"

import { Context, Effect, Layer, Queue } from "effect"
import { eq } from "drizzle-orm"
import { Database } from "../database/database"
import { EventV2 } from "../event"
import { SessionV1 } from "../v1/session"
import { Config } from "../config"
import { HistoryFtsTable } from "./fts.sql"
import { extract, DEFAULT_KINDS, type Kind } from "./extract"
import { makeResolver, type Resolver } from "./resolve"
import { makeLocationNode } from "../effect/app-node"

type Job =
  | { type: "upsert"; part: SessionV1.Part; sessionID: string; time: number }
  | { type: "delete"; partID: string }

export interface Interface {
  readonly init: () => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/History.Writer") {}

export const layer: Layer.Layer<Service, never, EventV2.Service | Config.Service | Database.Service> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const events = yield* EventV2.Service
    const config = yield* Config.Service

    // Read enabled kinds from config; fall back to DEFAULT_KINDS.
    const cfg = yield* config.entries()
    const historyConfig = cfg.findLast((e) => e.type === "document")?.info.history as
      | { kinds?: readonly string[] }
      | undefined
    const kinds = historyConfig?.kinds ?? DEFAULT_KINDS
    const enabled = new Set<Kind>(kinds as readonly Kind[])

    if (enabled.size === 0) {
      return Service.of({
        init: () => Effect.void,
      })
    }

    const queue = yield* Queue.unbounded<Job>()
    const resolver = makeResolver()

    // Use project (synchronous subscription) so subscriptions are guaranteed
    // live before init() returns. This matches MiMo's subscribeCallback pattern.
    yield* events.project(SessionV1.Event.PartUpdated, (event) =>
      Effect.sync(() =>
        Queue.offerUnsafe(queue, { type: "upsert", part: event.data.part as SessionV1.Part, sessionID: event.data.sessionID, time: event.data.time }),
      ),
    )
    yield* events.project(SessionV1.Event.PartRemoved, (event) =>
      Effect.sync(() => Queue.offerUnsafe(queue, { type: "delete", partID: event.data.partID })),
    )

    yield* Effect.forever(
      Effect.gen(function* () {
        const job = yield* Queue.take(queue)
        yield* handle(job, resolver, enabled).pipe(
          Effect.catchCause(() => Effect.void),
        )
      }),
    ).pipe(Effect.forkScoped)

    return Service.of({
      init: () => Effect.void,
    })
  }),
)

function handle(job: Job, resolver: Resolver, enabled: ReadonlySet<Kind>) {
  if (job.type === "delete") {
    return Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* db.delete(HistoryFtsTable).where(eq(HistoryFtsTable.part_id, job.partID)).run().pipe(Effect.orDie)
    })
  }
  return Effect.gen(function* () {
    const part = job.part
    const role = yield* resolver.role(part.messageID)
    const extracted = extract(part, role, enabled)
    if (!extracted) return
    const projectID = yield* resolver.projectID(job.sessionID)

    const { db } = yield* Database.Service
    yield* db
      .insert(HistoryFtsTable)
      .values({
        part_id: part.id,
        session_id: job.sessionID,
        message_id: part.messageID,
        project_id: projectID,
        kind: extracted.kind,
        tool_name: extracted.tool_name,
        body: extracted.body,
        time_created: job.time,
      })
      .onConflictDoUpdate({
        target: HistoryFtsTable.part_id,
        set: {
          kind: extracted.kind,
          tool_name: extracted.tool_name,
          body: extracted.body,
          time_created: job.time,
        },
      })
      .run()
      .pipe(Effect.orDie)
  })
}

export const node = makeLocationNode({ name: "history-writer", layer, deps: [EventV2.node, Database.node, Config.node] })
