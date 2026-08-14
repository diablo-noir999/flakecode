import type { Plugin } from "@opencode-ai/plugin"

const plugin: Plugin = async (input) => {
  return {
    "session.post": async (input, output) => {
      try {
        const projectPath = input?.directory ?? process.cwd()
        const sessionId = input?.sessionID ?? "unknown"
        const messages = input?.messages ?? []
        if (messages.length > 0) {
          const { getMemoryStore } = await import("@opencode-ai/core/memory/store")
          const { getMemoryDbPath } = await import("@opencode-ai/core/memory/types")
          const { captureFromSession } = await import("@opencode-ai/core/memory/hooks")
          const store = getMemoryStore(getMemoryDbPath(projectPath))
          captureFromSession(store, projectPath, sessionId, messages)
        }
        try {
          const { initEmbeddings } = await import("@opencode-ai/core/memory/embeddings")
          const { backfillEmbeddings } = await import("@opencode-ai/core/memory/search")
          const { getMemoryStore } = await import("@opencode-ai/core/memory/store")
          const { getMemoryDbPath } = await import("@opencode-ai/core/memory/types")
          const store = getMemoryStore(getMemoryDbPath(projectPath))
          const model = "onnx-community/granite-embedding-small-english-r2-ONNX"
          const ready = await initEmbeddings(model)
          if (ready) {
            await backfillEmbeddings(store, projectPath, model)
          }
        } catch {
          // Embeddings are optional
        }
      } catch (err) {
        console.debug("[powerpack] Memory auto-capture failed:", err instanceof Error ? err.message : err)
      }
    }
  }
}

export default plugin
