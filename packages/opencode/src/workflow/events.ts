import { BusEvent } from "@/bus/bus-event"
import { SessionID } from "@/session/schema"
import z from "zod"

export const WorkflowPhase = BusEvent.define(
  "workflow.phase",
  z.object({ sessionID: z.string(), runID: z.string(), title: z.string() }),
)

export const WorkflowLog = BusEvent.define(
  "workflow.log",
  z.object({ sessionID: z.string(), runID: z.string(), message: z.string() }),
)

export const WorkflowStarted = BusEvent.define(
  "workflow.started",
  z.object({ sessionID: z.string(), runID: z.string(), name: z.string() }),
)

export const WorkflowFinished = BusEvent.define(
  "workflow.finished",
  z.object({
    sessionID: z.string(),
    runID: z.string(),
    status: z.enum(["completed", "failed", "cancelled"]),
    error: z.string().optional(),
  }),
)

export const WorkflowAgentFailed = BusEvent.define(
  "workflow.agent_failed",
  z.object({
    sessionID: z.string(),
    runID: z.string(),
    actorID: z.string().optional(),
    agentType: z.string(),
    label: z.string().optional(),
    phase: z.string().optional(),
    reason: z.enum(["over-cap", "spawn-reject", "timeout", "actor-error", "no-deliverable"]),
    errorMessage: z.string().optional(),
  }),
)

export const WorkflowChildFailed = BusEvent.define(
  "workflow.child_failed",
  z.object({
    sessionID: z.string(),
    runID: z.string(),
    childRunID: z.string(),
    name: z.string(),
    status: z.enum(["failed", "cancelled"]),
    error: z.string().optional(),
  }),
)
