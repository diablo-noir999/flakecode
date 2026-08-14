import path from "path"
import type * as Tool from "./tool"
import { SessionCwd } from "./session-cwd"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { RecoverableError } from "./recoverable"
import type { SessionID } from "../session/schema"

// Same normalization both sides of the comparison go through so a Read on
// a relative path lines up with an Edit on the absolute one.
function canon(sessionID: SessionID, p: string): string {
  const abs = path.isAbsolute(p) ? p : path.resolve(SessionCwd.get(sessionID), p)
  if (process.platform === "win32") return FSUtil.normalizePath(abs).toLowerCase()
  return abs
}

/**
 * Throws RecoverableError if the given file was not previously read by the
 * `read` tool in this conversation. Writes/edits to existing files must be
 * preceded by a Read so the model sees the current contents.
 */
export function assertFileRead(ctx: Tool.Context, targetPath: string, toolId: string): void {
  const target = canon(ctx.sessionID, targetPath)

  for (const msg of ctx.messages) {
    for (const part of msg.parts) {
      if (part.type !== "tool") continue
      if (part.tool !== "read") continue
      if (part.state.status !== "completed") continue
      const input = part.state.input as { file_path?: unknown } | undefined
      const fp = input?.file_path
      if (typeof fp !== "string") continue
      if (canon(ctx.sessionID, fp) === target) return
    }
  }

  throw new RecoverableError(
    `${toolId}: ${targetPath} has not been read in this conversation. Call the read tool on this file first, then retry.`,
  )
}
