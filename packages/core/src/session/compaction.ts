export * as SessionCompaction from "./compaction"

import { LLM, LLMError, LLMEvent, Message, type LLMRequest, type Model } from "@opencode-ai/llm"
import { DateTime, Effect, Stream } from "effect"
import type { Config } from "../config"
import type { EventV2 } from "../event"
import { SessionEvent } from "./event"
import { SessionMessage } from "./message"
import { SessionSchema } from "./schema"
import { Token } from "../util/token"
import {
  writeCheckpoint,
  loadCheckpoint,
  computeBoundary,
} from "./checkpoint"
import { buildRebuildContext, readBudgeted } from "./checkpoint-rebuild"

const DEFAULT_BUFFER = 20_000
const DEFAULT_KEEP_TOKENS = 8_000
const TOOL_OUTPUT_MAX_CHARS = 2_000
const SUMMARY_OUTPUT_TOKENS = 4_096
const SUMMARY_TEMPLATE = `Output exactly the Markdown structure shown inside <template> and keep the section order unchanged. Do not include the <template> tags in your response.
<template>
## Objective
- [one or two brief sentences describing what the user is trying to accomplish]

## Important Details
- [constraints/preferences, decisions and why, important facts/assumptions, exact context needed to continue, or "(none)"]

## Work State
### Completed
- [finished work, verified facts, or changes made; otherwise "(none)"]

### Active
- [current work, partial changes, or investigation state; otherwise "(none)"]

### Blocked
- [blockers, failing commands, or unknowns; otherwise "(none)"]

## Next Move
1. [immediate concrete action, or "(none)"]
2. [next action if known, or "(none)"]

## Relevant Files
- [file or directory path: why it matters, or "(none)"]
</template>

Rules:
- Keep every section, even when empty.
- Use terse bullets, not prose paragraphs.
- Preserve exact file paths, symbols, commands, error strings, URLs, and identifiers when known.
- Do not mention the summary process or that context was compacted.`

// Checkpoint intervals: write at every 10% context fill
const CHECKPOINT_INTERVAL_PERCENT = 10

type Entry = {
  readonly seq: number
  readonly message: SessionMessage.Message
}

type Settings = {
  readonly auto: boolean
  readonly buffer: number
  readonly tokens: number
}

type Dependencies = {
  readonly events: EventV2.Interface
  readonly llm: {
    readonly stream: (request: LLMRequest) => Stream.Stream<LLMEvent, LLMError>
  }
  readonly config: readonly Config.Entry[]
}

type Input = {
  readonly sessionID: SessionSchema.ID
  readonly entries: readonly Entry[]
  readonly model: Model
  readonly request: LLMRequest
}

const estimate = (value: unknown) => Token.estimate(JSON.stringify(value))

const truncate = (value: string) =>
  value.length <= TOOL_OUTPUT_MAX_CHARS ? value : `${value.slice(0, TOOL_OUTPUT_MAX_CHARS)}\n[truncated]`

export const serializeToolContent = (content: SessionMessage.ToolStateCompleted["content"]) =>
  content
    .map((item) =>
      item.type === "text" ? item.text : `[Attached ${item.mime}${item.name === undefined ? "" : `: ${item.name}`}]`,
    )
    .join("\n")

const serialize = (message: SessionMessage.Message) => {
  if (message.type === "user") {
    const msg = message as SessionMessage.User
    const files = msg.files?.map((file) => `[Attached ${file.mime}: ${file.name ?? file.uri}]`) ?? []
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
          if (tool.state.status === "completed")
            return [
              `[Assistant tool call]: ${tool.name}(${input})`,
              `[Tool result]: ${truncate(serializeToolContent(tool.state.content))}`,
            ]
          if (tool.state.status === "error")
            return [`[Assistant tool call]: ${tool.name}(${input})`, `[Tool error]: ${tool.state.error.message}`]
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

const settings = (documents: readonly Config.Entry[]) => {
  const configured = documents
    .filter((entry): entry is Config.Document => entry.type === "document")
    .flatMap((entry) => (entry.info.compaction ? [entry.info.compaction] : []))
  return configured.reduce<Settings>(
    (result, current) => ({
      auto: current.auto ?? result.auto,
      buffer: current.buffer ?? result.buffer,
      tokens: current.keep?.tokens ?? result.tokens,
    }),
    { auto: true, buffer: DEFAULT_BUFFER, tokens: DEFAULT_KEEP_TOKENS },
  )
}

const select = (
  entries: readonly Entry[],
  tokens: number,
): { readonly head: string; readonly recent: string } | undefined => {
  const conversation = entries
    .filter((entry) => entry.message.type !== "compaction")
    .map((entry) => serialize(entry.message))
    .filter(Boolean)
  if (conversation.length === 0) return
  let total = 0
  let split = conversation.length
  let splitPrefix = ""
  let splitSuffix = ""
  for (let index = conversation.length - 1; index >= 0; index--) {
    const next = total + Token.estimate(conversation[index])
    if (next > tokens) {
      const remaining = Math.max(0, tokens - total) * 4
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

export const buildPrompt = (input: { readonly previousSummary?: string; readonly context: readonly string[] }) =>
  [
    input.previousSummary
      ? `Update the anchored summary below using the conversation history above.\nPreserve still-true details, remove stale details, and merge in the new facts.\n<previous-summary>\n${input.previousSummary}\n</previous-summary>`
      : "Create a new anchored summary from the conversation history.",
    SUMMARY_TEMPLATE,
    ...input.context,
  ].join("\n\n")

/**
 * Compute the current context fill percentage based on token usage.
 * Returns a number between 0 and 100.
 */
function computeContextFillPercent(
  request: LLMRequest,
  model: Model,
): number {
  const context = model.route.defaults.limits?.context
  if (context === undefined || context <= 0) return 0
  const totalTokens = estimate({
    system: request.system,
    messages: request.messages,
    tools: request.tools,
  })
  return Math.floor((totalTokens / context) * 100)
}

/**
 * Determine which 10% checkpoint we're at.
 * Returns the threshold (10, 20, 30, ...) or 0 if below first threshold.
 */
function currentCheckpointThreshold(fillPercent: number): number {
  return Math.floor(fillPercent / CHECKPOINT_INTERVAL_PERCENT) * CHECKPOINT_INTERVAL_PERCENT
}

export const make = (dependencies: Dependencies) => {
  const config = settings(dependencies.config)
  const checkpointState = new Map<SessionSchema.ID, number>()

  const compactAfterOverflow = Effect.fn("SessionCompaction.compactAfterOverflow")(function* (input: Input) {
    const context = input.model.route.defaults.limits?.context
    if (context === undefined || context <= 0) return false
    const output = input.request.generation?.maxTokens ?? input.model.route.defaults.limits?.output ?? 0

    // Check if a checkpoint exists and use it for rebuild
    const checkpoint = yield* Effect.tryPromise({
      try: () => loadCheckpoint(input.sessionID),
      catch: () => undefined,
    }).pipe(Effect.catch(() => Effect.succeed(undefined)))

    if (checkpoint) {
      // Use checkpoint-based rebuild instead of LLM summary
      const messages = input.entries.map((e) => e.message)
      const selected = select(input.entries, config.tokens)
      if (!selected) return false

      const rebuildContext = buildRebuildContext(checkpoint, messages, {
        recentTokens: config.tokens,
      })

      if (!rebuildContext) return false

      const messageID = SessionMessage.ID.create()
      yield* dependencies.events.publish(SessionEvent.Compaction.Started, {
        sessionID: input.sessionID,
        messageID,
        timestamp: yield* DateTime.now,
        reason: "auto",
      })

      // Emit the rebuild context as the compaction summary
      yield* dependencies.events.publish(SessionEvent.Compaction.Ended, {
        sessionID: input.sessionID,
        messageID,
        timestamp: yield* DateTime.now,
        reason: "auto",
        text: rebuildContext,
        recent: selected.recent,
      })
      return true
    }

    // Fallback to LLM-based summarization
    const selected = select(input.entries, config.tokens)
    const previousSummary = input.entries.find((entry) => entry.message.type === "compaction")?.message
    if (!selected || (selected.head.length === 0 && previousSummary?.type !== "compaction")) return false
    const summaryPrompt = buildPrompt({
      previousSummary: previousSummary?.type === "compaction" ? previousSummary.summary : undefined,
      context: [previousSummary?.type === "compaction" ? previousSummary.recent : "", selected.head].filter(Boolean),
    })
    const summaryOutput = Math.min(output || SUMMARY_OUTPUT_TOKENS, SUMMARY_OUTPUT_TOKENS)
    if (Token.estimate(summaryPrompt) > context - summaryOutput) return false
    const messageID = SessionMessage.ID.create()
    yield* dependencies.events.publish(SessionEvent.Compaction.Started, {
      sessionID: input.sessionID,
      messageID,
      timestamp: yield* DateTime.now,
      reason: "auto",
    })

    const chunks: string[] = []
    let failed = false
    const summarized = yield* dependencies.llm
      .stream(
        LLM.request({
          model: input.model,
          messages: [Message.user(summaryPrompt)],
          tools: [],
          generation: { maxTokens: summaryOutput },
        }),
      )
      .pipe(
        Stream.runForEach((event) => {
          if (LLMEvent.is.providerError(event)) failed = true
          if (LLMEvent.is.textDelta(event)) chunks.push(event.text)
          return Effect.void
        }),
        Effect.as(true),
        Effect.catchTag("LLM.Error", () => Effect.succeed(false)),
      )
    const summary = chunks.join("")
    if (!summarized || failed || !summary.trim()) return false
    yield* dependencies.events.publish(SessionEvent.Compaction.Ended, {
      sessionID: input.sessionID,
      messageID,
      timestamp: yield* DateTime.now,
      reason: "auto",
      text: summary,
      recent: selected.recent,
    })
    return true
  })

  const compactIfNeeded = Effect.fn("SessionCompaction.compactIfNeeded")(function* (input: Input) {
    if (!config.auto) return false
    const context = input.model.route.defaults.limits?.context
    if (context === undefined || context <= 0) return false
    const output = input.request.generation?.maxTokens ?? input.model.route.defaults.limits?.output ?? 0

    // Check context fill and maybe write checkpoint
    const lastPercent = checkpointState.get(input.sessionID) ?? 0
    const fillPercent = computeContextFillPercent(input.request, input.model)
    const threshold = currentCheckpointThreshold(fillPercent)

    if (threshold > lastPercent && input.entries.length > 0) {
      // Write checkpoint (non-blocking via fork)
      const messages = input.entries.map((e) => e.message)
      yield* Effect.tryPromise({
        try: async () => {
          await writeCheckpoint(input.sessionID, messages)
          checkpointState.set(input.sessionID, threshold)
        },
        catch: () => undefined,
      }).pipe(Effect.catch(() => Effect.succeed(undefined)))
    }

    if (
      estimate({ system: input.request.system, messages: input.request.messages, tools: input.request.tools }) <=
      context - Math.max(output, config.buffer)
    )
      return false
    return yield* compactAfterOverflow(input)
  })

  return {
    compactIfNeeded,
    compactAfterOverflow,
  }
}
