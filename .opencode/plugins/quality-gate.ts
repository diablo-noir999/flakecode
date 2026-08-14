import type { Plugin } from "@opencode-ai/plugin"
import { execFile } from "child_process"

interface QualityGateCommand {
  name: string
  cmd: string
  timeout?: number
}

const DEFAULT_COMMANDS: QualityGateCommand[] = [
  { name: "typecheck", cmd: "bun run typecheck", timeout: 30000 },
  { name: "test", cmd: "bun test", timeout: 60000 },
]

const GIT_STATUS_TIMEOUT_MS = 5000

export const QualityGatePlugin: Plugin = async ({ directory }, options) => {
  const commands = (options?.commands as QualityGateCommand[]) ?? DEFAULT_COMMANDS

  return {
    event: async ({ event }) => {
      if (event.type !== "session.idle") return

      let status: string
      try {
        status = await new Promise<string>((resolve, reject) => {
          execFile("git", ["status", "--porcelain"], { cwd: directory, timeout: GIT_STATUS_TIMEOUT_MS }, (err, stdout) => {
            if (err) reject(err)
            else resolve(stdout.toString().trim())
          })
        })
      } catch {
        return
      }
      if (!status) return

      const runCommand = async ({ name, cmd, timeout }: QualityGateCommand): Promise<string> => {
        if (/[;&|`$(){}!<>]/.test(cmd)) {
          return `${name}: SKIPPED (unsafe command)`
        }
        const parts = cmd.split(/\s+/).filter(Boolean)
        return new Promise<string>((resolve) => {
          execFile(parts[0], parts.slice(1), { cwd: directory, timeout }, (err, _stdout, stderr) => {
            if (err) {
              const lastLines = (stderr?.toString() || "").split("\n").slice(-10).join("\n")
              resolve(`${name}: FAIL` + (lastLines ? `\n   ${lastLines}` : ""))
            } else {
              resolve(`${name}: PASS`)
            }
          })
        })
      }

      const results = await Promise.all(commands.map(runCommand))
      const allPassed = results.every(r => r.includes("PASS") || r.includes("SKIPPED"))

      if (allPassed) return

      const summary = results.join("\n")
      throw new Error(`Quality gate failed:\n${summary}\n\nFix the issues above before completing.`)
    },
  }
}

export default QualityGatePlugin
