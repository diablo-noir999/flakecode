import type { Plugin } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"
import { getMemoryStore } from "@opencode-ai/core/memory/store"
import { searchMemories, type SearchMode } from "@opencode-ai/core/memory/search"
import { isEmbeddingsReady } from "@opencode-ai/core/memory/embeddings"
import { getMemoryDbPath } from "@opencode-ai/core/memory/types"
import { captureMemory } from "@opencode-ai/core/memory/hooks"
import type { MemoryCategory } from "@opencode-ai/core/memory/types"
import { MEMORY_CATEGORIES } from "@opencode-ai/core/memory/types"

const resolveProjectPath = (ctx: any) => ctx?.directory ?? process.cwd()

function createMemorySearchTool(ctx: any) {
  return tool({
    description:
      "Search project memories using vector embeddings + BM25 (hybrid), semantic-only, FTS-only, or TF-IDF. Returns ranked results with scores.",
    args: {
      query: tool.schema.string().describe("Search query (supports natural language or keywords)"),
      limit: tool.schema
        .number()
        .optional()
        .describe("Max results to return (default: 10)"),
      category: tool.schema
        .string()
        .optional()
        .describe(
          "Filter by category: PROJECT_RULES, ARCHITECTURE, CONSTRAINTS, CONFIG_VALUES, NAMING, LESSONS_LEARNED, BUG_FIXES, USER_PREFERENCES",
        ),
      mode: tool.schema
        .string()
        .optional()
        .describe(
          "Search mode: hybrid (default, vector+BM25), semantic (vector-only, requires embeddings), fts (BM25-only), tfidf (TF-IDF cosine only)",
        ),
    },
    async execute(args, context) {
      const projectPath = resolveProjectPath(context)
      const store = getMemoryStore(getMemoryDbPath(projectPath))

      let mode: SearchMode = "hybrid"
      if (args.mode && ["hybrid", "semantic", "fts", "tfidf"].includes(args.mode)) {
        mode = args.mode as SearchMode
      }

      if ((mode === "hybrid" || mode === "semantic") && !isEmbeddingsReady()) {
        mode = "fts"
      }

      let results = await searchMemories(store, projectPath, args.query, args.limit ?? 10, mode)

      if (args.category) {
        results = results.filter((r) => r.memory.category === args.category)
      }

      if (results.length === 0) {
        return `No memories found for query: "${args.query}" (mode: ${mode})`
      }

      const lines = [`## Memory Search Results (${results.length}, mode: ${mode})\n`]

      for (const result of results) {
        const m = result.memory
        const score = result.score.toFixed(3)
        const matchType = result.matchType
        const age = formatAge(m.createdAt)
        const retrieved = m.retrievalCount > 0 ? `retrieved ${m.retrievalCount}x` : "never retrieved"

        lines.push(`### [${m.category}] (score: ${score}, ${matchType})`)
        lines.push(m.content)
        lines.push(`_id:${m.id} | importance:${m.importance} | age:${age} | ${retrieved}_\n`)
      }

      return lines.join("\n")
    },
  })
}

function formatAge(timestamp: number): string {
  const ms = Date.now() - timestamp
  const days = Math.floor(ms / (1000 * 60 * 60 * 24))
  if (days === 0) return "today"
  if (days === 1) return "1d ago"
  if (days < 30) return `${days}d ago`
  const months = Math.floor(days / 30)
  return `${months}mo ago`
}

function createMemoryWriteTool(ctx: any) {
  return tool({
    description:
      "Write a memory to the project memory store. Deduplicates by normalized hash. Categories: PROJECT_RULES, ARCHITECTURE, CONSTRAINTS, CONFIG_VALUES, NAMING, LESSONS_LEARNED, BUG_FIXES, USER_PREFERENCES.",
    args: {
      content: tool.schema
        .string()
        .describe("Memory content to store (technical decisions, rules, lessons, etc.)"),
      category: tool.schema
        .string()
        .optional()
        .describe(
          `Memory category. Options: ${MEMORY_CATEGORIES.join(", ")}. If omitted, auto-detected from content.`,
        ),
      importance: tool.schema
        .number()
        .optional()
        .describe("Importance score 1-100 (default: 50). Higher = decays slower."),
    },
    async execute(args, context) {
      const projectPath = resolveProjectPath(context)
      const store = getMemoryStore(getMemoryDbPath(projectPath))

      const category = args.category as MemoryCategory | undefined
      if (category && !MEMORY_CATEGORIES.includes(category)) {
        return `Invalid category "${category}". Valid categories: ${MEMORY_CATEGORIES.join(", ")}`
      }

      const result = captureMemory(store, projectPath, args.content, {
        category,
        importance: args.importance,
        sourceSessionId: context.sessionID,
        sourceType: "manual",
      })

      if (!result.success) {
        return "Failed to capture memory. Content may be too short, too long, or not technical enough."
      }

      if (result.duplicate) {
        return `Memory already exists (id:${result.memoryId}). Seen count incremented.`
      }

      if (result.memoryId == null) {
        return "Memory saved but ID unavailable."
      }
      const memory = store.getById(result.memoryId)
      return `Memory saved (id:${result.memoryId}, category:${memory?.category ?? "auto"})`
    },
  })
}

const plugin: Plugin = async (input) => {
  return {
    tool: {
      memory_search: createMemorySearchTool(input),
      memory_write: createMemoryWriteTool(input),
    },
  }
}

export default plugin
