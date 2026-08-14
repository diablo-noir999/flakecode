import type { Plugin } from "@opencode-ai/plugin"

export const DedupPrunePlugin: Plugin = async () => {
  return {
    "experimental.chat.messages.transform": async (_input, output) => {
      const messages = output.messages
      if (!messages.length) return

      const seen = new Map<string, { msgIdx: number; partIdx: number }>()

      for (let i = 0; i < messages.length; i++) {
        const msg = messages[i]
        if (msg.info?.role !== "assistant") continue
        if (!Array.isArray(msg.parts)) continue

        for (let j = 0; j < msg.parts.length; j++) {
          const part = msg.parts[j]
          if (part?.type !== "tool") continue

          const key = `${part.tool}:${JSON.stringify(part.state?.input ?? {})}`
          let hashVal = 0x811c9dc5
          for (let k = 0; k < key.length; k++) {
            hashVal ^= key.charCodeAt(k)
            hashVal = (hashVal * 0x01000193) | 0
          }
          const hash = (hashVal >>> 0).toString(36)

          if (seen.has(hash)) {
            const older = seen.get(hash)!
            const olderMsg = messages[older.msgIdx]
            if (olderMsg && olderMsg.parts[older.partIdx]) {
              const olderPart = olderMsg.parts[older.partIdx]
              if (olderPart?.type === "tool" && olderPart.state?.status === "completed") {
                olderPart.state.input = {}
                olderPart.state.output = "[Duplicate tool output pruned]"
              }
            }
            seen.set(hash, { msgIdx: i, partIdx: j })
          } else {
            seen.set(hash, { msgIdx: i, partIdx: j })
          }
        }
      }
    },
  }
}

export default DedupPrunePlugin
