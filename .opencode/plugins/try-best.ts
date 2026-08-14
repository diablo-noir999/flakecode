import type { Plugin, PluginInput } from "@opencode-ai/plugin"

const TRY_BEST_EDIT_WINDOW = 12
const TRY_BEST_EDIT_SIMILARITY = 0.8
const TRY_BEST_EDIT_MATCHES = 2
const TRY_BEST_ACTION_STREAK = 4
const TRY_BEST_BASH_RETRIES = 3

type TryBestReason = "edit_repeat" | "bash_retry" | "action_streak"

type TryBestEvidence = {
  tool: string
  path?: string
  command?: string
  count: number
  similarity?: number
  action?: "edit" | "verify"
}

type TryBestIncident = {
  reason: TryBestReason
  evidence: TryBestEvidence
}

type EditEvent = {
  path: string
  shingles: ReadonlySet<string>
}

type Action = {
  kind: "edit" | "verify"
  progress: boolean
}

const EDIT_TOOLS = new Set(["edit", "write", "apply_patch", "multiedit", "notebook_edit", "str_replace"])
const VERIFY_COMMAND =
  /(?:^|[;&|]\s*|\s)(?:bun\s+(?:test|typecheck|run\s+(?:test|typecheck|lint|build))|npm\s+(?:test|run\s+(?:test|typecheck|lint|build))|pnpm\s+(?:test|run\s+(?:test|typecheck|lint|build))|yarn\s+(?:test|run\s+(?:test|typecheck|lint|build))|pytest\b|python(?:3)?\s+-m\s+pytest\b|cargo\s+(?:test|check|clippy|build)\b|go\s+test\b|make\s+(?:test|check|lint|build)\b|tsc\b)/i

function normalizeDiff(diff: string) {
  return diff
    .replaceAll("\r\n", "\n")
    .split("\n")
    .filter(
      (line) => (line.startsWith("+") || line.startsWith("-")) && !line.startsWith("+++") && !line.startsWith("---"),
    )
    .map((line) => `${line[0]} ${line.slice(1).trim().replace(/\s+/g, " ")}`)
    .filter((line) => line.length > 2)
    .join(" ")
}

function shingleSet(value: string, size = 3) {
  const tokens = value.split(/\s+/).filter(Boolean)
  if (tokens.length < size) return new Set(tokens.length ? [tokens.join("\0")] : [])
  return new Set(
    tokens.slice(0, tokens.length - size + 1).map((_, index) => tokens.slice(index, index + size).join("\0")),
  )
}

function jaccard(left: ReadonlySet<string>, right: ReadonlySet<string>) {
  const union = new Set([...left, ...right])
  if (union.size === 0) return 0
  return [...left].filter((value) => right.has(value)).length / union.size
}

function normalizeCommand(command: string) {
  return command
    .replace(/(?:\/private)?\/tmp\/[\w.-]+/g, "<TMP>")
    .replace(/\b\d{6,}\b/g, "<NUM>")
    .replace(/--seed(?:=|\s+)\S+/g, "<SEED>")
    .replace(/\s+/g, " ")
    .trim()
}

function normalizeResult(value: string) {
  const normalized = value
    .replace(/(?:\/private)?\/tmp\/[\w./-]+/g, "<TMP>")
    .replace(/\b\d{6,}\b/g, "<NUM>")
    .replace(/\b\d+(?:\.\d+)?(?:ms|s|sec|seconds?)\b/gi, "<TIME>")
    .replace(/\s+/g, " ")
    .trim()
  if (normalized.length <= 2000) return normalized
  const marker = " <TRUNCATED> "
  const head = Math.ceil((2000 - marker.length) / 2)
  return `${normalized.slice(0, head)}${marker}${normalized.slice(-(2000 - marker.length - head))}`
}

class TryBestMonitor {
  private edits: EditEvent[] = []
  private failed = new Map<string, number>()
  private action: Action | undefined
  private streak = 0
  private verify = new Map<string, { success: boolean; result: string }>()

  consume(toolName: string, args: Record<string, unknown>, output: string, success: boolean): TryBestIncident | undefined {
    if (EDIT_TOOLS.has(toolName)) return this.edit(toolName, args, output, success)
    if (toolName !== "bash") return undefined
    return this.bash(toolName, args, output, success)
  }

  reset() {
    this.edits = []
    this.failed.clear()
    this.verify.clear()
    this.action = undefined
    this.streak = 0
  }

  private edit(toolName: string, args: Record<string, unknown>, output: string, success: boolean): TryBestIncident | undefined {
    if (!success) return this.trackAction({ kind: "edit", progress: false }, toolName)
    this.failed.clear()

    const filePath = (args.file_path ?? args.path ?? args.notebook_path) as string | undefined
    const diff = (args.diff ?? args.old_string ?? output) as string | undefined
    if (!filePath || !diff) return this.trackAction({ kind: "edit", progress: false }, toolName)

    const normalized = normalizeDiff(diff)
    if (!normalized) return this.trackAction({ kind: "edit", progress: false }, toolName)

    const shingles = shingleSet(normalized)
    const matches = this.edits
      .filter((event) => event.path === filePath)
      .map((event) => jaccard(shingles, event.shingles))
      .filter((similarity) => similarity > TRY_BEST_EDIT_SIMILARITY)

    this.edits.push({ path: filePath, shingles })
    if (this.edits.length > TRY_BEST_EDIT_WINDOW) this.edits.shift()

    if (matches.length < TRY_BEST_EDIT_MATCHES) {
      return this.trackAction({ kind: "edit", progress: false }, toolName)
    }

    return {
      reason: "edit_repeat",
      evidence: {
        tool: toolName,
        path: filePath,
        count: matches.length + 1,
        similarity: Math.max(...matches),
      },
    }
  }

  private bash(toolName: string, args: Record<string, unknown>, output: string, success: boolean): TryBestIncident | undefined {
    const raw = (args.command ?? args.cmd) as string | undefined
    if (!raw) {
      this.action = undefined
      this.streak = 0
      return undefined
    }

    const normalized = normalizeCommand(raw)
    const normalizedOutput = normalizeResult(output)
    const verifying = VERIFY_COMMAND.test(normalized)
    const previous = verifying ? this.verify.get(normalized) : undefined
    const progress = success || (!!previous && previous.result !== normalizedOutput)

    if (verifying) this.verify.set(normalized, { success, result: normalizedOutput })

    const count = !success ? (progress ? 1 : (this.failed.get(normalized) ?? 0) + 1) : 0
    if (!success) this.failed.set(normalized, count)
    if (success) this.failed.delete(normalized)

    const retry =
      count >= TRY_BEST_BASH_RETRIES
        ? { reason: "bash_retry" as const, evidence: { tool: toolName, command: normalized, count } }
        : undefined

    if (!verifying) return retry

    const action = this.trackAction({ kind: "verify", progress }, toolName, normalized)
    return retry ?? action
  }

  private trackAction(next: Action, tool: string, command?: string): TryBestIncident | undefined {
    if (next.progress || this.action?.kind !== next.kind) {
      this.action = next
      this.streak = next.progress ? 0 : 1
      return undefined
    }

    this.streak++
    if (this.streak < TRY_BEST_ACTION_STREAK) return undefined

    return {
      reason: "action_streak",
      evidence: { tool, command, count: this.streak, action: next.kind },
    }
  }
}

function formatIncident(incident: TryBestIncident): string {
  switch (incident.reason) {
    case "edit_repeat":
      return `Detected edit repeat on ${incident.evidence.path} (${incident.evidence.count} similar edits, similarity: ${(incident.evidence.similarity ?? 0).toFixed(2)}). Consider taking a different approach.`
    case "bash_retry":
      return `Detected bash command retry (${incident.evidence.count} failures): \`${incident.evidence.command}\`. Consider a different approach.`
    case "action_streak":
      return `Detected ${incident.evidence.count} consecutive ${incident.evidence.action} actions without progress. Consider taking a different approach.`
    default:
      return "Detected potential loop. Consider taking a different approach."
  }
}

const monitors = new Map<string, TryBestMonitor>()

function getMonitor(sessionID: string): TryBestMonitor {
  const hit = monitors.get(sessionID)
  if (hit) return hit
  const next = new TryBestMonitor()
  monitors.set(sessionID, next)
  return next
}

const plugin: Plugin = async (input: PluginInput) => {
  return {
    "tool.execute.after": async (hookInput, output) => {
      const monitor = getMonitor(hookInput.sessionID)
      const success = !output.output.toLowerCase().includes("error") && !output.output.toLowerCase().includes("failed")

      const incident = monitor.consume(hookInput.tool, hookInput.args, output.output, success)

      if (incident) {
        const warning = `\u26a0\ufe0f Try-Best: ${formatIncident(incident)}`
        output.output = `${warning}\n\n${output.output}`
      }
    },
  }
}

export default plugin
