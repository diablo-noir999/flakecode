import * as fs from "fs/promises"
import * as path from "path"
import { Token } from "../util/token"
import { SessionSchema } from "./schema"
import { SessionMessage } from "./message"
import { metaDir, checkpointPath, ensureDir } from "./checkpoint-paths"
import { CHECKPOINT_TEMPLATE, CHECKPOINT_SECTION_BUDGETS } from "./checkpoint-templates"

const TOOL_OUTPUT_MAX_CHARS = 2_000

const truncate = (value: string) =>
  value.length <= TOOL_OUTPUT_MAX_CHARS ? value : `${value.slice(0, TOOL_OUTPUT_MAX_CHARS)}\n[truncated]`

const serializeToolContent = (content: SessionMessage.ToolStateCompleted["content"]) =>
  content
    .map((item) =>
      item.type === "text" ? item.text : `[Attached ${item.mime}${item.name === undefined ? "" : `: ${item.name}`}]`,
    )
    .join("\n")

function estimateMessageTokens(m: SessionMessage.Message): number {
  try {
    return Token.estimate(JSON.stringify(m))
  } catch {
    return 1000
  }
}

function hasTextBlocks(m: SessionMessage.Message): boolean {
  if (m.type === "user") return true
  if (m.type === "assistant") {
    const msg = m as SessionMessage.Assistant
    return msg.content.some((p) => p.type === "text" || p.type === "reasoning")
  }
  return m.type === "system" || m.type === "synthetic"
}

/**
 * Token-budgeted, role-aware boundary choice for the preserved tail.
 *
 * Returns the index of the FIRST message to preserve (boundary index;
 * everything strictly before this index is summarized into checkpoint.md
 * and discarded from the rebuild context).
 *
 * Algorithm (token-budgeted boundary):
 * 1. Start at last finished assistant index - 1.
 * 2. If tail tokens >= TAIL_MAX_TOKENS: leave as-is (soft ceiling).
 * 3. Else if tail tokens < TAIL_MIN_TOKENS or text blocks < min: walk
 *    backward until both minimums met or TAIL_MAX_TOKENS hit.
 */
const TAIL_MIN_TOKENS = 10_000
const TAIL_MAX_TOKENS = 20_000
const TAIL_MIN_TEXT_MESSAGES = 5

export function computeBoundary(msgs: readonly SessionMessage.Message[]): number {
  if (msgs.length === 0) return 0

  const lastAsstIdx = msgs.findLastIndex(
    (m) => m.type === "assistant" && (m as SessionMessage.Assistant).finish !== undefined,
  )
  if (lastAsstIdx <= 0) return Math.max(lastAsstIdx, 0)

  const tokens = msgs.map((m) => estimateMessageTokens(m))

  let startIdx = lastAsstIdx - 1
  let tailSum = 0
  let textBlockCount = 0
  for (let i = startIdx; i < msgs.length; i++) {
    tailSum += tokens[i]
    if (hasTextBlocks(msgs[i])) textBlockCount += 1
  }

  if (tailSum >= TAIL_MAX_TOKENS) return startIdx

  while (
    startIdx > 0 &&
    tailSum < TAIL_MAX_TOKENS &&
    (tailSum < TAIL_MIN_TOKENS || textBlockCount < TAIL_MIN_TEXT_MESSAGES)
  ) {
    startIdx -= 1
    tailSum += tokens[startIdx]
    if (hasTextBlocks(msgs[startIdx])) textBlockCount += 1
  }

  return startIdx
}

function serializeMessage(message: SessionMessage.Message): string {
  if (message.type === "user") {
    const msg = message as SessionMessage.User
    const files = msg.files?.map((f) => `[Attached ${f.mime}: ${f.name ?? f.uri}]`) ?? []
    return [`[User]: ${msg.text}`, ...files].join("\n")
  }
  if (message.type === "assistant") {
    const msg = message as SessionMessage.Assistant
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
              `[Tool result]: ${truncate(serializeToolContent(tool.state.content))}`,
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
  if (message.type === "system") return `[System update]: ${(message as SessionMessage.System).text}`
  if (message.type === "synthetic") return `[Synthetic context]: ${(message as SessionMessage.Synthetic).text}`
  if (message.type === "shell") {
    const msg = message as SessionMessage.Shell
    return `[Shell]: ${msg.command}\n${truncate(msg.output)}`
  }
  return ""
}

/**
 * Select conversation split for summarization.
 * Returns head (for summarization) and recent (to preserve verbatim).
 */
export function selectForSummary(
  entries: readonly SessionMessage.Message[],
  keepTokens: number,
): { head: string; recent: string } | undefined {
  const conversation = entries
    .filter((entry) => entry.type !== "compaction")
    .map((entry) => serializeMessage(entry))
    .filter(Boolean)
  if (conversation.length === 0) return undefined

  let total = 0
  let split = conversation.length
  let splitPrefix = ""
  let splitSuffix = ""

  for (let index = conversation.length - 1; index >= 0; index--) {
    const next = total + Token.estimate(conversation[index])
    if (next > keepTokens) {
      const remaining = Math.max(0, keepTokens - total) * 4
      if (remaining > 0) {
        splitPrefix = conversation[index].slice(0, -remaining)
        splitSuffix = conversation[index].slice(-remaining)
        split = index + 1
      }
      break
    }
    total = next
    split = index
  }

  return {
    head: [...conversation.slice(0, split), splitPrefix].filter(Boolean).join("\n\n"),
    recent: [splitSuffix, ...conversation.slice(split)].filter(Boolean).join("\n\n"),
  }
}

/**
 * Write a checkpoint file summarizing the conversation so far.
 * Generates checkpoint.md from messages using template + boundary computation.
 */
export async function writeCheckpoint(
  sessionID: SessionSchema.ID,
  messages: SessionMessage.Message[],
): Promise<void> {
  await ensureDir(sessionID)

  const boundaryIdx = computeBoundary(messages)
  const messagesToSummarize = messages.slice(0, boundaryIdx)
  const recentMessages = messages.slice(boundaryIdx)

  const recentText = recentMessages.map(serializeMessage).filter(Boolean).join("\n\n")
  const summaryHint =
    messagesToSummarize.length > 0
      ? `\n\n_This checkpoint covers ${messagesToSummarize.length} messages (IDs ${messagesToSummarize[0]?.id ?? "?"} through ${messagesToSummarize[messagesToSummarize.length - 1]?.id ?? "?"}). ${recentMessages.length} recent messages preserved verbatim._`
      : ""

  const lines: string[] = []
  lines.push("# Session checkpoint")
  lines.push("")

  const lastUser = [...messages].reverse().find((m) => m.type === "user") as SessionMessage.User | undefined
  if (lastUser) {
    lines.push("## Active intent")
    lines.push(`> ${lastUser.text.slice(0, 500)}`)
    lines.push("")
  } else {
    lines.push("## Active intent")
    lines.push("(none yet)")
    lines.push("")
  }

  lines.push("## Next concrete action")
  lines.push("(derived from conversation context)")
  lines.push("")

  lines.push("## Current work")
  if (recentText.length > 0) {
    lines.push(recentText.slice(0, 2000))
  } else {
    lines.push("(none yet)")
  }
  lines.push("")

  lines.push("## Files and code sections")
  lines.push("(none yet)")
  lines.push("")

  lines.push("## Errors and fixes")
  lines.push("(none)")
  lines.push("")

  lines.push("## Design decisions")
  lines.push("(none yet)")
  lines.push("")

  lines.push("## Open notes")
  lines.push("(none yet)")
  lines.push("")

  lines.push("---")
  lines.push(summaryHint)

  await fs.writeFile(checkpointPath(sessionID), lines.join("\n"), "utf-8")
}

/**
 * Load the latest checkpoint file content, or undefined if none exists.
 */
export async function loadCheckpoint(sessionID: SessionSchema.ID): Promise<string | undefined> {
  try {
    const content = await fs.readFile(checkpointPath(sessionID), "utf-8")
    return content || undefined
  } catch {
    return undefined
  }
}

/**
 * Render the rebuild context from checkpoints + recent messages.
 * This replaces the LLM-based summary with checkpoint-file reconstruction.
 * Builds full context from checkpoint content plus recent messages.
 */
export async function renderRebuildContext(
  sessionID: SessionSchema.ID,
  messages: SessionMessage.Message[],
  opts?: { recentTokens?: number },
): Promise<string> {
  const checkpoint = await loadCheckpoint(sessionID)
  if (!checkpoint) return ""

  const recentTokens = opts?.recentTokens ?? 8000

  const selected = selectForSummary(messages, recentTokens)
  if (!selected) return checkpoint

  const lines: string[] = []

  lines.push(
    "The following blocks are auto-loaded from your session memory. They are already in your context — do not re-read them as whole files. Use Grep for specific facts instead.",
  )
  lines.push("")

  if (checkpoint.trim()) {
    lines.push("## Session checkpoint")
    lines.push(checkpoint.trim())
    lines.push("")
  }

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
  lines.push(selected.recent)

  return lines.join("\n")
}
