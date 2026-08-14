import { BusEvent } from "@/bus/bus-event"
import { registerDisposer } from "@/effect/instance-registry"
import { InstanceState } from "@/effect/instance-state"
import { SessionID } from "@/session/schema"
import z from "zod"

interface Entry {
  directory: string
  cwd: string
}

const store = new Map<string, Entry>()

registerDisposer(async (directory) => {
  for (const [sessionID, entry] of store) {
    if (entry.directory === directory) store.delete(sessionID)
  }
})

export const Event = {
  Changed: BusEvent.define(
    "session.cwd",
    z.object({
      sessionID: SessionID,
      cwd: z.string(),
    }),
  ),
}

export function get(sessionID: SessionID): string {
  const entry = store.get(sessionID)
  return entry?.cwd ?? ""
}

export function set(sessionID: SessionID, dir: string): void {
  const directory = ""
  store.set(sessionID, { directory, cwd: dir })
}

export function clear(sessionID: SessionID): void {
  store.delete(sessionID)
}

export async function initDirectory(_sessionID: SessionID): Promise<void> {
  // InstanceState.directory requires InstanceRef context which isn't available
  // outside an Effect runtime. The directory is populated by the tool execution
  // context when needed.
}

export * as SessionCwd from "./session-cwd"
