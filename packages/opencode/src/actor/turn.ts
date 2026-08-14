import { Cause, Effect, Exit } from "effect"
import { ActorRegistry } from "@/actor/registry"
import type { SessionID } from "@/session/schema"

export interface TurnCheckpoint {
  turnCount: number
  timestamp: number
  lastTurnText?: string
}

export const runTurn = <A, E>(
  sessionID: SessionID,
  actorID: string,
  work: Effect.Effect<A, E>,
  checkpoint?: TurnCheckpoint,
): Effect.Effect<A, E, ActorRegistry.Service> =>
  Effect.uninterruptible(
    Effect.gen(function* () {
      const reg = yield* ActorRegistry.Service
      yield* reg.updateStatus(sessionID, actorID, { status: "running" }).pipe(Effect.ignore)
      const exit: Exit.Exit<A, E> = yield* work.pipe(Effect.interruptible, Effect.exit)
      if (Exit.isSuccess(exit)) {
        yield* reg
          .updateStatus(sessionID, actorID, {
            status: "idle",
            lastOutcome: "success",
            lastError: undefined,
          })
          .pipe(Effect.ignore)
        if (checkpoint) {
          yield* reg
            .updateCheckpoint(sessionID, actorID, {
              ...checkpoint,
              turnCount: checkpoint.turnCount + 1,
              timestamp: Date.now(),
            })
            .pipe(Effect.ignore)
        }
        return exit.value
      }
      const cause = exit.cause
      const cancelled = Cause.hasInterruptsOnly(cause)
      yield* reg
        .updateStatus(sessionID, actorID, {
          status: "idle",
          lastOutcome: cancelled ? "cancelled" : "failure",
          lastError: cancelled ? undefined : extractErrorString(cause),
        })
        .pipe(Effect.ignore)
      return yield* Effect.failCause(cause) as Effect.Effect<A, E>
    }),
  ) as Effect.Effect<A, E, ActorRegistry.Service>

function extractErrorString(cause: Cause.Cause<unknown>): string {
  return Cause.pretty(cause)
}

export * as ActorTurn from "./turn"
