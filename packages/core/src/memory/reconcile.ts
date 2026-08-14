import * as fs from "fs/promises"
import path from "path"
import { eq } from "drizzle-orm"
import { Effect } from "effect"
import { Database } from "../database/database"
import { MemoryFtsTable } from "./fts.sql"
import { parsePath, type MemoryLocator } from "./paths"

export async function walkMemoryDir(root: string): Promise<string[]> {
  const out: string[] = []
  async function recurse(dir: string) {
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch((e: NodeJS.ErrnoException) => {
      if (e.code === "ENOENT") return [] as import("fs").Dirent[]
      throw e
    })
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) await recurse(full)
      else if (entry.isFile() && full.endsWith(".md")) out.push(full)
    }
  }
  await recurse(root)
  return out
}

export async function indexFromDisk(
  absPath: string,
  loc: MemoryLocator,
  db: Database.Interface["db"],
  oldFingerprint?: string,
): Promise<"hit" | "updated" | "skipped"> {
  const stat = await fs.stat(absPath).catch((e: NodeJS.ErrnoException) => {
    if (e.code === "ENOENT") return null
    throw e
  })
  if (!stat) return "skipped"
  const fingerprint = `${stat.size}-${stat.mtimeMs}`
  if (oldFingerprint === fingerprint) return "hit"

  const body = await fs.readFile(absPath, "utf-8")

  await db
    .insert(MemoryFtsTable)
    .values({
      path: absPath,
      scope: loc.scope,
      scope_id: loc.scope_id,
      type: loc.type,
      body,
      fingerprint,
      last_indexed_at: Date.now(),
    })
    .onConflictDoUpdate({
      target: MemoryFtsTable.path,
      set: {
        scope: loc.scope,
        scope_id: loc.scope_id,
        type: loc.type,
        body,
        fingerprint,
        last_indexed_at: Date.now(),
      },
    })
    .run()
    .pipe(Effect.orDie)

  return "updated"
}

export async function reconcileMemory(
  root: string,
  db: Database.Interface["db"],
): Promise<{ indexed: number; pruned: number }> {
  const diskFiles = new Set(await walkMemoryDir(root))

  const rows = await Effect.runPromise(
    db
      .select({ path: MemoryFtsTable.path, fingerprint: MemoryFtsTable.fingerprint })
      .from(MemoryFtsTable)
      .all()
      .pipe(Effect.orDie),
  )
  const indexed = new Map<string, string>(rows.map((r) => [r.path, r.fingerprint]))

  // Direction B: prune dead FTS rows (any path not on disk).
  let pruned = 0
  for (const p of indexed.keys()) {
    if (!diskFiles.has(p)) {
      await db.delete(MemoryFtsTable).where(eq(MemoryFtsTable.path, p)).run().pipe(Effect.orDie)
      pruned++
    }
  }

  // Direction A: index disk files.
  let indexedCount = 0
  for (const p of diskFiles) {
    const loc = parsePath(p)
    if (!loc) continue
    const result = await indexFromDisk(p, loc, db, indexed.get(p))
    if (result === "updated") indexedCount++
  }

  return { indexed: indexedCount, pruned }
}
