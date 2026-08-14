import { BusEvent } from "@/bus/bus-event"
import { SessionID } from "@/session/schema"
import z from "zod"
import { Task, TaskEventKind } from "./schema"

export const Created = BusEvent.define(
  "task.created",
  z.object({
    sessionID: z.string(),
    task: Task,
  }),
)

export const UpdatedKind = TaskEventKind.exclude(["created"])
export type UpdatedKind = z.infer<typeof UpdatedKind>

export const Updated = BusEvent.define(
  "task.updated",
  z.object({
    sessionID: z.string(),
    task: Task,
    kind: UpdatedKind,
  }),
)
