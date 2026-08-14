import { Effect } from "effect"
import { TaskRegistry } from "./registry"
import type { SessionID } from "@/session/schema"

export const MAX_TASK_GATE_SUBAGENT_REACT = 2

export type Decision =
  | { needReentry: false; capExceeded: false; incompleteTasks: [] }
  | { needReentry: true; reentryText: string; incompleteTasks: string[]; capExceeded: false }
  | { needReentry: false; capExceeded: true; incompleteTasks: string[] }

export interface DecideInput {
  session_id: SessionID
  owner?: string
  reactCount: number
  maxReact: number
}

const buildReentryText = (incomplete: { id: string; status: string; summary: string }[]): string =>
  [
    "<system-reminder>",
    "You are about to finish, but these tasks you own are still unfinished:",
    ...incomplete.map((t) => `- ${t.id} (${t.status}): ${t.summary}`),
    "For EACH: complete the work then `task done <id> <summary>`, or `task abandon <id> <reason>` if it is genuinely not needed.",
    "Then re-emit your final message starting with the **Status**/**Summary** header.",
    "</system-reminder>",
  ].join("\n")

export const decide = Effect.fn("TaskGate.decide")(function* (input: DecideInput) {
  const reg = yield* TaskRegistry.Service
  const tasks = yield* reg
    .list({
      session_id: input.session_id,
      owner: input.owner,
      include_terminal: false,
    })
    .pipe(Effect.orElseSucceed(() => []))

  const actionable = tasks.filter((t) => t.status === "open" || t.status === "in_progress")

  if (actionable.length === 0) {
    return { needReentry: false, capExceeded: false, incompleteTasks: [] } satisfies Decision
  }

  if (input.reactCount >= input.maxReact) {
    return {
      needReentry: false,
      capExceeded: true,
      incompleteTasks: actionable.map((t) => t.id),
    } satisfies Decision
  }

  return {
    needReentry: true,
    capExceeded: false,
    reentryText: buildReentryText(actionable),
    incompleteTasks: actionable.map((t) => t.id),
  } satisfies Decision
})

export * as TaskGate from "./gate"
