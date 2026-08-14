import { Context, Deferred, Effect, Layer } from "effect"
import { Bus } from "@/bus"
import { ActorRegistry } from "@/actor/registry"
import type { Actor } from "@/actor/schema"
import { Session } from "@/session/session"
import type { SessionID } from "@/session/schema"
import { ActorStatusChanged } from "@/actor/events"
import { parseReturnHeader, type ReturnStatus } from "@/actor/return-header"

export interface WaitResult {
  status: Actor["status"] | "timeout" | "unknown"
  actor_id: string
  description?: string
  agent?: string
  background?: boolean
  turnCount?: number
  lastTurnTime?: number
  result?: string
  structured?: unknown
  error?: string
  lastOutcome?: Actor["lastOutcome"]
  reportedStatus?: ReturnStatus
  reportedSummary?: string
  time?: { created: number; updated: number; completed?: number }
}

const DEFAULT_TIMEOUT_MS = 600_000

function isWaitResolving(entry: Pick<Actor, "status" | "lastOutcome" | "lifecycle">): boolean {
  return (
    entry.status === "idle" &&
    (entry.lifecycle === "ephemeral" || (entry.lastOutcome !== undefined && entry.lastOutcome !== "success"))
  )
}

export interface Interface {
  readonly wait: (input: {
    sessionID: SessionID
    actor_id: string
    timeout_ms?: number
  }) => Effect.Effect<WaitResult>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/ActorWaiter") {}

export const layer: Layer.Layer<Service, never, Bus.Service | ActorRegistry.Service | Session.Service> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const reg = yield* ActorRegistry.Service
    const bus = yield* Bus.Service
    const sessions = yield* Session.Service

    const lastAssistantResult = (sessionID: SessionID, actorID: string) =>
      Effect.gen(function* () {
        const msgs = yield* sessions.messages({ sessionID })
        const filtered = msgs.filter((m) => {
          const info = m.info as { agent?: string }
          return info.agent === actorID || actorID === "main"
        })
        const last = filtered.findLast((m) => m.info.role === "assistant")
        if (!last) return { result: undefined as string | undefined, structured: undefined as unknown }
        const structured = last.info.role === "assistant" ? (last.info as { structured?: unknown }).structured : undefined
        if (structured !== undefined) return { result: undefined as string | undefined, structured }
        const textPart = last.parts.findLast(
          (p): p is Extract<(typeof last.parts)[number], { type: "text" }> => p.type === "text",
        )
        return { result: textPart?.text, structured: undefined as unknown }
      })

    const snapshot = (sessionID: SessionID, actorID: string, entry: Actor): Effect.Effect<WaitResult> =>
      Effect.gen(function* () {
        const extracted =
          entry.status === "idle" && entry.lastOutcome === "success"
            ? yield* lastAssistantResult(sessionID, actorID).pipe(Effect.catchCause(() => Effect.succeed({ result: undefined as string | undefined, structured: undefined as unknown })))
            : { result: undefined as string | undefined, structured: undefined as unknown }
        const reported = parseReturnHeader(extracted.result)
        const result: WaitResult = {
          status: entry.status,
          actor_id: entry.actorID,
        }
        if (entry.description) result.description = entry.description
        if (entry.agent) result.agent = entry.agent
        if (entry.background) result.background = entry.background
        if (entry.turnCount !== undefined) result.turnCount = entry.turnCount
        if (entry.lastTurnTime !== undefined) result.lastTurnTime = entry.lastTurnTime
        if (entry.lastOutcome !== undefined) result.lastOutcome = entry.lastOutcome
        if (entry.lastError !== undefined) result.error = entry.lastError
        if (extracted.result !== undefined) result.result = extracted.result
        if (extracted.structured !== undefined) result.structured = extracted.structured
        if (reported.status) result.reportedStatus = reported.status
        if (reported.summary) result.reportedSummary = reported.summary
        if (entry.time) result.time = entry.time
        return result
      })

    const wait = Effect.fn("ActorWaiter.wait")(function* (input: {
      sessionID: SessionID
      actor_id: string
      timeout_ms?: number
    }) {
      const entry = yield* reg.get(input.sessionID, input.actor_id)
      if (!entry) return { status: "unknown" as const, actor_id: input.actor_id }
      if (isWaitResolving(entry)) return yield* snapshot(input.sessionID, input.actor_id, entry)

      const resolved = yield* Deferred.make<WaitResult>()
      const timeoutMs = input.timeout_ms ?? DEFAULT_TIMEOUT_MS

      return yield* Effect.acquireUseRelease(
        bus.subscribeCallback(ActorStatusChanged, (evt) => {
          if (evt.properties.actorID !== input.actor_id) return
          if (evt.properties.sessionID !== input.sessionID) return
          Effect.runFork(
            Effect.gen(function* () {
              const fresh = yield* reg.get(input.sessionID, input.actor_id)
              if (!fresh) return
              if (!isWaitResolving(fresh)) return
              const snap = yield* snapshot(input.sessionID, input.actor_id, fresh)
              Deferred.doneUnsafe(resolved, Effect.succeed(snap))
            }).pipe(
              Effect.catchCause((cause) =>
                Effect.logError(`waiter rehydrate failed: ${cause}`),
              ),
            ),
          )
        }),
        () =>
          Effect.gen(function* () {
            const recheck = yield* reg.get(input.sessionID, input.actor_id)
            if (recheck && isWaitResolving(recheck)) {
              return yield* snapshot(input.sessionID, input.actor_id, recheck)
            }
            const raced = yield* Deferred.await(resolved).pipe(
              Effect.timeout(timeoutMs),
              Effect.catchTag("TimeoutError", () => Effect.succeed(null)),
            )
            if (raced === null) {
              return { status: "timeout" as const, actor_id: input.actor_id }
            }
            return raced
          }),
        (unsub) => Effect.sync(() => unsub()),
      )
    })

    return Service.of({ wait })
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(Bus.defaultLayer),
  Layer.provide(ActorRegistry.defaultLayer),
  Layer.provide(Session.defaultLayer),
)

export * as ActorWaiter from "./waiter"
