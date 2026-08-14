import * as Tool from "./tool"
import { RecoverableError } from "./recoverable"
import DESCRIPTION from "./actor.txt"
import SHELL_DESCRIPTION from "./actor.shell.txt"
import { tokenize } from "./shell-tokenize"
import z from "zod"
import { Session } from "../session"
import { SessionID, MessageID, PartID } from "../session/schema"
import { MessageV2 } from "../session/message-v2"
import { Agent } from "../agent/agent"
import { Provider } from "../provider/provider"
import type { ProviderV2 } from "@opencode-ai/core/provider"
import type { ModelV2 } from "@opencode-ai/core/model"
import type { SessionPrompt } from "../session/prompt"
import { Config } from "../config/config"
import { ActorRegistry } from "@/actor/registry"
import { ActorWaiter } from "@/actor/waiter"
import { spawnRef } from "@/actor/spawn-ref"
import { inboxServiceRef } from "@/inbox/inbox-ref"
import { Effect, Deferred } from "effect"

export interface ActorPromptOps {
  cancel(sessionID: SessionID): void
  resolvePromptParts(template: string): Effect.Effect<SessionPrompt.PromptInput["parts"]>
  prompt(input: SessionPrompt.PromptInput): Effect.Effect<MessageV2.WithParts>
}

const id = "actor"

const MODEL_PARAM_DESCRIPTION =
  "(optional) Model for this subagent: a model group name (e.g. ultra/standard/lite) or a literal provider/model (e.g. mimo-v2.5-pro). Overrides the agent's configured model; defaults to the agent's model, else the parent's. If no model_groups are configured, the tier names resolve to the default model. To discover valid provider/model values (e.g. a vision-capable model for image tasks), run `actor models` (or `actor models --vision`)."

const KNOWN_ACTOR_VERBS = ["run", "spawn", "status", "wait", "cancel", "send", "models", "resume", "list-resumable"]

function levenshteinActor(a: string, b: string): number {
  const m = a.length, n = b.length
  if (m === 0) return n
  if (n === 0) return m
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0))
  for (let i = 0; i <= m; i++) dp[i][0] = i
  for (let j = 0; j <= n; j++) dp[0][j] = j
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost)
    }
  }
  return dp[m][n]
}

function suggestActorVerb(input: string): string | undefined {
  const candidates = KNOWN_ACTOR_VERBS.map((v) => ({ v, d: levenshteinActor(input, v) })).filter((c) => c.d <= 2)
  if (candidates.length !== 1) return undefined
  return candidates[0].v
}

type ActorShellArgs =
  | { operation: { action: "run"; subagent_type: string; description: string; prompt: string; model?: string; task_id?: string; actor_id?: string; timeout_ms?: number; command?: string; context?: "none" | "state" | "full"; output_schema?: Record<string, unknown> } }
  | { operation: { action: "spawn"; subagent_type: string; description: string; prompt: string; model?: string; task_id?: string; actor_id?: string; command?: string; context?: "none" | "state" | "full"; output_schema?: Record<string, unknown> } }
  | { operation: { action: "status"; actor_id: string } }
  | { operation: { action: "wait"; actor_id: string; timeout_ms?: number } }
  | { operation: { action: "cancel"; actor_id: string } }
  | { operation: { action: "send"; to_actor_id: string; content: string; to_session_id?: string; type?: string } }
  | { operation: { action: "models"; vision?: boolean; limit?: number } }
  | { operation: { action: "resume"; actor_id: string } }
  | { operation: { action: "list-resumable" } }

function actorArityError(verb: string, expected: string, args: string[], line: number) {
  return Effect.fail({
    kind: "arity",
    line,
    detail: `actor: ${verb}: arity mismatch\n  got:      actor ${verb} ${args.join(" ")}\n  expected: actor ${verb} ${expected}`,
  })
}

function extractNamedFlags(
  args: string[],
  names: string[],
  line: number,
): Effect.Effect<{ flags: Record<string, string>; rest: string[] }, { kind: "flag"; line: number; detail: string }> {
  const rest: string[] = []
  const flags: Record<string, string> = {}
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    const bare = names.find((n) => a === `--${n}`)
    if (bare) {
      const next = args[i + 1]
      if (next === undefined)
        return Effect.fail({ kind: "flag" as const, line, detail: `actor: --${bare} requires a value` })
      flags[bare] = next
      i++
      continue
    }
    const eq = names.find((n) => a.startsWith(`--${n}=`))
    if (eq) {
      const v = a.slice(`--${eq}=`.length)
      if (v === "") return Effect.fail({ kind: "flag" as const, line, detail: `actor: --${eq} requires a value` })
      flags[eq] = v
      continue
    }
    rest.push(a)
  }
  return Effect.succeed({ flags, rest })
}

const mapActorVerb = Effect.fn("mapActorVerb")(function* (verb: string | undefined, args: string[], line: number) {
  switch (verb) {
    case "run": {
      const { flags, rest } = yield* extractNamedFlags(
        args,
        ["model", "task", "actor", "timeout", "command", "context", "output-schema"],
        line,
      )
      if (rest.length !== 3) return yield* actorArityError("run", '<subagent_type> "<description>" "<prompt>" [--model <ref>] [--task <TID>] [--actor <id>] [--timeout <ms>] [--command <cmd>] [--context none|state|full] [--output-schema <json>]', rest, line)
      return {
        operation: {
          action: "run" as const,
          subagent_type: rest[0],
          description: rest[1],
          prompt: rest[2],
          ...(flags.model ? { model: flags.model } : {}),
          ...(flags.task ? { task_id: flags.task } : {}),
          ...(flags.actor ? { actor_id: flags.actor } : {}),
          ...(flags.timeout ? { timeout_ms: Number(flags.timeout) } : {}),
          ...(flags.command ? { command: flags.command } : {}),
          ...(flags.context ? { context: flags.context } : {}),
          ...(flags["output-schema"] ? { output_schema: JSON.parse(flags["output-schema"]) } : {}),
        },
      } as ActorShellArgs
    }
    case "spawn": {
      const { flags, rest } = yield* extractNamedFlags(
        args,
        ["model", "task", "actor", "command", "context", "output-schema"],
        line,
      )
      if (rest.length !== 3) return yield* actorArityError("spawn", '<subagent_type> "<description>" "<prompt>" [--model <ref>] [--task <TID>] [--actor <id>] [--command <cmd>] [--context none|state|full] [--output-schema <json>]', rest, line)
      return {
        operation: {
          action: "spawn" as const,
          subagent_type: rest[0],
          description: rest[1],
          prompt: rest[2],
          ...(flags.model ? { model: flags.model } : {}),
          ...(flags.task ? { task_id: flags.task } : {}),
          ...(flags.actor ? { actor_id: flags.actor } : {}),
          ...(flags.command ? { command: flags.command } : {}),
          ...(flags.context ? { context: flags.context } : {}),
          ...(flags["output-schema"] ? { output_schema: JSON.parse(flags["output-schema"]) } : {}),
        },
      } as ActorShellArgs
    }
    case "status":
      if (args.length !== 1) return yield* actorArityError("status", "<actor_id>", args, line)
      return { operation: { action: "status" as const, actor_id: args[0] } } as ActorShellArgs
    case "wait": {
      const { flags, rest } = yield* extractNamedFlags(args, ["timeout"], line)
      if (rest.length !== 1) return yield* actorArityError("wait", "<actor_id> [--timeout <ms>]", rest, line)
      return {
        operation: {
          action: "wait" as const,
          actor_id: rest[0],
          ...(flags.timeout ? { timeout_ms: Number(flags.timeout) } : {}),
        },
      } as ActorShellArgs
    }
    case "cancel":
      if (args.length !== 1) return yield* actorArityError("cancel", "<actor_id>", args, line)
      return { operation: { action: "cancel" as const, actor_id: args[0] } } as ActorShellArgs
    case "send": {
      const { flags, rest } = yield* extractNamedFlags(args, ["session", "type"], line)
      if (rest.length !== 2)
        return yield* actorArityError("send", '<to_actor_id> "<content>" [--session <id>] [--type <t>]', rest, line)
      if (rest[1].trim() === "")
        return yield* Effect.fail({
          kind: "flag" as const,
          line,
          detail: "actor: send: content must not be empty",
        })
      return {
        operation: {
          action: "send" as const,
          to_actor_id: rest[0],
          content: rest[1],
          ...(flags.session ? { to_session_id: flags.session } : {}),
          ...(flags.type ? { type: flags.type } : {}),
        },
      } as ActorShellArgs
    }
    case "models": {
      const vision = args.includes("--vision")
      const withoutVision = args.filter((a) => a !== "--vision")
      const { flags, rest } = yield* extractNamedFlags(withoutVision, ["limit"], line)
      if (rest.length !== 0)
        return yield* actorArityError("models", "[--vision] [--limit <n>]", rest, line)
      return {
        operation: {
          action: "models" as const,
          ...(vision ? { vision: true } : {}),
          ...(Number.isInteger(Number(flags.limit)) && Number(flags.limit) > 0 ? { limit: Number(flags.limit) } : {}),
        },
      } as ActorShellArgs
    }
    case "resume":
      if (args.length !== 1) return yield* actorArityError("resume", "<actor_id>", args, line)
      return { operation: { action: "resume" as const, actor_id: args[0] } } as ActorShellArgs
    case "list-resumable":
      if (args.length !== 0) return yield* actorArityError("list-resumable", "", args, line)
      return { operation: { action: "list-resumable" as const } } as ActorShellArgs
    default: {
      const suggestion = suggestActorVerb(verb ?? "")
      const detail =
        `actor: unknown verb "${verb ?? ""}"\n` +
        `  available verbs: ${KNOWN_ACTOR_VERBS.join(", ")}` +
        (suggestion ? `\n  did you mean: ${suggestion}?` : "")
      return yield* Effect.fail({ kind: "unknown-verb", line, detail })
    }
  }
})

export function parseActorScript(
  script: string,
): Effect.Effect<ActorShellArgs[], unknown> {
  return Effect.gen(function* () {
    const argvList = yield* tokenize(script)
    const out: ActorShellArgs[] = []
    for (const argv of argvList) {
      const [head, verb, ...rest] = argv.tokens
      if (head !== "actor") {
        return yield* Effect.fail({
          kind: "unknown-verb",
          line: argv.line,
          detail: `actor: every command must start with 'actor' (got '${head ?? ""}')`,
        })
      }
      const parsed = yield* mapActorVerb(verb, rest, argv.line)
      out.push(parsed)
    }
    return out
  })
}

function inferAction(o: Record<string, unknown>): "run" | "spawn" {
  if (o.action === "spawn" || o.action === "run") return o.action
  if (o.background === true || o.async === true) return "spawn"
  return "run"
}

export function recoverActorArgs(rawArgs: unknown): ActorShellArgs | undefined {
  if (rawArgs == null || typeof rawArgs !== "object") return undefined
  let obj = rawArgs as Record<string, unknown>
  if (typeof obj.operation === "string") {
    try {
      const inner = JSON.parse(obj.operation)
      if (inner && typeof inner === "object" && !Array.isArray(inner)) obj = { operation: inner }
    } catch {}
  }
  if (obj.operation && typeof obj.operation === "object" && !Array.isArray(obj.operation))
    return { operation: obj.operation } as ActorShellArgs
  const subagent_type = obj.subagent_type
  const description = obj.description
  const prompt = obj.prompt
  if (typeof subagent_type === "string" && typeof description === "string" && typeof prompt === "string") {
    const op: Record<string, unknown> = { action: inferAction(obj), subagent_type, description, prompt }
    if (typeof obj.model === "string") op.model = obj.model
    if (typeof obj.task_id === "string") op.task_id = obj.task_id
    if (typeof obj.actor_id === "string") op.actor_id = obj.actor_id
    return { operation: op } as ActorShellArgs
  }
  return undefined
}

export const ActorTool = Tool.define(
  id,
  Effect.gen(function* () {
    const agent = yield* Agent.Service
    const config = yield* Config.Service
    const provider = yield* Provider.Service
    const sessions = yield* Session.Service
    const actorRegistry = yield* ActorRegistry.Service
    const waiter = yield* ActorWaiter.Service

    const requireActor = () => {
      const a = spawnRef.current
      if (!a) {
        return Effect.fail(
          new Error(
            "Actor service unavailable — Actor.appLayer must be running for the actor tool to spawn or cancel actors",
          ),
        )
      }
      return Effect.succeed(a)
    }

    return Effect.fn("ActorTool.init")(function* () {
      const allAgents = yield* agent.list()
      const spawnable = allAgents.filter((a) => a.mode === "subagent" && !a.hidden)
      const spawnableNames = spawnable.map((a) => a.name)
      if (spawnableNames.length === 0) {
        return yield* Effect.die(new Error("No spawnable subagent types"))
      }
      const subagentTypeEnum = z.enum(spawnableNames as [string, ...string[]])

      const actorIdRequiredField = z
        .string()
        .min(1)
        .describe(
          "Actor session id to operate on. Distinct from the user-task IDs (T1, T2, ...) used by the `task` tool.",
        )

      const timeoutField = z
        .number()
        .int()
        .positive()
        .optional()
        .describe("(optional) Milliseconds to wait before returning { status: 'timeout' }. Default 600000 (10 min).")

      const runSchema = z.strictObject({
        action: z
          .literal("run")
          .describe(
            "RARE EXCEPTION — launches a subagent and BLOCKS the whole conversation until it completes; the result is returned inline. Use it only when you cannot make your very next decision without the result in THIS turn and the work is a tiny, fast lookup. For ordinary analysis, review, or implementation work use `spawn` instead.",
          ),
        description: z.string().min(1).describe("A short (3-5 words) description of the task."),
        prompt: z.string().min(1).describe("The task for the agent to perform."),
        subagent_type: subagentTypeEnum.describe("The type of specialized agent to use for this task."),
        model: z
          .string()
          .min(1)
          .optional()
          .describe(MODEL_PARAM_DESCRIPTION),
        actor_id: z
          .string()
          .min(1)
          .optional()
          .describe(
            "(optional) If set, resume the specified prior actor session instead of creating a new one. Distinct from the user-task IDs (T1, T2, ...) used by the `task` tool.",
          ),
        timeout_ms: timeoutField,
        command: z.string().min(1).optional().describe("(optional) The command that triggered this task."),
        context: z
          .enum(["none", "state", "full"])
          .optional()
          .describe(
            "(optional) Context inheritance. 'none' (default): child sees only prompt. 'full': child sees parent conversation (prefix cache sharing). 'state': child gets checkpoint summary.",
          ),
        task_id: z
          .string()
          .min(1)
          .optional()
          .describe(
            "(optional) If this subagent is doing work for a specific task in the `task` tool, pass that task's ID (e.g. T4, T2.1) here.",
          ),
        output_schema: z
          .record(z.string(), z.any())
          .optional()
          .describe(
            "(optional) A JSON Schema. When set, the subagent is forced to return a single structured object matching this schema (via the StructuredOutput tool) instead of free text; the validated object is returned in <actor_result>.",
          ),
        resumable: z
          .boolean()
          .optional()
          .describe(
            "(optional) If true, the actor can be resumed after the process is killed or restarted. The actor's full configuration is persisted in the database.",
          ),
      })

      const spawnSchema = z.strictObject({
        action: z
          .literal("spawn")
          .describe(
            "THE DEFAULT — launches a subagent in the BACKGROUND and returns its actor_id immediately, so subagents run in PARALLEL and you keep responding to the user. The result arrives as a notification, or collect it with `wait`/`status`.",
          ),
        description: z.string().min(1).describe("A short (3-5 words) description of the task."),
        prompt: z.string().min(1).describe("The task for the agent to perform."),
        subagent_type: subagentTypeEnum.describe("The type of specialized agent to use for this task."),
        model: z
          .string()
          .min(1)
          .optional()
          .describe(MODEL_PARAM_DESCRIPTION),
        actor_id: z
          .string()
          .min(1)
          .optional()
          .describe(
            "(optional) If set, resume the specified prior actor session instead of creating a new one.",
          ),
        command: z.string().min(1).optional().describe("(optional) The command that triggered this task."),
        context: z
          .enum(["none", "state", "full"])
          .optional()
          .describe("(optional) Context inheritance. Default 'none'."),
        task_id: z
          .string()
          .min(1)
          .optional()
          .describe(
            "(optional) If this subagent is doing work for a specific task in the `task` tool, pass that task's ID (e.g. T4, T2.1) here.",
          ),
        output_schema: z
          .record(z.string(), z.any())
          .optional()
          .describe(
            "(optional) A JSON Schema. When set, the subagent is forced to return a single structured object matching this schema (via the StructuredOutput tool) instead of free text.",
          ),
        resumable: z
          .boolean()
          .optional()
          .describe(
            "(optional) If true, the actor can be resumed after the process is killed or restarted. The actor's full configuration is persisted in the database.",
          ),
      })

      const statusSchema = z.strictObject({
        action: z.literal("status"),
        actor_id: actorIdRequiredField,
      })

      const waitSchema = z.strictObject({
        action: z.literal("wait"),
        actor_id: actorIdRequiredField,
        timeout_ms: timeoutField,
      })

      const cancelSchema = z.strictObject({
        action: z.literal("cancel"),
        actor_id: actorIdRequiredField,
      })

      const sendSchema = z.strictObject({
        action: z.literal("send"),
        to_session_id: z
          .string()
          .min(1)
          .optional()
          .describe(
            "(optional) Target session ID. Defaults to the current session — useful for sending to subagents in this session.",
          ),
        to_actor_id: z
          .string()
          .min(1)
          .describe(
            "Target actor ID. Use 'main' to send to a session's main agent, or a subagent ID like 'explore-1'.",
          ),
        content: z.string().min(1).describe("Message content (plain text). Wrapped in <inbox> for the receiver."),
        type: z
          .string()
          .optional()
          .describe(
            "(optional) Message type. Default 'text' is wrapped in <inbox>...</inbox>. 'actor_notification' is passed through verbatim (sender pre-renders).",
          ),
      })

      const modelsSchema = z.strictObject({
        action: z.literal("models"),
        vision: z.boolean().optional().describe("(optional) If true, list only vision-capable models (models that accept image input)."),
        limit: z.number().int().positive().optional().describe("(optional) Max number of models to return. Default 50."),
      })

      const resumeSchema = z.strictObject({
        action: z
          .literal("resume")
          .describe(
            "Resumes a previously killed actor that was spawned with resumable=true. The actor will be re-created with its original configuration and run from the beginning (the system does not have fine-grained checkpoint replay, so it restarts the task).",
          ),
        actor_id: actorIdRequiredField,
      })

      const listResumableSchema = z.strictObject({
        action: z
          .literal("list-resumable")
          .describe(
            "Lists all actors that were spawned with resumable=true and are in a dead/stale state (status=running but their originating process is gone). These actors can be resumed with 'actor resume <actor_id>'.",
          ),
      })

      const parameters = z.strictObject({
        operation: z
          .discriminatedUnion("action", [
            spawnSchema,
            runSchema,
            statusSchema,
            waitSchema,
            cancelSchema,
            sendSchema,
            modelsSchema,
            resumeSchema,
            listResumableSchema,
          ])
          .meta({ type: "object" }),
      })

      const run = Effect.fn("ActorTool.execute")(function* (input: z.infer<typeof parameters>, ctx: Tool.Context) {
        const op = input.operation
        const cfg = yield* config.get()

        const unknownResponse = (label: string, actorID: string) => {
          const snapshot = { status: "unknown" as const, actor_id: actorID }
          return {
            title: `Actor ${label}: unknown`,
            output: JSON.stringify(snapshot),
            metadata: { actor_id: actorID, status: "unknown" } as Record<string, any>,
          }
        }

        const findActor = Effect.fn("ActorTool.findActor")(function* (actorID: string) {
          const sub = yield* actorRegistry.get(ctx.sessionID, actorID)
          if (sub) return { entry: sub, sessionID: ctx.sessionID }
          const sid = SessionID.make(actorID)
          const peer = yield* actorRegistry.get(sid, actorID)
          if (peer) return { entry: peer, sessionID: sid }
          return undefined
        })

        if (op.action === "send") {
          const inboxSvc = inboxServiceRef.current
          if (!inboxSvc) {
            return yield* Effect.fail(
              new Error("Inbox service unavailable — Inbox.layer must be running for the actor tool to send messages"),
            )
          }
          const targetSid = op.to_session_id !== undefined ? SessionID.make(op.to_session_id) : ctx.sessionID
          const sendResult = yield* inboxSvc
            .send({
              receiverSessionID: targetSid,
              receiverActorID: op.to_actor_id,
              senderSessionID: ctx.sessionID,
              senderActorID: ctx.agent ?? "main",
              content: op.content,
              ...(op.type !== undefined ? { type: op.type } : {}),
            })
            .pipe(
              Effect.catchTag("InboxReceiverNotFound", () =>
                Effect.succeed({ inboxID: null as string | null, error: "receiver not found" }),
              ),
            )
          if ("error" in sendResult) {
            return {
              title: `Send failed: receiver not found`,
              output: JSON.stringify(sendResult),
              metadata: {
                receiver_actor_id: op.to_actor_id,
                receiver_session_id: targetSid,
                error: sendResult.error,
              } as Record<string, any>,
            }
          }
          return {
            title: `Sent to ${op.to_actor_id}`,
            output: JSON.stringify({ inboxID: sendResult.inboxID }),
            metadata: {
              inboxID: sendResult.inboxID,
              receiver_actor_id: op.to_actor_id,
              receiver_session_id: targetSid,
            } as Record<string, any>,
          }
        }

        if (op.action === "status") {
          const found = yield* findActor(op.actor_id)
          if (!found) return unknownResponse("status", op.actor_id)
          const entry = found.entry
          const snapshot = {
            status: entry.status,
            actor_id: entry.actorID,
            description: entry.description,
            agent: entry.agent,
            background: entry.background,
            turnCount: entry.turnCount,
            lastTurnTime: entry.lastTurnTime,
            ...(entry.lastError !== undefined ? { error: entry.lastError } : {}),
            time: entry.time,
          }
          return {
            title: `Actor status: ${entry.status}`,
            output: JSON.stringify(snapshot),
            metadata: { actor_id: entry.actorID, status: entry.status } as Record<string, any>,
          }
        }

        if (op.action === "wait") {
          const found = yield* findActor(op.actor_id)
          if (!found) return unknownResponse("wait", op.actor_id)
          const snap = yield* waiter.wait({
            sessionID: found.sessionID,
            actor_id: op.actor_id,
            timeout_ms: op.timeout_ms,
          })
          return {
            title: `Actor wait: ${snap.status}${snap.lastOutcome ? "/" + snap.lastOutcome : ""}`,
            output: JSON.stringify(snap),
            metadata: {
              actor_id: snap.actor_id,
              status: snap.status,
              ...(snap.lastOutcome ? { lastOutcome: snap.lastOutcome } : {}),
            } as Record<string, any>,
          }
        }

        if (op.action === "cancel") {
          const found = yield* findActor(op.actor_id)
          if (!found) return unknownResponse("cancel", op.actor_id)
          const entry = found.entry

          if (entry.status === "idle") {
            const snapshot = {
              status: entry.status,
              actor_id: entry.actorID,
              description: entry.description,
              agent: entry.agent,
              background: entry.background,
            }
            return {
              title: `Actor cancel: ${entry.status}`,
              output: JSON.stringify(snapshot),
              metadata: { actor_id: entry.actorID, status: entry.status } as Record<string, any>,
            }
          }

          const actorForCancel = yield* requireActor()
          yield* actorForCancel.cancel(found.sessionID, entry.actorID, "graceful")

          const snapshot = {
            status: "cancelled" as const,
            actor_id: entry.actorID,
            description: entry.description,
            agent: entry.agent,
            background: entry.background,
          }
          return {
            title: `Actor cancel: cancelled`,
            output: JSON.stringify(snapshot),
            metadata: { actor_id: entry.actorID, status: "cancelled" } as Record<string, any>,
          }
        }

        if (op.action === "models") {
          const providers = yield* provider.list()
          const allModels = Object.values(providers).flatMap((info) => Object.values(info.models))
          const filtered = op.vision ? allModels.filter((m) => m.capabilities.input.image === true) : allModels
          const ordered = [...filtered].sort((a, b) => `${a.providerID}/${a.id}`.localeCompare(`${b.providerID}/${b.id}`))
          const limit = op.limit ?? 50
          const shown = ordered.slice(0, limit)
          const lines = shown.map((m) => `${m.providerID}/${m.id}${m.capabilities.input.image ? " (vision)" : ""}`)
          const header = op.vision ? `Vision-capable models` : `Available models`
          const more = ordered.length > shown.length ? `\n… and ${ordered.length - shown.length} more (raise --limit)` : ""
          const output = shown.length === 0
            ? (op.vision ? "No vision-capable models are configured. Configure a vision model or use an OCR tool." : "No models are configured.")
            : `${header} (${shown.length} of ${ordered.length}):\n${lines.join("\n")}${more}\nPass any of these to actor --model.`
          return { title: header, output, metadata: { count: shown.length, total: ordered.length, vision: !!op.vision } as Record<string, any> }
        }

        if (op.action === "list-resumable") {
          const resumable = yield* actorRegistry.listResumable()
          if (resumable.length === 0) {
            return {
              title: "No resumable actors",
              output: "No actors with resumable=true are in a stale/dead state.",
              metadata: { count: 0 } as Record<string, any>,
            }
          }
          const lines = resumable.map(
            (a) => `  actor_id: ${a.actorID}  agent: ${a.agent}  description: ${a.description}  status: ${a.status}  created: ${new Date(a.time.created).toISOString()}`,
          )
          const output = `Resumable actors (${resumable.length}):\n${lines.join("\n")}\n\nTo resume: actor resume <actor_id>`
          return {
            title: `Resumable actors: ${resumable.length}`,
            output,
            metadata: { count: resumable.length, actors: resumable.map((a) => ({ actor_id: a.actorID, agent: a.agent, description: a.description })) } as Record<string, any>,
          }
        }

        if (op.action === "resume") {
          const found = yield* findActor(op.actor_id)
          if (!found) return unknownResponse("resume", op.actor_id)
          const entry = found.entry

          if (!entry.resumable) {
            return yield* Effect.fail(
              new RecoverableError(
                `Actor ${op.actor_id} was not spawned with resumable=true. Only resumable actors can be resumed.`,
              ),
            )
          }

          if (entry.status === "running" || entry.status === "pending") {
            return {
              title: `Actor resume: already running`,
              output: JSON.stringify({
                status: entry.status,
                actor_id: entry.actorID,
                description: entry.description,
                agent: entry.agent,
              }),
              metadata: { actor_id: entry.actorID, status: entry.status } as Record<string, any>,
            }
          }

          if (!entry.spawnConfig) {
            return yield* Effect.fail(
              new RecoverableError(
                `Actor ${op.actor_id} has no persisted spawn configuration. Cannot resume.`,
              ),
            )
          }

          const spawnConfig = entry.spawnConfig as {
            mode: string
            sessionID: string
            parentSessionID?: string
            agentType: string
            task: string
            description?: string
            context: string
            tools: unknown
            model?: { providerID: string; modelID: string }
            background: boolean
            parentActorID?: string
            task_id?: string
            lifecycle?: string
            format?: unknown
          }

          const actorSvc = yield* requireActor()
          const spawnResult = yield* actorSvc.spawn({
            mode: spawnConfig.mode as "peer" | "subagent",
            sessionID: ctx.sessionID,
            parentSessionID: spawnConfig.parentSessionID as SessionID | undefined,
            agentType: spawnConfig.agentType,
            task: spawnConfig.task,
            description: spawnConfig.description,
            context: spawnConfig.context as "none" | "state" | "full",
            tools: spawnConfig.tools as "INHERIT" | readonly string[],
            model: spawnConfig.model as { providerID: ProviderV2.ID; modelID: ModelV2.ID } | undefined,
            background: spawnConfig.background,
            parentActorID: spawnConfig.parentActorID,
            task_id: spawnConfig.task_id,
            lifecycle: spawnConfig.lifecycle as "ephemeral" | "persistent" | undefined,
            format: spawnConfig.format as MessageV2.OutputFormat | undefined,
            resumable: true,
          })

          const snapshot = {
            status: "running" as const,
            actor_id: spawnResult.actorID,
            description: spawnConfig.description ?? spawnConfig.agentType,
            agent: spawnConfig.agentType,
            original_actor_id: op.actor_id,
          }
          return {
            title: `Actor resume: resumed`,
            output: JSON.stringify(snapshot),
            metadata: { actor_id: spawnResult.actorID, status: "running", original_actor_id: op.actor_id } as Record<string, any>,
          }
        }

        if (!ctx.extra?.bypassAgentCheck) {
          yield* ctx.ask({
            permission: "actor",
            patterns: [op.subagent_type],
            always: ["*"],
            metadata: {
              description: op.description,
              subagent_type: op.subagent_type,
            },
          })
        }

        const next = yield* agent.get(op.subagent_type)
        if (!next) {
          return yield* Effect.fail(
            new RecoverableError(
              `Unknown agent type "${op.subagent_type}". Valid subagent_type values are listed in the actor tool description — pass one of those.`,
            ),
          )
        }

        let prompt = op.prompt
        const background = op.action === "spawn"

        const msg = yield* MessageV2.get({ sessionID: ctx.sessionID, messageID: ctx.messageID })
        if (msg.info.role !== "assistant") return yield* Effect.fail(new Error("Not an assistant message"))

        const model = next.model ?? {
          modelID: msg.info.modelID,
          providerID: msg.info.providerID,
        }

        let effectiveTaskId = op.task_id
        let taskNotice = ""

        const actorSvc = yield* requireActor()
        const spawnResult = yield* actorSvc.spawn({
          mode: "subagent",
          sessionID: ctx.sessionID,
          agentType: next.name,
          description: op.description,
          task: prompt,
          context: op.context ?? "none",
          tools: "INHERIT",
          model,
          background,
          task_id: effectiveTaskId,
          onReady: ({ actorID, sessionID }) =>
            ctx.metadata({
              title: op.description,
              metadata: { sessionId: sessionID, actorId: actorID, model },
            }),
          ...(op.output_schema
            ? { format: { type: "json_schema" as const, schema: op.output_schema, retryCount: 2 } }
            : {}),
          ...(op.resumable !== undefined ? { resumable: op.resumable } : {}),
        })

        if (op.action === "spawn") {
          return {
            title: op.description,
            metadata: { sessionId: spawnResult.sessionID, actorId: spawnResult.actorID, model },
            output:
              (taskNotice ? taskNotice + "\n" : "") +
              `Background sub-session started. actor_id: ${spawnResult.actorID}\nThe result will be delivered as a notification when complete.`,
          }
        }

        function cancelHandler() {
          Effect.runFork(actorSvc.cancel(spawnResult.sessionID, spawnResult.actorID, "graceful"))
        }
        const outcome = yield* Effect.acquireUseRelease(
          Effect.sync(() => {
            ctx.abort.addEventListener("abort", cancelHandler)
          }),
          () =>
            Deferred.await(spawnResult.outcome).pipe(
              Effect.timeout(op.timeout_ms ?? 600_000),
              Effect.catchTag("TimeoutError", () => Effect.succeed({ status: "timeout" as const })),
            ),
          () =>
            Effect.sync(() => {
              ctx.abort.removeEventListener("abort", cancelHandler)
            }),
        )

        if (outcome.status === "failure") {
          return yield* Effect.fail(new Error(`Tool execution failed: ${outcome.error ?? "unknown"}`))
        }

        const resultText =
          outcome.status === "success"
            ? outcome.structured !== undefined
              ? JSON.stringify(outcome.structured)
              : (outcome.finalText ?? "(no output)")
            : outcome.status === "timeout"
              ? "<timeout>task did not complete within timeout</timeout>"
              : "<cancelled>task was cancelled</cancelled>"
        const statusAttr = outcome.status === "success" ? (outcome.reportedStatus ?? "unknown") : outcome.status
        const summaryAttr =
          outcome.status === "success" && outcome.reportedSummary
            ? ` summary="${outcome.reportedSummary.replace(/\s+/g, " ").replace(/"/g, "'").trim()}"`
            : ""
        return {
          title: op.description,
          metadata: { sessionId: spawnResult.sessionID, actorId: spawnResult.actorID, model } as Record<string, any>,
          output: [
            ...(taskNotice ? [taskNotice, ""] : []),
            `actor_id: ${spawnResult.actorID} (for resuming to continue this task if needed)`,
            "",
            `<actor_result status="${statusAttr}"${summaryAttr}>`,
            resultText,
            "</actor_result>",
          ].join("\n"),
        }
      })

      return {
        description: DESCRIPTION,
        parameters,
        execute: (input: z.infer<typeof parameters>, ctx: Tool.Context) => run(input, ctx).pipe(Effect.orDie),
        shell: {
          description: SHELL_DESCRIPTION,
          parse: parseActorScript,
          recover: recoverActorArgs,
        },
      }
    })
  }),
)
