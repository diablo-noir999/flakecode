import * as path from "path"
import * as fs from "fs/promises"
import { SessionSchema } from "./schema"

const DATA_DIR = path.join(process.env.HOME ?? "~", ".opencode", "data")

/**
 * Session memory root. Houses checkpoint artifacts under
 * `<data>/memory/sessions/<sid>/`.
 */
export function metaDir(sessionID: SessionSchema.ID): string {
  return path.join(DATA_DIR, "memory", "sessions", sessionID)
}

/**
 * Single-file checkpoint at `<sid>/checkpoint.md`.
 */
export function checkpointPath(sessionID: SessionSchema.ID): string {
  return path.join(metaDir(sessionID), "checkpoint.md")
}

/**
 * Ensure the session memory directory exists.
 */
export async function ensureDir(sessionID: SessionSchema.ID): Promise<void> {
  await fs.mkdir(metaDir(sessionID), { recursive: true })
}
