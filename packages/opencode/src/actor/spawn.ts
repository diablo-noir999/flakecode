import { Effect, Deferred, Context, Fiber, Layer, Scope, Cause, Schedule } from "effect"
import { SessionID as SessionIDModule, type SessionID, type MessageID } from "@/session/schema"
import type { ProviderV2 } from "@opencode-ai/core/provider"
import type { ModelV2 } from "@opencode-ai/core/model"
import type { Tool as AITool, ModelMessage } from "ai"
import { Session } from "@/session/session"
import { SessionPrompt } from "@/session/prompt"
import { SessionRunState } from "@/session/run-state"
import { ActorRegistry } from "@/actor/registry"
import { Agent } from "@/agent/agent"
import { Permission } from "@/permission"
import type { Actor, SpawnMode, ContextMode, ToolWhitelist, Lifecycle, SpawnConfig } from "@/actor/schema"
import { deriveLiveness, DEFAULT_LIVENESS_STALL_MS } from "@/actor/schema"
import * as ActorEvents from "@/actor/events"
import { runTurn } from "@/actor/turn"
import { spawnRef } from "@/actor/spawn-ref"
import { Bus } from "@/bus"
import { MessageV2 } from "@/session/message-v2"
import { Inbox } from "@/inbox"
import { renderActorNotification } from "@/inbox/render"
import { parseReturnHeader, type ReturnStatus } from "./return-header"
import { Log } from "@/util/log"
import type { InstanceContext } from "@/project/instance-context"
import { InstanceRef } from "@/effect/instance-ref"

const log = Log.create({ service: "actor.spawn" })

export const MAX_PRE_REACT = 3
export const MAX_POST_REACT = 3
export const WATCHDOG_SCAN_INTERVAL_MS = 45_000

const RETURN_FORMAT_INSTRUCTION = `

---

## Return format (required)

Your FINAL assistant message — what the spawning agent will receive — MUST start with this header block:

  **Status**: success | partial | failed | blocked
  **Summary**: <one sentence describing what happened>

After the header, include the actual deliverable (whatever the task asked for in its prompt).

If applicable, also include below the deliverable:

  **Files touched**: <comma-separated paths or "(none)">
  **Findings worth promoting**: <bullet list of cross-task transferable facts; "(none)" if just routine work>

This format lets the spawning agent and the checkpoint writer extract your progress without parsing free-form prose. Do NOT precede the header with an introduction — your final message must start with "**Status**:".
`

export interface ForkContext {
  readonly system: string[]
  readonly tools: Record<string, AITool>
  readonly parentPermission: Permission.Ruleset
  readonly inheritedMessages: ModelMessage[]
  readonly watermarkMsgID: MessageID
  readonly model: { providerID: ProviderV2.ID; modelID: ModelV2.ID }
}

export type AgentOutcome =
  | {
      status: "success"
      finalText?: string
      structured?: unknown
      reportedStatus?: ReturnStatus
      reportedSummary?: string
      incompleteTasks?: string[]
    }
  | { status: "failure"; error: string; failure?: FailureInfo }
  | { status: "cancelled" }

export type FailureKind = "transient" | "overflow" | "auth" | "aborted" | "other"

export interface FailureInfo {
  readonly kind: FailureKind
  readonly retryable: boolean
  readonly name: string
}

export interface SpawnInput {
  mode: SpawnMode
  sessionID: SessionID
  parentSessionID?: SessionID
  agentType: string
  task: string
  description?: string
  context: ContextMode
  tools: ToolWhitelist
  model?: { providerID: ProviderV2.ID; modelID: ModelV2.ID }
  background: boolean
  parentActorID?: string
  task_id?: string
  cwd?: string
  forkContext?: ForkContext
  lifecycle?: Lifecycle
  format?: MessageV2.OutputFormat
  onActorID?: (actorID: string) => void
  onReady?: (info: { actorID: string; sessionID: SessionID }) => Effect.Effect<void>
  resumable?: boolean
}

export interface SpawnResult {
  actorID: string
  sessionID: SessionID
  outcome: Deferred.Deferred<AgentOutcome>
}

export interface Interface {
  readonly spawn: (input: SpawnInput) => Effect.Effect<SpawnResult>
  readonly cancel: (sessionID: SessionID, actorID: string, mode: "graceful" | "forced") => Effect.Effect<void>
  readonly getForkContext: (actorID: string) => Effect.Effect<ForkContext | undefined>
  readonly scanStalledOnce?: () => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Actor") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const session = yield* Session.Service
    const actorReg = yield* ActorRegistry.Service
    const agents = yield* Agent.Service
    const sessionPrompt = yield* SessionPrompt.Service
    const inbox = yield* Inbox.Service
    const state = yield* SessionRunState.Service
    const bus = yield* Bus.Service
    const scope = yield* Scope.Scope

    const forkContexts = new Map<string, ForkContext>()
    const cancelling = new Set<string>()
    const cancelKey = (sessionID: SessionID, actorID: string) => `${sessionID}:${actorID}`

    const runAgentLoop = Effect.fn("Actor.runAgentLoop")(function* (input: {
      sessionID: SessionID
      actorID: string
      agentType: string
      task: string
      task_id?: string
      model?: { providerID: ProviderV2.ID; modelID: ModelV2.ID }
      source: "spawn" | "hook"
      provenance?: MessageV2.Provenance
      format?: MessageV2.OutputFormat
    }) {
      const result = yield* sessionPrompt.prompt({
        sessionID: input.sessionID,
        agent: input.agentType,
        model: input.model,
        parts: [{ type: "text", text: input.task }],
        ...(input.format ? { format: input.format } : {}),
      })
      const info = (result as MessageV2.WithParts | undefined)?.info
      if (info?.role === "assistant" && info.error) {
        return yield* Effect.fail(
          new AssistantSettledError(
            `Actor assistant failed: ${info.error.name}`,
            { kind: "other", retryable: false, name: info.error.name },
          ),
        )
      }
      const structured = info?.role === "assistant" ? info.structured : undefined
      const finalText =
        structured !== undefined
          ? undefined
          : (result as MessageV2.WithParts | undefined)?.parts.findLast(
              (p): p is Extract<MessageV2.Part, { type: "text" }> => p.type === "text",
            )?.text
      return { finalText, structured }
    })

    const forkWork = (input: {
      sessionID: SessionID
      parentSessionID: SessionID
      parentActorID?: string
      actorID: string
      agentType: string
      task: string
      description?: string
      background: boolean
      model?: { providerID: ProviderV2.ID; modelID: ModelV2.ID }
      lifecycle: "ephemeral" | "persistent"
      task_id?: string
      gateEligible?: boolean
      format?: MessageV2.OutputFormat
      resumable?: boolean
      instanceRef?: InstanceContext
    }) =>
      Effect.gen(function* () {
        const outcome = yield* Deferred.make<AgentOutcome>()
        const description = input.description ?? input.agentType

        const notify = (
          status: "completed" | "failed" | "cancelled",
          extra: { result?: string; error?: string; reportedStatus?: ReturnStatus; reportedSummary?: string },
        ) =>
          cancelling.has(cancelKey(input.sessionID, input.actorID))
            ? Effect.void
            : input.background
              ? inbox
                  .send({
                    receiverSessionID: input.parentSessionID,
                    receiverActorID: input.parentActorID ?? "main",
                    senderSessionID: input.sessionID,
                    senderActorID: input.actorID,
                    type: "actor_notification",
                    content: renderActorNotification({
                      actorID: input.actorID,
                      description,
                      status,
                      ...extra,
                    }),
                  })
                  .pipe(Effect.ignore)
              : Effect.void

        const actorMode: "peer" | "subagent" = input.parentSessionID === input.sessionID ? "subagent" : "peer"

        const forkAgentInfo = yield* agents.get(input.agentType)
        const canWrite = forkAgentInfo ? !Permission.disabled(["write"], forkAgentInfo.permission).has("write") : true

        const work = Effect.gen(function* () {
          let finalText: string | undefined
          let structured: unknown | undefined

          const turn = yield* runTurn(
            input.sessionID,
            input.actorID,
            runAgentLoop({
              ...input,
              source: "spawn",
            }),
            input.resumable
              ? { turnCount: 0, timestamp: Date.now() }
              : undefined,
          )
          finalText = turn.finalText
          structured = turn.structured

          return { finalText, structured }
        }).pipe(
          Effect.provideService(ActorRegistry.Service, actorReg),
          Effect.matchCauseEffect({
            onSuccess: ({ finalText, structured }) =>
              Effect.gen(function* () {
                const parsed = parseReturnHeader(finalText)
                const deliveryText =
                  structured !== undefined ? JSON.stringify(structured) : (finalText ?? "(no output)")
                yield* notify("completed", {
                  result: deliveryText,
                  ...(parsed.status ? { reportedStatus: parsed.status } : {}),
                  ...(parsed.summary ? { reportedSummary: parsed.summary } : {}),
                })
                yield* Deferred.succeed(outcome, {
                  status: "success" as const,
                  ...(finalText !== undefined ? { finalText } : {}),
                  ...(structured !== undefined ? { structured } : {}),
                  ...(parsed.status ? { reportedStatus: parsed.status } : {}),
                  ...(parsed.summary ? { reportedSummary: parsed.summary } : {}),
                })

                yield* Effect.sync(() => forkContexts.delete(input.actorID))
              }),
            onFailure: (cause) =>
              Effect.gen(function* () {
                const cancelled = Cause.hasInterruptsOnly(cause)
                const error = Cause.pretty(cause)
                yield* notify(cancelled ? "cancelled" : "failed", cancelled ? {} : { error })
                yield* Deferred.succeed(
                  outcome,
                  cancelled
                    ? { status: "cancelled" as const }
                    : { status: "failure" as const, error },
                )
                yield* Effect.sync(() => forkContexts.delete(input.actorID))
              }),
          }),
        )
        const boundWork = input.instanceRef
          ? work.pipe(Effect.provideService(InstanceRef, input.instanceRef))
          : work
        const fiber = yield* boundWork.pipe(Effect.forkIn(scope))
        return { fiber, outcome }
      })

    const spawnPeer = Effect.fn("Actor.spawnPeer")(function* (input: SpawnInput) {
      const child = yield* session.create({
        parentID: input.sessionID,
        title: `${input.agentType}: ${input.task.slice(0, 40)}`,
      })
      const spawnConfig: SpawnConfig | undefined = input.resumable
        ? {
            mode: input.mode,
            sessionID: input.sessionID,
            parentSessionID: input.parentSessionID,
            agentType: input.agentType,
            task: input.task,
            description: input.description,
            context: input.context,
            tools: input.tools,
            model: input.model,
            background: input.background,
            parentActorID: input.parentActorID,
            task_id: input.task_id,
            lifecycle: input.lifecycle,
            format: input.format,
          }
        : undefined
      yield* actorReg.register({
        sessionID: child.id,
        actorID: child.id,
        mode: "peer",
        parentActorID: input.parentActorID,
        agent: input.agentType,
        description: input.description ?? input.agentType,
        contextMode: input.context,
        contextWatermark: undefined,
        background: input.background,
        lifecycle: input.lifecycle ?? "persistent",
        tools: input.tools,
        resumable: input.resumable,
        spawnConfig,
      })
      if (input.forkContext) {
        forkContexts.set(child.id, input.forkContext)
      }
      const { fiber, outcome } = yield* forkWork({
        sessionID: child.id,
        parentSessionID: input.sessionID,
        parentActorID: input.parentActorID,
        actorID: child.id,
        agentType: input.agentType,
        task: input.task,
        description: input.description,
        background: input.background,
        model: input.model,
        lifecycle: input.lifecycle ?? "persistent",
        task_id: input.task_id,
        format: input.format,
      })
      if (!input.background) yield* Fiber.join(fiber).pipe(Effect.ignore)
      return { actorID: child.id, sessionID: child.id, outcome }
    })

    const spawnSubagent = Effect.fn("Actor.spawnSubagent")(function* (input: SpawnInput) {
      const actorID = yield* actorReg.allocateActorID(input.sessionID, input.agentType)

      const spawnConfig: SpawnConfig | undefined = input.resumable
        ? {
            mode: input.mode,
            sessionID: input.sessionID,
            parentSessionID: input.parentSessionID,
            agentType: input.agentType,
            task: input.task,
            description: input.description,
            context: input.context,
            tools: input.tools,
            model: input.model,
            background: input.background,
            parentActorID: input.parentActorID,
            task_id: input.task_id,
            lifecycle: input.lifecycle,
            format: input.format,
          }
        : undefined

      yield* actorReg.register({
        sessionID: input.sessionID,
        actorID,
        mode: "subagent",
        parentActorID: input.parentActorID,
        agent: input.agentType,
        description: input.description ?? input.agentType,
        contextMode: input.context,
        contextWatermark: undefined,
        background: input.background,
        lifecycle: input.lifecycle ?? "ephemeral",
        tools: input.tools,
        resumable: input.resumable,
        spawnConfig,
      })

      if (input.onActorID) yield* Effect.sync(() => input.onActorID!(actorID)).pipe(Effect.ignore)

      if (input.forkContext) {
        forkContexts.set(actorID, input.forkContext)
      }

      const agentInfo = yield* agents.get(input.agentType)
      const gateEligible = false
      const taskWithFormat = gateEligible ? input.task + RETURN_FORMAT_INSTRUCTION : input.task

      const { fiber, outcome } = yield* forkWork({
        sessionID: input.sessionID,
        parentSessionID: input.parentSessionID ?? input.sessionID,
        parentActorID: input.parentActorID,
        actorID,
        agentType: input.agentType,
        task: taskWithFormat,
        description: input.description,
        background: input.background,
        model: input.model,
        lifecycle: input.lifecycle ?? "ephemeral",
        task_id: input.task_id,
        gateEligible,
        format: input.format,
      })
      if (input.onReady) yield* Effect.ignore(input.onReady({ actorID, sessionID: input.sessionID }))
      if (!input.background) yield* Fiber.join(fiber).pipe(Effect.ignore)
      return { actorID, sessionID: input.sessionID, outcome }
    })

    const spawn = Effect.fn("Actor.spawn")(function* (input: SpawnInput) {
      if (input.mode === "peer") return yield* spawnPeer(input)
      return yield* spawnSubagent(input)
    })

    const notifyTerminal = (
      sessionID: SessionID,
      actorID: string,
      actor: Actor | undefined,
      status: "cancelled",
    ) =>
      Effect.gen(function* () {
        if (!actor) return
        if (!actor.background) return
        if (actor.mode !== "peer" && actor.mode !== "subagent") return
        const parentSessionID =
          actor.mode === "peer" ? (yield* session.get(sessionID)).parentID : sessionID
        if (!parentSessionID) return
        yield* inbox
          .send({
            receiverSessionID: SessionIDModule.make(parentSessionID),
            receiverActorID: actor.parentActorID ?? "main",
            senderSessionID: sessionID,
            senderActorID: actorID,
            type: "actor_notification",
            content: renderActorNotification({
              actorID,
              description: actor.description,
              status,
            }),
          })
          .pipe(Effect.ignore)
      }).pipe(Effect.catchCause((cause) => Effect.logError(`terminal notify failed: ${cause}`)))

    const cancel: (sessionID: SessionID, actorID: string, mode: "graceful" | "forced") => Effect.Effect<void, never, never> =
      Effect.fn("Actor.cancel")(function* (sessionID: SessionID, actorID: string, mode: "graceful" | "forced") {
        const children = yield* actorReg.listByParent(sessionID, actorID)
        yield* Effect.forEach(children, (c) => cancel(sessionID, c.actorID, mode), {
          concurrency: "unbounded",
          discard: true,
        })
        yield* Effect.sync(() => cancelling.add(cancelKey(sessionID, actorID)))
        const actor = yield* actorReg.get(sessionID, actorID)
        yield* state.cancel(sessionID)
        yield* actorReg
          .updateStatus(sessionID, actorID, { status: "idle", lastOutcome: "cancelled" })
          .pipe(Effect.ignore)
        yield* notifyTerminal(sessionID, actorID, actor, "cancelled")
        yield* Effect.sync(() => forkContexts.delete(actorID))
      })

    const getForkContext = Effect.fn("Actor.getForkContext")(function* (actorID: string) {
      return forkContexts.get(actorID)
    })

    const notified = new Set<string>()

    const notifyStalled = (actor: Actor, stalledForMs: number) =>
      Effect.gen(function* () {
        if (!actor.background) return
        if (actor.mode !== "peer" && actor.mode !== "subagent") return
        const parentSessionID =
          actor.mode === "peer" ? (yield* session.get(SessionIDModule.make(actor.sessionID))).parentID : actor.sessionID
        if (!parentSessionID) return
        yield* inbox
          .send({
            receiverSessionID: SessionIDModule.make(parentSessionID),
            receiverActorID: actor.parentActorID ?? "main",
            senderSessionID: SessionIDModule.make(actor.sessionID),
            senderActorID: actor.actorID,
            type: "actor_notification",
            content: renderActorNotification({
              actorID: actor.actorID,
              description: actor.description,
              status: "stalled",
              stalledForMs,
            }),
          })
          .pipe(Effect.ignore)
        yield* bus
          .publish(ActorEvents.ActorStalled, {
            sessionID: actor.sessionID,
            actorID: actor.actorID,
            description: actor.description,
            lastActivityTime: actor.lastActivityTime ?? actor.time.created,
            stalledDuration: stalledForMs,
          })
          .pipe(Effect.ignore)
      }).pipe(Effect.catchCause((cause) => Effect.logError(`stall notify failed: ${cause}`)))

    const scanStalled = Effect.gen(function* () {
      const now = Date.now()
      const active = yield* actorReg.listActive().pipe(Effect.orElseSucceed(() => [] as Actor[]))
      const seen = new Set<string>()
      for (const actor of active) {
        const key = `${actor.sessionID}:${actor.actorID}`
        seen.add(key)
        const live = deriveLiveness(actor, now)
        if (live === "stalled") {
          if (notified.has(key)) continue
          notified.add(key)
          yield* notifyStalled(actor, now - (actor.lastActivityTime ?? actor.time.created))
          continue
        }
        notified.delete(key)
      }
      for (const key of notified) if (!seen.has(key)) notified.delete(key)
    }).pipe(Effect.catchCause((cause) => Effect.logError(`stall watchdog scan failed: ${cause}`)))

    yield* scanStalled.pipe(
      Effect.repeat(Schedule.spaced(WATCHDOG_SCAN_INTERVAL_MS)),
      Effect.ignore,
      Effect.forkIn(scope),
    )

    const impl = Service.of({ spawn, cancel, getForkContext, scanStalledOnce: () => scanStalled })
    const prevSpawnRef = spawnRef.current
    spawnRef.current = impl
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        if (spawnRef.current === impl) spawnRef.current = prevSpawnRef
      }),
    )
    return impl
  }),
)

class AssistantSettledError extends Error {
  constructor(
    message: string,
    readonly failure: FailureInfo,
  ) {
    super(message)
  }
}

export const appLayer = Layer.suspend(() =>
  layer.pipe(
    Layer.provide(Session.defaultLayer),
    Layer.provide(ActorRegistry.defaultLayer),
    Layer.provide(Agent.defaultLayer),
    Layer.provide(SessionRunState.defaultLayer),
    Layer.provide(Inbox.defaultLayer),
    Layer.provide(Bus.layer),
  ),
)

export const defaultLayer = appLayer.pipe(Layer.provide(SessionPrompt.defaultLayer))

export * as Actor from "./spawn"
