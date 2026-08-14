import { LocalContext } from "@/util/local-context"
import { FSUtil } from "@opencode-ai/core/fs-util"
import type * as Project from "./project"

export interface InstanceContext {
  directory: string
  worktree: string
  project: Project.Info
}

export const context = LocalContext.create<InstanceContext>("instance")

/**
 * Check if a path is within the project boundary.
 * Returns true if path is inside ctx.directory OR ctx.worktree.
 * Paths within the worktree but outside the working directory should not trigger external_directory permission.
 */
export function containsPath(filepath: string, ctx: InstanceContext): boolean {
  if (FSUtil.contains(ctx.directory, filepath)) return true
  // Non-git projects set worktree to "/" which would match ANY absolute path.
  // Skip worktree check in this case to preserve external_directory permissions.
  if (ctx.worktree === "/") return false
  return FSUtil.contains(ctx.worktree, filepath)
}

export const Instance = {
  get worktree(): string {
    try {
      return context.use().worktree
    } catch {
      return ""
    }
  },
  async provide<T>(input: { directory: string; fn: () => Promise<T> }): Promise<T> {
    return context.provide(
      { directory: input.directory, worktree: input.directory, project: {} as Project.Info },
      input.fn,
    )
  },
  async current(): Promise<InstanceContext> {
    return context.use()
  },
  async disposeDirectory(_directory: string): Promise<void> {
    // No-op: cleanup is handled by ScopedCache in InstanceState
  },
}
