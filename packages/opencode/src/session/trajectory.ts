import {
  type FilePart,
  type ToolPart,
  type Part,
  type Assistant,
  type TextPart,
  type WithParts,
} from "@opencode-ai/core/v1/session"

/** Minimal trajectory wire format types (matching the plugin schema). */
export interface TrajectoryPart {
  readonly type: string
  readonly [key: string]: unknown
}

export interface TrajectoryMessage {
  readonly id: string
  readonly role: string
  readonly created: number
  readonly parts: readonly TrajectoryPart[]
  readonly [key: string]: unknown
}

/**
 * Replace `data:` URLs in file parts with a compact summary tag, leaving
 * non-data URLs (file paths, http(s) attachments) untouched. Keeps the
 * trajectory JSON-safe without exploding payload size on inline images.
 */
function fileUrlSummary(url: string, mime: string, filename?: string) {
  if (!url.startsWith("data:")) return url
  return `[data-url:${mime}${filename ? `:${filename}` : ""}]`
}

function serializeFilePart(part: FilePart): FilePart {
  return { ...part, url: fileUrlSummary(part.url, part.mime, part.filename) }
}

/**
 * Strip `data:` URLs from any FilePart attachments inside a tool result.
 * Mutation is shallow — original part is not modified.
 */
function sanitizeToolState(state: ToolPart["state"]): ToolPart["state"] {
  if ("attachments" in state && state.attachments && state.attachments.length > 0) {
    return { ...state, attachments: state.attachments.map(serializeFilePart) }
  }
  return state
}

/**
 * Serialize a Part for the trajectory wire format. Preserves every
 * field the runtime stores (ID, time, metadata, source, raw, attachments,
 * tokens, etc.) — only `data:` URLs are summarized to keep payloads tractable.
 * The result is a structural superset of Part and is safe to
 * round-trip through JSON.
 */
export function serializePart(part: Part): TrajectoryPart {
  if (part.type === "file") return serializeFilePart(part as unknown as FilePart) as unknown as TrajectoryPart
  if (part.type === "tool") return { ...part, state: sanitizeToolState((part as unknown as ToolPart).state) } as unknown as TrajectoryPart
  return part as unknown as TrajectoryPart
}

/** Stringify an assistant error blob (NamedError, AbortedError, etc.) for plugin payloads. */
export function sessionErrorText(error: Assistant["error"]): string | undefined {
  if (!error) return undefined
  if (typeof error === "object" && error !== null && "message" in error && typeof error.message === "string") {
    return error.message
  }
  return JSON.stringify(error)
}

/** Concatenate non-synthetic, non-ignored user text parts (the visible user query). */
export function userQueryText(parts: Part[]): string {
  return parts
    .filter((p): p is TextPart => p.type === "text" && !(p as TextPart).synthetic && !(p as TextPart).ignored)
    .map((p) => (p as TextPart).text)
    .join("\n")
}

/** Last non-synthetic assistant text, or stringified structured output if present. */
export function assistantFinalText(message: Assistant, parts: Part[]): string | undefined {
  if (message.structured !== undefined) return JSON.stringify(message.structured)
  return parts.findLast((p): p is TextPart => p.type === "text" && !(p as TextPart).synthetic)?.text
}

/**
 * Serialize a slice of session messages into the wire trajectory format.
 *
 * Field-level fidelity:
 * - Spreads the full info (model, tools, format, tokens, cost,
 *   modelID, providerID, agent, agentID, error, finish, structured, summary,
 *   provenance, path, parentID, mode, variant, …) so a consumer can replay
 *   the conversation exactly as the runtime saw it.
 * - Spreads the full Part (PartID, time, metadata, source, raw,
 *   attachments, tokens, snapshot, …) for every part type — including unknown
 *   future types — without dropping fields.
 *
 * Slice-level fidelity is the caller's responsibility: pass the same slice the
 * agent actually saw (e.g. via filterCompactedEffect with the
 * session's contextFrom/contextWatermark) for replay parity.
 */
export function serializeTrajectoryMessages(msgs: WithParts[]): TrajectoryMessage[] {
  return msgs.map((msg) => ({
    ...msg.info,
    created: msg.info.time.created,
    parts: msg.parts.map(serializePart),
  })) as unknown as TrajectoryMessage[]
}

/** Replace the assistant entry in a message slice with freshly loaded parts. */
export function withAssistantParts(
  msgs: WithParts[],
  assistant: Assistant,
  parts: Part[],
): WithParts[] {
  const idx = msgs.findIndex((m) => m.info.id === assistant.id)
  if (idx === -1) return [...msgs, { info: assistant, parts }]
  return msgs.map((m, i) => (i === idx ? { info: assistant, parts } : m))
}
