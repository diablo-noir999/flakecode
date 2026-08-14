import * as fs from "fs/promises"
import { Token } from "../util/token"
import { SessionSchema } from "./schema"
import { SessionMessage } from "./message"
import { checkpointPath, ensureDir } from "./checkpoint-paths"
import { CHECKPOINT_SECTION_BUDGETS } from "./checkpoint-templates"

/**
 * Truncate a string to a max token budget, keeping head + tail with elision.
 */
function truncateToBudget(text: string, maxTokens: number): string {
  if (Token.estimate(text) <= maxTokens) return text
  const headTokens = Math.floor(maxTokens * 0.6)
  const tailTokens = Math.floor(maxTokens * 0.3)
  const head = text.slice(0, headTokens * 4)
  const tail = text.slice(-tailTokens * 4)
  const elidedTokens = Token.estimate(text) - headTokens - tailTokens
  return [
    head,
    `[…elided ${elidedTokens} tokens]`,
    tail,
  ].join("\n")
}

/**
 * Parse a checkpoint file into sections.
 * Returns a map of section name → content.
 */
export function parseCheckpointSections(content: string): Map<string, string> {
  const sections = new Map<string, string>()
  const lines = content.split("\n")
  let currentSection = ""
  const currentLines: string[] = []

  for (const line of lines) {
    const match = line.match(/^## (.+)$/)
    if (match) {
      if (currentSection) {
        sections.set(currentSection, currentLines.join("\n").trim())
      }
      currentSection = match[1]
      currentLines.length = 0
    } else if (currentSection) {
      currentLines.push(line)
    }
  }
  if (currentSection) {
    sections.set(currentSection, currentLines.join("\n").trim())
  }

  return sections
}

/**
 * Read a checkpoint file and reconstruct context within a token budget.
 * Returns the checkpoint content trimmed to fit the budget.
 */
export async function readBudgeted(
  filePath: string,
  maxTokens: number,
): Promise<string | undefined> {
  try {
    const content = await fs.readFile(filePath, "utf-8")
    if (!content.trim()) return undefined
    return truncateToBudget(content, maxTokens)
  } catch {
    return undefined
  }
}

/**
 * Read a checkpoint file and reconstruct context section-aware within a token budget.
 * Returns sections individually, each within its own budget.
 */
export async function readBudgetedSectionAware(
  filePath: string,
  maxTokens: number,
): Promise<{ text: string; sections: Record<string, string> } | undefined> {
  try {
    const content = await fs.readFile(filePath, "utf-8")
    if (!content.trim()) return undefined

    const sections = parseCheckpointSections(content)
    const budgetedSections: Record<string, string> = {}
    let totalTokens = 0

    sections.forEach((body, name) => {
      const sectionBudget = CHECKPOINT_SECTION_BUDGETS[name] ?? 1000
      const budgeted = truncateToBudget(body, sectionBudget)
      budgetedSections[name] = budgeted
      totalTokens += Token.estimate(budgeted)
    })

    return {
      text: truncateToBudget(content, maxTokens),
      sections: budgetedSections,
    }
  } catch {
    return undefined
  }
}

const TOOL_OUTPUT_MAX_CHARS = 2_000

function truncateToolOutput(content: SessionMessage.ToolStateCompleted["content"]): string {
  const text = content
    .map((item) =>
      item.type === "text" ? item.text : `[Attached ${item.mime}${item.name === undefined ? "" : `: ${item.name}`}]`,
    )
    .join("\n")
  return text.length <= TOOL_OUTPUT_MAX_CHARS ? text : `${text.slice(0, TOOL_OUTPUT_MAX_CHARS)}\n[truncated]`
}

function serializeAssistantMessage(msg: SessionMessage.Assistant): string {
  return msg.content
    .flatMap((part: SessionMessage.AssistantContent) => {
      if (part.type === "text") return [`[Assistant]: ${(part as SessionMessage.AssistantText).text}`]
      if (part.type === "reasoning") {
        const r = part as SessionMessage.AssistantReasoning
        return r.text ? [`[Assistant reasoning]: ${r.text}`] : []
      }
      if (part.type === "tool") {
        const tool = part as SessionMessage.AssistantTool
        const input = typeof tool.state.input === "string" ? tool.state.input : JSON.stringify(tool.state.input)
        if (tool.state.status === "completed") {
          return [
            `[Assistant tool call]: ${tool.name}(${input})`,
            `[Tool result]: ${truncateToolOutput(tool.state.content)}`,
          ]
        }
        if (tool.state.status === "error") {
          return [`[Assistant tool call]: ${tool.name}(${input})`, `[Tool error]: ${tool.state.error.message}`]
        }
        return [`[Assistant tool call]: ${tool.name}(${input})`]
      }
      return []
    })
    .join("\n")
}

/**
 * Build the full rebuild context string from checkpoint content.
 * This is used when compaction triggers to inject checkpoint context.
 */
export function buildRebuildContext(
  checkpointContent: string,
  recentMessages: SessionMessage.Message[],
  opts?: { recentTokens?: number },
): string {
  const recentTokens = opts?.recentTokens ?? 8000

  const recentText = recentMessages
    .map((m) => {
      if (m.type === "user") return `[User]: ${(m as SessionMessage.User).text}`
      if (m.type === "assistant") return serializeAssistantMessage(m as SessionMessage.Assistant)
      if (m.type === "system") return `[System]: ${(m as SessionMessage.System).text}`
      if (m.type === "synthetic") return `[Synthetic]: ${(m as SessionMessage.Synthetic).text}`
      if (m.type === "shell") {
        const msg = m as SessionMessage.Shell
        return `[Shell]: ${msg.command}\n${msg.output.slice(0, 2000)}`
      }
      return ""
    })
    .filter(Boolean)
    .join("\n\n")

  const truncatedRecent = truncateToBudget(recentText, recentTokens)

  const lines: string[] = []
  lines.push("The following blocks are auto-loaded from your session memory. They are already in your context — do not re-read them as whole files. Use Grep for specific facts instead.")
  lines.push("")
  lines.push("## Session checkpoint")
  lines.push(checkpointContent.trim())
  lines.push("")
  lines.push(
    "This session is being continued from a previous conversation that hit a checkpoint. The session checkpoint above covers the earlier portion of the conversation.",
  )
  lines.push("")
  lines.push(
    "Recent messages are preserved verbatim below — the assistant turn (and any tool results) you'll see is real history, not pseudo-content. Continue your task by responding to the most recent state.",
  )
  lines.push("")
  lines.push(
    'Resume directly. Do not acknowledge this memory dump, do not recap, do not preface with "I\'ll continue" or similar. Pick up the last task as if the break never happened.',
  )
  lines.push("")
  lines.push("## Recent context (verbatim)")
  lines.push(truncatedRecent)

  return lines.join("\n")
}
