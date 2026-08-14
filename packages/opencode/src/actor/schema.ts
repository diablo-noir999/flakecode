import z from "zod"

export const ActorStatus = z.enum(["pending", "running", "idle"])
export type ActorStatus = z.infer<typeof ActorStatus>

export const ActorOutcome = z.enum(["success", "failure", "cancelled"])
export type ActorOutcome = z.infer<typeof ActorOutcome>

export const Lifecycle = z.enum(["ephemeral", "persistent"])
export type Lifecycle = z.infer<typeof Lifecycle>

export const ContextMode = z.enum(["none", "state", "full"])
export type ContextMode = z.infer<typeof ContextMode>

export const SpawnMode = z.enum(["peer", "subagent", "main"])
export type SpawnMode = z.infer<typeof SpawnMode>

export const ToolWhitelist = z.union([z.array(z.string()).readonly(), z.literal("INHERIT")])
export type ToolWhitelist = z.infer<typeof ToolWhitelist>

export const Actor = z
  .object({
    sessionID: z.string(),
    actorID: z.string(),
    mode: SpawnMode,
    parentActorID: z.string().optional(),
    status: ActorStatus,
    lastOutcome: ActorOutcome.optional(),
    lifecycle: Lifecycle,
    agent: z.string(),
    description: z.string(),
    contextMode: ContextMode,
    contextWatermark: z.string().optional(),
    background: z.boolean(),
    tools: ToolWhitelist.optional(),
    lastTurnTime: z.number(),
    turnCount: z.number(),
    lastActivityTime: z.number().optional(),
    lastError: z.string().optional(),
    resumable: z.boolean().optional(),
    spawnConfig: z.record(z.string(), z.any()).optional(),
    checkpoint: z.record(z.string(), z.any()).optional(),
    originalActorID: z.string().optional(),
    time: z.object({
      created: z.number(),
      updated: z.number(),
      completed: z.number().optional(),
    }),
  })
  .meta({ ref: "Actor" })
export type Actor = z.infer<typeof Actor>

export const SpawnConfig = z.object({
  mode: SpawnMode,
  sessionID: z.string(),
  parentSessionID: z.string().optional(),
  agentType: z.string(),
  task: z.string(),
  description: z.string().optional(),
  context: ContextMode,
  tools: ToolWhitelist,
  model: z
    .object({
      providerID: z.string(),
      modelID: z.string(),
    })
    .optional(),
  background: z.boolean(),
  parentActorID: z.string().optional(),
  task_id: z.string().optional(),
  lifecycle: Lifecycle.optional(),
  format: z.any().optional(),
})
export type SpawnConfig = z.infer<typeof SpawnConfig>

export const Liveness = z.enum(["progressing", "stalled", "success", "failure", "cancelled", "idle"])
export type Liveness = z.infer<typeof Liveness>

export const DEFAULT_LIVENESS_STALL_MS = 6 * 60_000
export const DEFAULT_LIVENESS_ABANDON_MS = 10 * 60_000
export const ACTIVITY_COALESCE_MS = 5_000

export function deriveLiveness(
  actor: Pick<Actor, "status" | "lastOutcome" | "lastActivityTime" | "time">,
  now: number = Date.now(),
  stallMs: number = DEFAULT_LIVENESS_STALL_MS,
  abandonMs: number = DEFAULT_LIVENESS_ABANDON_MS,
): Liveness {
  if (actor.status === "running" || actor.status === "pending") {
    const since = actor.lastActivityTime ?? actor.time.created
    if (now - since > abandonMs) return "idle"
    return now - since <= stallMs ? "progressing" : "stalled"
  }
  if (actor.lastOutcome === "success") return "success"
  if (actor.lastOutcome === "failure") return "failure"
  if (actor.lastOutcome === "cancelled") return "cancelled"
  return "idle"
}
