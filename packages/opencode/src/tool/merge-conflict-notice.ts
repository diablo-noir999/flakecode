import * as path from "path"
import { existsSync, readFileSync } from "node:fs"
import { Effect } from "effect"
import type { Git } from "@/git"

/**
 * CONFLICT-OWNERSHIP AFFORDANCE for the bash tool.
 */

const OPERATIONS: ReadonlyArray<{ marker: string; abort: string; label: string }> = [
  { marker: "rebase-merge", abort: "git rebase --abort", label: "rebase" },
  { marker: "rebase-apply", abort: "git rebase --abort", label: "rebase" },
  { marker: "CHERRY_PICK_HEAD", abort: "git cherry-pick --abort", label: "cherry-pick" },
  { marker: "REVERT_HEAD", abort: "git revert --abort", label: "revert" },
  { marker: "MERGE_HEAD", abort: "git merge --abort", label: "merge" },
]

const CAPABLE = /\bgit\b[^\n;&|]*?\b(merge|rebase|cherry-pick|revert|pull|am)\b/

export function hint(input: { command: string; output: string }) {
  if (/\bCONFLICT\b/.test(input.output)) return true
  return CAPABLE.test(input.command)
}

export function unmerged(text: string) {
  const out: string[] = []
  for (const line of text.split("\n")) {
    const tab = line.indexOf("\t")
    if (tab === -1) continue
    const file = line.slice(tab + 1).trim()
    if (file && !out.includes(file)) out.push(file)
  }
  return out
}

export function incoming(text: string) {
  const match = text.match(/^Merge (?:remote-tracking )?branch '([^']+)'/m)
  return match?.[1]
}

export type Conflict = {
  files: string[]
  abort: string
  label: string
  branch?: string
}

export function notice(conflict: Conflict) {
  const files = conflict.files.map((file) => `  ${file}`).join("\n")
  const branch = conflict.branch ? `\`${conflict.branch}\`` : "the branch you just integrated"
  const task = conflict.branch
    ? `${conflict.branch} conflicts with the base branch in ${conflict.files.join(", ")} — rebase onto the base, resolve it on your branch, and push`
    : `your branch conflicts with the base branch in ${conflict.files.join(", ")} — rebase onto the base, resolve it on your branch, and push`
  return (
    `\n\nTHIS ${conflict.label.toUpperCase()} CONFLICTED — THE CONFLICT IS NOT YOURS TO RESOLVE. The repository is ` +
    `mid-${conflict.label} right now with unmerged paths:\n${files}\n\n` +
    `A conflict belongs to the session that OWNS ${branch}, not to whoever ran the ${conflict.label}. Integrating a ` +
    `ready branch is your job; reconciling someone else's work with the base is theirs. Do NOT open these files, do ` +
    `NOT edit conflict markers, do NOT \`git add\`/\`git commit\` them, and do not delete the branch. Do this instead:\n\n` +
    `  1. ${conflict.abort}\n` +
    `  2. session send <owning-session-id> "${task}"\n\n` +
    `You do not have the owning session's id in this result — \`session list\` shows the roster, and every ` +
    `\`session create\`/\`session send\` result echoes it. If no session owns ${branch} (you authored both sides ` +
    `yourself), say so explicitly before you resolve anything by hand.\n\n` +
    `This block is internal working context, not output — do not repeat it to the user; tell them the conflict ` +
    `went back to the branch's owner.`
  )
}

export const annotate = Effect.fn("BashTool.mergeConflictNotice")(function* (input: {
  git: Git.Interface
  cwd: string
  command: string
  output: string
}) {
  if (!hint({ command: input.command, output: input.output })) return ""

  const listed = yield* input.git.run(["ls-files", "--unmerged"], { cwd: input.cwd })
  if (listed.exitCode !== 0) return ""
  const files = unmerged(listed.text())
  if (files.length === 0) return ""

  const dir = yield* input.git.run(["rev-parse", "--absolute-git-dir"], { cwd: input.cwd })
  if (dir.exitCode !== 0) return ""
  const gitDir = dir.text().trim()
  if (!gitDir) return ""

  const operation = OPERATIONS.find((candidate) => exists(path.join(gitDir, candidate.marker)))
  if (!operation) return ""

  return notice({
    files,
    abort: operation.abort,
    label: operation.label,
    branch: operation.label === "merge" ? read(path.join(gitDir, "MERGE_MSG")) : undefined,
  })
})

function exists(target: string) {
  try {
    return existsSync(target)
  } catch {
    return false
  }
}

function read(target: string) {
  try {
    return incoming(readFileSync(target, "utf-8"))
  } catch {
    return undefined
  }
}
