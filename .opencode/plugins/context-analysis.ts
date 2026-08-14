import type { Plugin } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"
import { estimateTextTokens } from "@opencode-ai/core/memory/token-utils"

export function createContextAnalysisTool(ctx: any) {
  return tool({
    description: "Analyze token usage breakdown for the current session. Shows per-category and per-tool token consumption with visual charts.",
    args: {
      detail: tool.schema
        .string()
        .optional()
        .describe("Level of detail: standard (default), detailed, or short"),
      limitMessages: tool.schema
        .number()
        .optional()
        .describe("Limit analysis to last N messages"),
    },
    async execute(args, context) {
      const detail = args.detail ?? "standard"
      const limit = args.limitMessages ?? 100

      const client = ctx.client
      if (!client) {
        return "Error: No client available to fetch session messages."
      }

      try {
        const result = await client.session.messages({
          path: { id: context.sessionID },
          query: { directory: context.directory, limit },
        })

        if (result?.error) {
          return `Error fetching messages: ${JSON.stringify(result.error)}`
        }

        const rawMessages = result?.data
        if (!rawMessages || !Array.isArray(rawMessages) || rawMessages.length === 0) {
          return "No messages in session yet."
        }

        const messages = rawMessages.map((m: any) => ({
          role: m.info?.role ?? "unknown",
          content: m.parts?.map((p: any) => p.text ?? "").join("") ?? "",
          reasoning: m.info?.reasoning,
          name: m.info?.name ?? m.parts?.[0]?.toolName,
          tool: m.parts?.[0]?.toolName,
        }))

        const recentMessages = messages.slice(-limit)
        const analysis = analyzeMessages(recentMessages)

        return formatAnalysis(analysis, detail)
      } catch (error) {
        return `Error analyzing context: ${error instanceof Error ? error.message : String(error)}`
      }
    },
  })
}

interface TokenCategory {
  name: string
  tokens: number
  count: number
}

interface ToolUsage {
  name: string
  tokens: number
  calls: number
}

interface AnalysisResult {
  totalTokens: number
  categories: TokenCategory[]
  tools: ToolUsage[]
  messageCount: number
}

function analyzeMessages(messages: any[]): AnalysisResult {
  const categories: Record<string, TokenCategory> = {
    system: { name: "System", tokens: 0, count: 0 },
    user: { name: "User", tokens: 0, count: 0 },
    assistant: { name: "Assistant", tokens: 0, count: 0 },
    tools: { name: "Tools", tokens: 0, count: 0 },
    reasoning: { name: "Reasoning", tokens: 0, count: 0 },
  }

  const tools: Record<string, ToolUsage> = {}
  let totalTokens = 0

  for (const msg of messages) {
    const role = msg.role ?? "unknown"
    const tokens = estimateTokens(msg)

    if (role === "system") {
      categories.system.tokens += tokens
      categories.system.count++
    } else if (role === "user") {
      categories.user.tokens += tokens
      categories.user.count++
    } else if (role === "assistant") {
      categories.assistant.tokens += tokens
      categories.assistant.count++

      if (msg.reasoning) {
        const reasoningTokens = estimateTextTokens(msg.reasoning)
        categories.reasoning.tokens += reasoningTokens
        categories.reasoning.count++
        totalTokens += reasoningTokens
      }
    } else if (role === "tool") {
      categories.tools.tokens += tokens
      categories.tools.count++

      const toolName = msg.name ?? msg.tool ?? "unknown"
      if (!tools[toolName]) {
        tools[toolName] = { name: toolName, tokens: 0, calls: 0 }
      }
      tools[toolName].tokens += tokens
      tools[toolName].calls++
    }

    totalTokens += tokens
  }

  return {
    totalTokens,
    categories: Object.values(categories),
    tools: Object.values(tools).sort((a, b) => b.tokens - a.tokens),
    messageCount: messages.length,
  }
}

function estimateTokens(msg: any): number {
  const content = typeof msg.content === "string"
    ? msg.content
    : JSON.stringify(msg.content ?? "")
  return estimateTextTokens(content)
}

function formatAnalysis(analysis: AnalysisResult, detail: string): string {
  const lines: string[] = []
  const maxBarWidth = 30

  lines.push("## Context Analysis")
  lines.push(`**Total tokens:** ~${analysis.totalTokens.toLocaleString()}`)
  lines.push(`**Messages:** ${analysis.messageCount}`)
  lines.push("")

  lines.push("### Token Usage by Category")
  lines.push("")

  const maxCatTokens = Math.max(...analysis.categories.map((c) => c.tokens), 1)

  for (const cat of analysis.categories) {
    if (cat.tokens === 0 && cat.count === 0) continue
    const pct = analysis.totalTokens > 0 ? ((cat.tokens / analysis.totalTokens) * 100).toFixed(1) : "0.0"
    const barLen = Math.round((cat.tokens / maxCatTokens) * maxBarWidth)
    const bar = "█".repeat(barLen) + "░".repeat(maxBarWidth - barLen)
    lines.push(`  ${cat.name.padEnd(12)} ${bar} ${pct}% (~${cat.tokens.toLocaleString()} tokens, ${cat.count} msgs)`)
  }

  lines.push("")

  if (analysis.tools.length > 0 && (detail === "detailed" || detail === "standard")) {
    lines.push("### Tool Usage")
    lines.push("")

    const maxToolTokens = Math.max(...analysis.tools.map((t) => t.tokens), 1)
    const toolsToShow = detail === "detailed" ? analysis.tools : analysis.tools.slice(0, 10)

    for (const tool of toolsToShow) {
      const pct = analysis.totalTokens > 0 ? ((tool.tokens / analysis.totalTokens) * 100).toFixed(1) : "0.0"
      const barLen = Math.round((tool.tokens / maxToolTokens) * maxBarWidth)
      const bar = "█".repeat(barLen) + "░".repeat(maxBarWidth - barLen)
      lines.push(`  ${tool.name.padEnd(20)} ${bar} ${pct}% (~${tool.tokens.toLocaleString()} tokens, ${tool.calls} calls)`)
    }

    if (analysis.tools.length > toolsToShow.length) {
      lines.push(`  ... and ${analysis.tools.length - toolsToShow.length} more tools`)
    }
  }

  return lines.join("\n")
}

const plugin: Plugin = async (input) => {
  return {
    tool: {
      context_breakdown: createContextAnalysisTool(input),
    },
  }
}

export default plugin
