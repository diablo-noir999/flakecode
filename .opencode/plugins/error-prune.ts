import type { Plugin } from "@opencode-ai/plugin"

const MAX_ERROR_CONTENT_LENGTH = 500
const DEFAULT_TURNS_BEFORE_PRUNE = 4

export const ErrorPrunePlugin: Plugin = async (_ctx, options) => {
  const turnsBeforePrune = (options?.turnsBeforePrune as number) ?? DEFAULT_TURNS_BEFORE_PRUNE

  return {
    "experimental.chat.messages.transform": async (_input, output) => {
      const messages = output.messages
      if (!messages.length) return

      let lastUserIndex = -1
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].info?.role === "user") {
          lastUserIndex = i
          break
        }
      }

      if (lastUserIndex === -1) return

      const userCountBefore: number[] = new Array(messages.length + 1)
      userCountBefore[0] = 0
      for (let i = 0; i < messages.length; i++) {
        userCountBefore[i + 1] = userCountBefore[i] + (messages[i].info?.role === "user" ? 1 : 0)
      }

      for (let i = 0; i < messages.length; i++) {
        const msg = messages[i]
        if (msg.info?.role !== "assistant") continue
        if (!Array.isArray(msg.parts)) continue

        for (const part of msg.parts) {
          if (part?.type !== "tool") continue
          if (part.state?.status !== "error") continue

          const turnsSince = userCountBefore[lastUserIndex + 1] - userCountBefore[i + 1]
          if (turnsSince < turnsBeforePrune) continue

          const errorMsg = (part.state.error ?? "[Error]").slice(0, MAX_ERROR_CONTENT_LENGTH)
          part.state.input = {}
          part.state.error = `${errorMsg}\n\n[Input content pruned after ${turnsSince} turns to save tokens]`
        }
      }
    },
  }
}

export default ErrorPrunePlugin
