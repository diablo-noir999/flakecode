// Token-efficient post-cleanse pipeline for bash tool output.
//
// Architecture: a Pipeline composed from CleanPlugin instances via a factory.
// Each plugin is a single pass over the text; `createPipeline` chains them and
// wraps the chain with a never-worse guard (if the cleaned output isn't
// strictly shorter than the original, the original is returned unchanged).

const MAX_LINE_CHARS = parseInt(process.env.MIMOCODE_EXPERIMENTAL_TOKEN_EFFICIENCY_MAX_LINE_CHARS ?? "500", 10)
const LINE_HEAD_KEEP = parseInt(process.env.MIMOCODE_EXPERIMENTAL_TOKEN_EFFICIENCY_LINE_HEAD_KEEP ?? "160", 10)
const NEVER_WORSE_MARGIN = parseInt(process.env.MIMOCODE_EXPERIMENTAL_TOKEN_EFFICIENCY_NEVER_WORSE_MARGIN ?? "0", 10)

const ANSI_CSI = /\x1b\[[0-?]*[ -/]*[@-~]/g
const ANSI_OSC = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g
const ANSI_DCS = /\x1b[PX^_][\s\S]*?\x1b\\/g
const BACKSPACE = /[^\n]\x08/g
const CTRL_BYTES = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g

const REDACT_PATTERNS: Array<[RegExp, string]> = [
  [/\b(Bearer|Token)\s+[A-Za-z0-9._\-+/=]{16,}/gi, "$1 <redacted>"],
  [/\beyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}/g, "<redacted-jwt>"],
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, "<redacted-aws-key>"],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, "<redacted-gh-token>"],
  [/\bsk-[A-Za-z0-9_\-]{20,}\b/g, "<redacted-openai-key>"],
  [/\bsk-ant-[A-Za-z0-9_\-]{20,}\b/g, "<redacted-anthropic-key>"],
  [/\bxox[abprs]-[A-Za-z0-9\-]{10,}\b/g, "<redacted-slack-token>"],
  [
    /\b((?:api|access|refresh|secret|client|auth)[_-]?(?:key|token|secret|password))(\s*[:=]\s*)["']?[A-Za-z0-9._\-+/=]{12,}["']?/gi,
    "$1$2<redacted>",
  ],
]

const PEM_BLOCK = /-----BEGIN [A-Z ]+-----[\s\S]*?-----END [A-Z ]+-----/g

const SKIP_MARKERS = ["# nofilter", "# raw"]

export type CleanOptions = {
  command?: string
}

export type CleanResult = {
  text: string
  bytesIn: number
  bytesOut: number
  degraded: boolean
}

export type CleanPlugin = {
  name: string
  apply: (text: string, ctx: CleanOptions) => string
}

export type CleanPipeline = {
  plugins: ReadonlyArray<CleanPlugin>
  run: (text: string, options?: CleanOptions) => CleanResult
}

function shouldSkip(command: string | undefined): boolean {
  if (process.env["MIMOCODE_BASH_RAW"] === "1") return true
  if (!command) return false
  return SKIP_MARKERS.some((mark) => command.includes(mark))
}

export const progressPlugin = (): CleanPlugin => ({
  name: "progress",
  apply(text) {
    if (!text.includes("\r")) return text
    return text
      .split("\n")
      .map((line) => {
        const stripped = line.endsWith("\r") ? line.slice(0, -1) : line
        const idx = stripped.lastIndexOf("\r")
        return idx === -1 ? stripped : stripped.slice(idx + 1)
      })
      .join("\n")
  },
})

export const ansiPlugin = (): CleanPlugin => ({
  name: "ansi",
  apply(text) {
    let out = text.replace(ANSI_CSI, "").replace(ANSI_OSC, "").replace(ANSI_DCS, "")
    while (BACKSPACE.test(out)) out = out.replace(BACKSPACE, "")
    return out.replace(CTRL_BYTES, "")
  },
})

export const redactPlugin = (): CleanPlugin => ({
  name: "redact",
  apply(text) {
    return REDACT_PATTERNS.reduce(
      (acc, [pattern, replacement]) => acc.replace(pattern, replacement),
      text.replace(PEM_BLOCK, "<redacted-pem-block>"),
    )
  },
})

export const longLinePlugin = (): CleanPlugin => ({
  name: "longline",
  apply(text) {
    if (text.length <= MAX_LINE_CHARS) return text
    return text
      .split("\n")
      .map((line) => {
        if (line.length <= MAX_LINE_CHARS) return line
        return `${line.slice(0, LINE_HEAD_KEEP)}…<elided ${line.length - LINE_HEAD_KEEP} chars>`
      })
      .join("\n")
  },
})

export const defaultPlugins = (): CleanPlugin[] => [
  progressPlugin(),
  ansiPlugin(),
  redactPlugin(),
  longLinePlugin(),
]

export const createPipeline = (plugins: CleanPlugin[] = defaultPlugins()): CleanPipeline => ({
  plugins,
  run(text, options = {}) {
    const bytesIn = Buffer.byteLength(text, "utf-8")
    if (!text || shouldSkip(options.command)) {
      return { text, bytesIn, bytesOut: bytesIn, degraded: false }
    }
    const out = plugins.reduce((acc, plugin) => plugin.apply(acc, options), text)
    const bytesOut = Buffer.byteLength(out, "utf-8")
    if (bytesOut + NEVER_WORSE_MARGIN >= bytesIn) {
      return { text, bytesIn, bytesOut: bytesIn, degraded: true }
    }
    return { text: out, bytesIn, bytesOut, degraded: false }
  },
})

const defaultPipeline = createPipeline()

export function clean(text: string, options: CleanOptions = {}): CleanResult {
  return defaultPipeline.run(text, options)
}
