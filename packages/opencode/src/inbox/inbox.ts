import { Context, Effect, Layer, Scope, Schema, Option } from "effect"
import { ulid } from "ulid"
import { Database } from "@opencode-ai/core/database/database"
import { eq, and, lte, inArray } from "drizzle-orm"
import { Bus } from "@/bus"
import { ActorRegistry } from "@/actor/registry"
import { Session } from "@/session/session"
import { MessageID, PartID } from "@/session/schema"
import { InboxArrived } from "@/actor/events"
import type { SessionID } from "@/session/schema"
import { Log } from "@/util/log"
import { InboxTable } from "./inbox.sql"
import { renderInboxRow } from "./render"
import { sessionPromptRef, inboxServiceRef, defaultModelRef } from "./inbox-ref"

const log = Log.create({ service: "inbox" })

const GC_TTL_MS = 7 * 24 * 60 * 60 * 1000
export const MAX_DRAIN_PER_TURN = 100

export function gcInboxRows(cutoffMs: number) {
  return Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db.delete(InboxTable).where(lte(InboxTable.created_at, cutoffMs)).run().pipe(Effect.orDie)
  })
}

export class InboxReceiverNotFound extends Schema.TaggedErrorClass<InboxReceiverNotFound>()(
  "InboxReceiverNotFound",
  {
    receiverSessionID: Schema.String,
    receiverActorID: Schema.String,
  },
) {}

export interface DrainSeed {
  agent: string
  model: { providerID: string; modelID: string; variant?: string }
}

export function resolveDrainSeed(
  sessions: Session.Interface,
  reg: ActorRegistry.Interface,
  sessionID: SessionID,
  actorID: string,
): Effect.Effect<DrainSeed | undefined, never> {
  return Effect.gen(function* () {
    const actor = yield* reg.get(sessionID, actorID)
    const crossSlice = actor?.mode === "peer"
    const match = yield* sessions.findMessage(
      sessionID,
      (m) =>
        (m.info.role === "user" || m.info.role === "assistant") &&
        "model" in m.info &&
        m.info.model !== undefined &&
        (m.info.model as { providerID?: string }).providerID !== "system" &&
        "agent" in m.info &&
        (m.info as { agent?: string }).agent !== "system",
    ).pipe(Effect.orElseSucceed(() => Option.none()))
    if (Option.isSome(match)) {
      const info = match.value.info
      if ("model" in info && info.model && "agent" in info) {
        return { agent: (info as { agent: string }).agent, model: info.model as { providerID: string; modelID: string } }
      }
    }

    const resolver = defaultModelRef.current
    if (actor && resolver) {
      const model = yield* resolver.defaultModel()
      return { agent: actor.agent, model: { providerID: model.providerID, modelID: model.modelID } }
    }

    return undefined
  })
}

export interface SendInput {
  receiverSessionID: SessionID
  receiverActorID: string
  senderSessionID?: SessionID
  senderActorID?: string
  content: string
  type?: string
}

export interface SendResult {
  inboxID: string
}

export interface Interface {
  readonly send: (input: SendInput) => Effect.Effect<SendResult, InboxReceiverNotFound>
  readonly drain: (sessionID: SessionID, actorID: string) => Effect.Effect<number>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Inbox") {}

export const layer: Layer.Layer<
  Service,
  never,
  Bus.Service | ActorRegistry.Service | Session.Service | Database.Service
> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const bus = yield* Bus.Service
    const reg = yield* ActorRegistry.Service
    const sessions = yield* Session.Service
    const scope = yield* Scope.Scope
    const { db } = yield* Database.Service

    yield* gcInboxRows(Date.now() - GC_TTL_MS)
    log.info("inbox gc-on-init complete")

    const send = Effect.fn("Inbox.send")(function* (input: SendInput) {
      const receiver = yield* reg.get(input.receiverSessionID, input.receiverActorID)
      if (!receiver) {
        return yield* Effect.fail(
          new InboxReceiverNotFound({
            receiverSessionID: input.receiverSessionID,
            receiverActorID: input.receiverActorID,
          }),
        )
      }

      const row = {
        id: ulid(),
        receiver_session_id: input.receiverSessionID,
        receiver_actor_id: input.receiverActorID,
        sender_session_id: input.senderSessionID ?? null,
        sender_actor_id: input.senderActorID ?? null,
        type: input.type ?? "text",
        content: { text: input.content },
        created_at: Date.now(),
      }
      yield* db.insert(InboxTable).values(row).run().pipe(Effect.orDie)
      yield* bus.publish(InboxArrived, {
        receiverSessionID: input.receiverSessionID,
        receiverActorID: input.receiverActorID,
        ...(input.senderSessionID !== undefined ? { senderSessionID: input.senderSessionID } : {}),
        ...(input.senderActorID !== undefined ? { senderActorID: input.senderActorID } : {}),
        inboxID: row.id,
        type: row.type,
      })

      const promptRef = sessionPromptRef.current
      if (promptRef) {
        yield* promptRef
          .loop({
            sessionID: input.receiverSessionID,
            agentID: input.receiverActorID,
            notifyParentOnComplete: true,
          })
          .pipe(Effect.ignore, Effect.forkIn(scope))
      } else {
        log.warn("inbox.send: sessionPromptRef.current undefined — wake skipped", {
          receiverActorID: input.receiverActorID,
        })
      }

      return { inboxID: row.id }
    })

    const drain = Effect.fn("Inbox.drain")(function* (
      sessionID: SessionID,
      actorID: string,
    ) {
      const rows = yield* db
          .select()
          .from(InboxTable)
          .where(
            and(
              eq(InboxTable.receiver_session_id, sessionID),
              eq(InboxTable.receiver_actor_id, actorID),
            ),
          )
          .orderBy(InboxTable.id)
          .limit(MAX_DRAIN_PER_TURN)
          .all().pipe(Effect.orDie)
      if (rows.length === 0) return 0

      const seed = yield* resolveDrainSeed(sessions, reg, sessionID, actorID)
      if (!seed) {
        log.warn("inbox.drain: no model source — leaving rows durable", {
          sessionID,
          actorID,
          pending: rows.length,
        })
        return 0
      }

      const rendered = rows.flatMap((row) => {
        const text = renderInboxRow(row)
        if (text.trim().length > 0) return [{ row, text }]
        log.warn("inbox.drain: dropping row that rendered blank", {
          sessionID,
          actorID,
          rowID: row.id,
          type: row.type,
        })
        return []
      })

      if (rendered.length === 0) {
        yield* db
            .delete(InboxTable)
            .where(inArray(InboxTable.id, rows.map((r: any) => r.id)))
            .run().pipe(Effect.orDie)
        return 0
      }

      const msgID = MessageID.ascending()
      const now = Date.now()
      yield* sessions.updateMessage({
        id: msgID,
        role: "user" as const,
        sessionID,
        agentID: actorID,
        time: { created: now },
        agent: seed.agent,
        model: seed.model,
      } as any)
      for (const entry of rendered) {
        yield* sessions.updatePart({
          id: PartID.ascending(),
          messageID: msgID,
          sessionID,
          type: "text" as const,
          synthetic: true,
          text: entry.text,
        } as any)
      }
      yield* db
        .delete(InboxTable)
        .where(inArray(InboxTable.id, rows.map((r) => r.id)))
        .run().pipe(Effect.orDie)

      return rendered.length
    })

    const impl = Service.of({ send, drain })
    inboxServiceRef.current = impl
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        if (inboxServiceRef.current === impl) inboxServiceRef.current = undefined
      }),
    )
    return impl
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(Bus.defaultLayer),
  Layer.provide(ActorRegistry.defaultLayer),
  Layer.provide(Session.defaultLayer),
)
