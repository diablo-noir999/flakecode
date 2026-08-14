import type { InboxRow } from "./inbox.sql"

function blankTo(text: string | undefined, placeholder: string) {
  return text !== undefined && text.trim().length > 0 ? text : placeholder
}

export function renderInboxRow(row: InboxRow): string {
  if (row.type === "actor_notification") {
    const content = row.content as { text?: string }
    return blankTo(content.text, "(no notification body)")
  }
  const content = row.content as { text?: string }
  const sender = row.sender_session_id
    ? `${row.sender_session_id}:${row.sender_actor_id ?? "?"}`
    : "system"
  const sentAt = new Date(row.created_at).toISOString()
  return `<inbox from="${sender}" sent_at="${sentAt}">\n${blankTo(content.text, "(empty)")}\n</inbox>`
}

export function renderActorNotification(event: {
  actorID: string
  description: string
  status: "completed" | "failed" | "cancelled" | "stalled"
  result?: string
  error?: string
  reportedStatus?: string
  reportedSummary?: string
  stalledForMs?: number
}): string {
  const header = `Background sub-session "${event.description}" (actor_id: ${event.actorID})`
  if (event.status === "completed") {
    const reported = event.reportedStatus?.toLowerCase()
    const summaryLine = event.reportedSummary ? `\nSummary: ${event.reportedSummary}` : ""
    const resultLine = `\nResult: ${event.result ?? "(no output)"}`
    if (!reported || reported === "success" || reported === "partial") {
      const statusLine = reported ? `\nStatus: ${reported}` : ""
      return `<actor-notification>\n${header} completed.${statusLine}${summaryLine}${resultLine}\n</actor-notification>`
    }
    if (reported === "failed" || reported === "blocked") {
      return `<actor-notification>\n${header} finished (status: ${reported}).${summaryLine}${resultLine}\n</actor-notification>`
    }
    return `<actor-notification>\n${header} ended (status not reported).${summaryLine}${resultLine}\n</actor-notification>`
  }
  if (event.status === "failed") {
    return `<actor-notification>\n${header} failed.\nError: ${event.error ?? "unknown"}\n</actor-notification>`
  }
  if (event.status === "stalled") {
    const forLine =
      event.stalledForMs !== undefined ? ` (no activity for ${Math.floor(event.stalledForMs / 1000)}s)` : ""
    return `<actor-notification>\n${header} appears stalled${forLine}. It is still running, but nothing has landed for it in that time. Consider checking on it, sending it a nudge, or cancelling it.\n</actor-notification>`
  }
  return `<actor-notification>\n${header} was cancelled.\n</actor-notification>`
}

export type ParsedActorNotification = {
  status: "completed" | "failed" | "cancelled" | "stalled" | "ended"
  description: string
  summary?: string
}

export function parseActorNotification(text: string): ParsedActorNotification | null {
  if (!text.trimStart().startsWith("<actor-notification>")) return null
  const header = text.match(
    /Background (?:sub-session|actor) "(.*?)" \(actor_id: [^)]*\)\s+(completed|finished|ended|failed|was cancelled|stalled)\b/,
  )
  if (!header) return null
  const description = header[1]
  const verb = header[2]
  const status: ParsedActorNotification["status"] =
    verb === "completed"
      ? "completed"
      : verb === "finished" || verb === "failed"
        ? "failed"
        : verb === "ended"
          ? "ended"
          : verb === "stalled"
            ? "stalled"
            : "cancelled"
  const resultIdx = text.search(/^Result:/m)
  const beforeResult = resultIdx === -1 ? text : text.slice(0, resultIdx)
  const line = (label: string, scope: string) => scope.match(new RegExp(`^${label}:\\s*(.+)$`, "m"))?.[1]?.trim()
  const summary = line("Summary", beforeResult) ?? line("Result", text) ?? line("Error", text)
  return summary ? { status, description, summary } : { status, description }
}
