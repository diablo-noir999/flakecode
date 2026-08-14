import type { Plugin } from "@opencode-ai/plugin"
import { platform } from "os"
import { execFileSync } from "child_process"

interface NotifyConfig {
  enabled: boolean
  quietHours?: { start: string; end: string }
  showMessage?: boolean
  maxMessageLength?: number
}

const EVENT_FORMAT: Record<string, { icon: string; titlePrefix: string }> = {
  "session.idle": { icon: "\u2705", titlePrefix: "Ready" },
  "session.error": { icon: "\u274C", titlePrefix: "Error" },
  "permission.asked": { icon: "\uD83D\uDD12", titlePrefix: "Permission" },
  "question.asked": { icon: "\u2753", titlePrefix: "Question" },
}

function truncate(text: string, maxLen: number): string {
  if (!text || typeof text !== "string") return ""
  const cleaned = text.replace(/\s+/g, " ").trim()
  if (cleaned.length <= maxLen) return cleaned
  return cleaned.slice(0, maxLen - 3) + "..."
}

function isQuietHours(quietHours: { start: string; end: string }): boolean {
  const now = new Date()
  const currentMinutes = now.getHours() * 60 + now.getMinutes()
  const [startH, startM] = quietHours.start.split(":").map(Number)
  const [endH, endM] = quietHours.end.split(":").map(Number)
  const startMinutes = startH * 60 + startM
  const endMinutes = endH * 60 + endM

  if (startMinutes <= endMinutes) {
    return currentMinutes >= startMinutes && currentMinutes < endMinutes
  }
  return currentMinutes >= startMinutes || currentMinutes < endMinutes
}

function escapeAppleScript(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')
}

function escapePowerShell(s: string): string {
  return s.replace(/'/g, "''")
}

async function sendNativeNotification(title: string, body: string): Promise<void> {
  const os = platform()

  try {
    if (os === "darwin") {
      try {
        execFileSync("alerter", ["-title", title, "-message", body, "-ignoreProfile"], {
          timeout: 5000,
          stdio: "ignore",
        })
      } catch {
        execFileSync(
          "osascript",
          ["-e", `display notification "${escapeAppleScript(body)}" with title "${escapeAppleScript(title)}" sound name "default"`],
          { timeout: 5000, stdio: "ignore" }
        )
      }
    } else if (os === "linux") {
      execFileSync("notify-send", ["-u", "normal", title, body], {
        timeout: 5000,
        stdio: "ignore",
      })
    } else if (os === "win32") {
      execFileSync(
        "powershell",
        ["-Command", `New-BurntToastNotification -Text '${escapePowerShell(title)}','${escapePowerShell(body)}'`],
        { timeout: 5000, stdio: "ignore" }
      )
    }
  } catch {
    // Notification failed silently
  }
}

function buildBody(event: any, eventType: string, showMessage: boolean, maxLen: number): string {
  const parts: string[] = []

  switch (eventType) {
    case "session.idle": {
      parts.push("Ready for review")
      if (showMessage && event?.properties?.lastMessage) {
        parts.push(`\n${truncate(event.properties.lastMessage, maxLen)}`)
      }
      break
    }
    case "session.error": {
      const errObj = event?.properties?.error
      const errMsg = typeof errObj === "string" ? errObj : errObj?.message ?? "Unknown error"
      parts.push(truncate(String(errMsg), maxLen))
      break
    }
    case "permission.asked": {
      parts.push("Permission needed")
      if (showMessage && event?.properties?.permission) {
        parts.push(`\nPermission: ${event.properties.permission}`)
      }
      if (showMessage && event?.properties?.metadata) {
        const meta = event.properties.metadata
        if (meta.description) parts.push(`\n${truncate(String(meta.description), maxLen)}`)
      }
      break
    }
    case "question.asked": {
      parts.push("Your input needed")
      const questions = event?.properties?.questions
      if (showMessage && questions?.length > 0) {
        parts.push(`\n${truncate(questions[0].question ?? "", maxLen)}`)
      }
      break
    }
  }

  if (event?.properties?.sessionID) {
    const shortId = event.properties.sessionID.slice(-8)
    parts.push(`\n[...${shortId}]`)
  }

  return parts.join("")
}

export const NotifyPlugin: Plugin = async (_ctx, options) => {
  const config: NotifyConfig = {
    enabled: (options?.enabled as boolean) ?? true,
    quietHours: options?.quietHours as NotifyConfig["quietHours"],
    showMessage: (options?.showMessage as boolean) ?? true,
    maxMessageLength: (options?.maxMessageLength as number) ?? 100,
  }

  return {
    event: async ({ event }) => {
      if (!config.enabled) return
      if (config.quietHours && isQuietHours(config.quietHours)) return

      const format = EVENT_FORMAT[event.type]
      if (!format) return

      const title = `${format.icon} ${format.titlePrefix}`
      const body = buildBody(event, event.type, config.showMessage !== false, config.maxMessageLength ?? 100)

      await sendNativeNotification(title, body)
    },
  }
}

export default NotifyPlugin
