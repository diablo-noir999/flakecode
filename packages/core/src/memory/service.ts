export * as Memory from "./service"

import path from "path"
import { sql } from "drizzle-orm"
import { Context, Effect, Layer } from "effect"
import { Global } from "../global"
import { Database } from "../database/database"
import { Config } from "../config"
import { reconcileMemory } from "./reconcile"
import { buildFtsQuery } from "./fts-query"

type SearchRow = {
  path: string
  scope: string
  scope_id: string
  type: string
  snippet: string
  score: number
}

export interface Interface {
  readonly root: () => Effect.Effect<string>
  readonly reconcile: () => Effect.Effect<{ indexed: number; pruned: number }>
  readonly search: (input: {
    query: string
    scope?: string
    scope_id?: string
    type?: string
    limit?: number
  }) => Effect.Effect<
    Array<{ path: string; snippet: string; score: number; scope: string; scope_id: string; type: string }>
  >
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Memory") {}

export const layer: Layer.Layer<Service, never, Database.Service | Config.Service | Global.Service> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const config = yield* Config.Service
    const global = yield* Global.Service
    const root = path.join(global.data, "memory")

    const rootEff = Effect.fn("Memory.root")(function* () {
      return root
    })

    const reconcile = Effect.fn("Memory.reconcile")(function* () {
      return yield* Effect.promise(() => reconcileMemory(root, db))
    })

    const search = Effect.fn("Memory.search")(function* (input: {
      query: string
      scope?: string
      scope_id?: string
      type?: string
      limit?: number
    }) {
      const limit = input.limit ?? 10
      const ftsQuery = buildFtsQuery(input.query)
      if (!ftsQuery) return []

      // Lazy reconcile before search (covers off-tool writes).
      yield* Effect.promise(() => reconcileMemory(root, db))

      // Configurable score floor: keep results scoring at least `ratio` of the
      // top hit's score. Relative (not absolute) because BM25 magnitudes are
      // corpus-size-dependent. The #1 result is ALWAYS kept. Default 0.15.
      // Configurable; 0 disables (keep all matches).
      const floorRatio = 0.15

      const conditions: string[] = []
      const params: (string | number)[] = []
      if (input.scope) {
        conditions.push("memory_fts.scope = ?")
        params.push(input.scope)
      }
      if (input.scope_id) {
        conditions.push("memory_fts.scope_id = ?")
        params.push(input.scope_id)
      }
      if (input.type) {
        conditions.push("memory_fts.type = ?")
        params.push(input.type)
      }
      const whereClause = conditions.length > 0 ? `AND ${conditions.join(" AND ")}` : ""

      // Over-fetch (3x, capped) so the relative floor can trim common-word
      // noise without starving the list when there ARE enough real hits.
      const fetchLimit = Math.min(limit * 3, 50)

      const sqlText = `
        SELECT memory_fts.path, memory_fts.scope, memory_fts.scope_id, memory_fts.type,
               snippet(memory_fts_idx, 0, '<<', '>>', '...', 32) AS snippet,
               bm25(memory_fts_idx) AS score
        FROM memory_fts_idx
        JOIN memory_fts ON memory_fts.id = memory_fts_idx.rowid
        WHERE memory_fts_idx MATCH '${ftsQuery.replace(/'/g, "''")}'
        ${whereClause}
        ORDER BY score
        LIMIT ${fetchLimit}
      `
      const rows = yield* db.all<SearchRow>(sql.raw(sqlText)).pipe(Effect.orDie)

      // FTS5 bm25() returns lower = better; convert to higher = better for caller
      const mapped = rows.map((r) => ({
        path: r.path,
        snippet: r.snippet,
        score: -r.score,
        scope: r.scope,
        scope_id: r.scope_id,
        type: r.type,
      }))
      if (mapped.length === 0) return []
      // Rows are ORDER BY score (best first), so mapped[0] is the top hit.
      // Always keep it; drop trailing rows below `floorRatio` of its score.
      const topScore = mapped[0].score
      const cutoff = floorRatio > 0 ? topScore * floorRatio : -Infinity
      return mapped.filter((r, i) => i === 0 || r.score >= cutoff).slice(0, limit)
    })

    return Service.of({
      root: rootEff,
      reconcile,
      search,
    })
  }),
)

export const defaultLayer = Layer.mergeAll(layer)
