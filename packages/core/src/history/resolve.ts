import { Effect } from "effect"
import { eq } from "drizzle-orm"
import { Database } from "../database/database"
import { MessageTable, SessionTable } from "../session/sql"

class LRU<K, V> {
  private map = new Map<K, V>()
  constructor(private readonly max: number) {}
  get(k: K): V | undefined {
    const v = this.map.get(k)
    if (v === undefined) return undefined
    this.map.delete(k)
    this.map.set(k, v)
    return v
  }
  set(k: K, v: V) {
    if (this.map.has(k)) this.map.delete(k)
    this.map.set(k, v)
    if (this.map.size > this.max) {
      const oldest = this.map.keys().next().value
      if (oldest !== undefined) this.map.delete(oldest)
    }
  }
}

export type Resolver = {
  role: (messageID: string) => Effect.Effect<"user" | "assistant", never, Database.Service>
  projectID: (sessionID: string) => Effect.Effect<string, never, Database.Service>
}

export function makeResolver(): Resolver {
  const roleCache = new LRU<string, "user" | "assistant">(1024)
  const projectCache = new LRU<string, string>(512)

  return {
    role: (messageID) =>
      Effect.gen(function* () {
        const cached = roleCache.get(messageID)
        if (cached) return cached
        const { db } = yield* Database.Service
        const row = yield* db
          .select({ data: MessageTable.data })
          .from(MessageTable)
          .where(eq(MessageTable.id, messageID as any))
          .get()
          .pipe(Effect.orDie)
        const role = (row?.data as { role?: string } | undefined)?.role === "user" ? "user" : "assistant"
        roleCache.set(messageID, role)
        return role
      }),

    projectID: (sessionID) =>
      Effect.gen(function* () {
        const cached = projectCache.get(sessionID)
        if (cached) return cached
        const { db } = yield* Database.Service
        const row = yield* db
          .select({ project_id: SessionTable.project_id })
          .from(SessionTable)
          .where(eq(SessionTable.id, sessionID as any))
          .get()
          .pipe(Effect.orDie)
        const projectID = row?.project_id ?? ""
        projectCache.set(sessionID, projectID)
        return projectID
      }),
  }
}
