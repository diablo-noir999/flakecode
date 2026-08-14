import * as path from "path"
import { readFileSync, realpathSync } from "node:fs"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Global } from "@opencode-ai/core/global"

/**
 * Cross-branch git guard for ISOLATED CHILD sessions.
 */

const GLOBAL_WITH_VALUE = new Set([
  "-C",
  "-c",
  "--git-dir",
  "--work-tree",
  "--namespace",
  "--exec-path",
  "--config-env",
  "--super-prefix",
])

const IN_PROGRESS = new Set([
  "--abort",
  "--continue",
  "--skip",
  "--quit",
  "--edit-todo",
  "--show-current-patch",
])

const BRANCH_MUTATE = new Set(["-d", "-D", "--delete", "-f", "--force", "-m", "-M", "--move"])

const WORKTREE_MUTATE = new Set(["add", "remove", "move", "prune", "repair", "lock", "unlock"])

export type Violation = {
  command: string
  reason: string
}

function unquote(text: string) {
  if (text.length < 2) return text
  const first = text[0]
  if ((first === '"' || first === "'") && first === text[text.length - 1]) return text.slice(1, -1)
  return text
}

export function gitInvocation(tokens: string[]): { sub: string; args: string[] } | undefined {
  const argv = tokens.map(unquote).filter((tok) => tok.length > 0)
  if (argv.length < 2) return
  const head = path.basename(argv[0]).toLowerCase()
  if (head !== "git" && head !== "git.exe") return
  let i = 1
  while (i < argv.length) {
    const tok = argv[i]
    if (!tok.startsWith("-")) break
    if (GLOBAL_WITH_VALUE.has(tok)) {
      i += 2
      continue
    }
    i += 1
  }
  if (i >= argv.length) return
  return { sub: argv[i], args: argv.slice(i + 1) }
}

function positionals(args: string[]) {
  return args.filter((arg) => arg === "-" || !arg.startsWith("-"))
}

function valueOf(args: string[], flags: Set<string>) {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    for (const flag of flags) {
      if (arg === flag) return args[i + 1]
      if (arg.startsWith(flag + "=")) return arg.slice(flag.length + 1)
    }
  }
}

function pushTarget(refspec: string) {
  const spec = refspec.startsWith("+") ? refspec.slice(1) : refspec
  const colon = spec.lastIndexOf(":")
  const dst = colon === -1 ? spec : spec.slice(colon + 1)
  return dst.replace(/^refs\/heads\//, "")
}

export function violates(input: {
  tokens: string[]
  branch?: string
  isPath?: (arg: string) => boolean
}): string | undefined {
  const git = gitInvocation(input.tokens)
  if (!git) return
  const { sub, args } = git
  const branch = input.branch
  const isPath = input.isPath ?? (() => false)
  const owns = (name: string) => Boolean(branch) && (name === branch || name === "HEAD")

  switch (sub) {
    case "rebase": {
      if (args.some((arg) => IN_PROGRESS.has(arg))) return
      return "`git rebase` rewrites history against another branch and writes the shared ref store"
    }
    case "merge": {
      if (args.some((arg) => IN_PROGRESS.has(arg))) return
      return "`git merge` integrates another branch — integration is the orchestrator's job"
    }
    case "checkout":
    case "switch": {
      if (args.includes("--")) return
      const pos = positionals(args)
      if (pos.length !== 1) {
        if (args.includes("--detach")) return "`--detach` moves this worktree's HEAD off its own branch"
        return
      }
      const created = valueOf(args, new Set(["-b", "-c", "--orphan"]))
      if (created !== undefined) return
      const forced = valueOf(args, new Set(["-B", "-C"]))
      if (forced !== undefined) {
        if (owns(forced)) return
        return `\`git ${sub}\` force-creating '${forced}' resets a branch this session does not own`
      }
      const target = pos[0]
      if (isPath(target)) return
      if (owns(target)) return
      return `switching this worktree to '${target}' moves a ref/HEAD in the shared ref store`
    }
    case "branch": {
      if (!args.some((arg) => BRANCH_MUTATE.has(arg))) return
      const pos = positionals(args)
      if (pos.length > 0 && pos.every((name) => owns(name))) return
      return "deleting, force-moving or renaming a branch mutates the shared ref store"
    }
    case "push": {
      const pos = positionals(args)
      const specs = pos.slice(1)
      const forced =
        args.includes("--force") || args.includes("-f") || specs.some((spec) => spec.startsWith("+"))
      const deleting = args.includes("--delete") || specs.some((spec) => spec.startsWith(":"))
      if (!forced && !deleting) return
      if (specs.length === 0) return
      const foreign = specs.map(pushTarget).filter((name) => !owns(name))
      if (foreign.length === 0) return
      return `force-pushing or deleting '${foreign[0]}' rewrites a branch this session does not own`
    }
    case "worktree": {
      const pos = positionals(args)
      if (pos.length === 0 || !WORKTREE_MUTATE.has(pos[0])) return
      return `\`git worktree ${pos[0]}\` mutates the shared worktree registry`
    }
    case "update-ref": {
      const pos = positionals(args)
      const ref = pos[0] ?? ""
      if (owns(ref.replace(/^refs\/heads\//, ""))) return
      return "`git update-ref` writes the shared ref store directly"
    }
    case "symbolic-ref": {
      const pos = positionals(args)
      if (pos.length < 2 && !args.includes("--delete") && !args.includes("-d")) return
      return "`git symbolic-ref` repoints HEAD in the shared ref store"
    }
    case "tag": {
      if (args.includes("-f") || args.includes("--force")) return "`git tag -f` moves a shared tag"
      if (args.includes("-d") || args.includes("--delete")) return "`git tag -d` deletes a shared tag"
      return
    }
    default:
      return
  }
}

export function isIsolatedWorktree(directory: string | undefined, root?: string) {
  if (!directory) return false
  const base = root ?? path.join(Global.Path.data, "worktree")
  if (FSUtil.contains(base, directory)) return true
  return FSUtil.contains(real(base), real(directory))
}

function real(target: string) {
  try {
    return realpathSync(target)
  } catch {
    return path.resolve(target)
  }
}

export function ownBranch(directory: string): string | undefined {
  try {
    const dotGit = path.join(directory, ".git")
    let gitDir = dotGit
    try {
      const pointer = readFileSync(dotGit, "utf-8")
      const match = pointer.match(/^gitdir:\s*(.+)$/m)
      if (match) gitDir = path.resolve(directory, match[1].trim())
    } catch {
      // `.git` is a directory (ordinary clone)
    }
    const head = readFileSync(path.join(gitDir, "HEAD"), "utf-8").trim()
    const ref = head.match(/^ref:\s*refs\/heads\/(.+)$/)
    return ref ? ref[1] : undefined
  } catch {
    return undefined
  }
}

function message(input: { violation: Violation; directory: string; branch?: string }) {
  const branch = input.branch ?? "(could not be determined)"
  return (
    `Blocked in an isolated child session: ${input.violation.command}\n` +
    `Reason: ${input.violation.reason}.\n\n` +
    `Every worktree of this repository shares ONE .git/ ref store, so a cross-branch git\n` +
    `operation run from inside your worktree writes refs the MAIN checkout is using and can\n` +
    `move its HEAD — corrupting the working tree the user and other agents are in right now.\n\n` +
    `  your worktree: ${input.directory}\n` +
    `  your branch:   ${branch}\n\n` +
    `Do this instead:\n` +
    `  - work only in your worktree, on your own branch\n` +
    `  - \`git add\` + \`git commit\` + \`git push\` YOUR branch, and nothing else\n` +
    `  - ask the orchestrator to rebase/merge/land it — cross-branch integration is its job\n`
  )
}

export function assertIsolatedGitAllowed(input: {
  commands: string[][]
  sources?: string[]
  directory: string
  isolated: boolean
  branch?: string
  isPath?: (arg: string) => boolean
}): void {
  if (!input.isolated) return
  for (let i = 0; i < input.commands.length; i++) {
    const tokens = input.commands[i]
    const reason = violates({ tokens, branch: input.branch, isPath: input.isPath })
    if (!reason) continue
    throw new Error(
      message({
        violation: { command: input.sources?.[i] ?? tokens.join(" "), reason },
        directory: input.directory,
        branch: input.branch,
      }),
    )
  }
}
