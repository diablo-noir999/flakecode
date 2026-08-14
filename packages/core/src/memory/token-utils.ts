/**
 * Token Estimation Utilities
 *
 * Shared helpers for rough token counting used by smart-drops and
 * context-analysis. Consolidates the duplicated estimateMessageTokens /
 * estimateTokens logic into a single source of truth.
 */

const CHARS_PER_TOKEN_ESTIMATE = 4;

import { isRecord } from "./message-utils"

/**
 * Estimate the number of tokens in a text string.
 * Uses the simple heuristic: 1 token ≈ CHARS_PER_TOKEN_ESTIMATE characters.
 */
export function estimateTextTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN_ESTIMATE)
}

/**
 * Estimate the total tokens consumed by a message.
 *
 * Handles both flat `content` strings and the `parts[]` array format
 * used by the SDK. Returns 0 for messages with no recognisable content.
 */
export function estimateMessageTokens(message: any): number {
  // Flat string content
  if (typeof message.content === "string") {
    return estimateTextTokens(message.content)
  }

  // Parts-based format (SDK messages)
  if (Array.isArray(message.parts)) {
    let total = 0
    for (const part of message.parts) {
      if (!isRecord(part)) continue
      if (typeof part.text === "string") total += estimateTextTokens(part.text)
      if (typeof part.thinking === "string") total += estimateTextTokens(part.thinking)
      if (isRecord(part.state) && typeof part.state.output === "string") {
        total += estimateTextTokens(part.state.output)
      }
      if (typeof part.content === "string") total += estimateTextTokens(part.content)
    }
    return total
  }

  return 0
}
