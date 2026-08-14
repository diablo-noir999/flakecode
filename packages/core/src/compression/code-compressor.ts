/**
 * Code-Aware Compressor — preserves imports/signatures, compresses bodies.
 * Extracted from headroom's CodeAwareCompressor patterns.
 * Uses regex-based detection (no external AST parser dependency).
 *
 * Adapted for OpenCode with Effect-based architecture.
 */

import { Effect } from "effect"

export interface CodeCompressionResult {
  compressed: string
  original: string
  originalTokens: number
  compressedTokens: number
  compressionRatio: number
  language: string
  preservedImports: number
  preservedSignatures: number
  compressedBodies: number
  strategy: string
}

export interface CodeCompressorConfig {
  preserveImports: boolean
  preserveSignatures: boolean
  maxBodyLines: number
  compressComments: boolean
  minTokensForCompression: number
  languageHint: string | null
}

const DEFAULT: CodeCompressorConfig = {
  preserveImports: true,
  preserveSignatures: true,
  maxBodyLines: 5,
  compressComments: true,
  minTokensForCompression: 100,
  languageHint: null,
}

const LANG_PAT: Record<string, RegExp[]> = {
  python: [
    /^\s*(def|class|import|from|async def)\s+\w+/m,
    /^\s*@\w+/m,
    /^\s*"""/m,
  ],
  javascript: [
    /^\s*(function|const|let|var|class|import|export)\s+\w+/m,
    /^\s*module\.exports/m,
  ],
  typescript: [
    /^\s*(interface|type|enum|namespace)\s+\w+/m,
    /:\s*(string|number|boolean|any|void)\b/m,
  ],
  go: [/^\s*(func|type|package|import)\s+/m],
  rust: [/^\s*(fn|struct|enum|impl|mod|use|pub)\s+/m, /^\s*#\[/m],
}

export function detectLanguage(code: string): {
  language: string
  confidence: number
} {
  const s = code.slice(0, 5000),
    scores: Record<string, number> = {}
  for (const [lang, pats] of Object.entries(LANG_PAT)) {
    let sc = 0
    for (const p of pats) {
      const m = s.match(p)
      if (m) sc += m.length
    }
    if (sc > 0) scores[lang] = sc
  }
  const best = Object.entries(scores).sort((a, b) => b[1] - a[1])[0]
  return best
    ? { language: best[0], confidence: Math.min(1.0, 0.3 + best[1] * 0.1) }
    : { language: "unknown", confidence: 0 }
}

interface Structure {
  imports: string[]
  signatures: string[]
  bodies: { sig: string; body: string }[]
  rest: string[]
}

function findSigEnd(lines: string[], start: number): number {
  let depth = 0
  for (let i = start; i < lines.length; i++) {
    for (const ch of lines[i]) {
      if (ch === "(") depth++
      if (ch === ")") depth--
    }
    if (depth <= 0) return i
  }
  return start
}

function findBodyEnd(lines: string[], start: number): number {
  if (start >= lines.length) return lines.length
  const base = lines[start].search(/\S/)
  if (base < 0) return lines.length
  for (let i = start + 1; i < lines.length; i++) {
    const t = lines[i].trim()
    if (!t) continue
    if (lines[i].search(/\S/) < base) return i
  }
  return lines.length
}

function extractStructure(code: string): Structure {
  const lines = code.split("\n"),
    s: Structure = { imports: [], signatures: [], bodies: [], rest: [] }
  let i = 0
  while (i < lines.length) {
    const l = lines[i]
    if (/^\s*(import|from|use|require)\s+/.test(l)) {
      s.imports.push(l)
      i++
      continue
    }
    if (/^\s*(def|async def)\s+\w+/.test(l)) {
      const sigEnd = findSigEnd(lines, i),
        sig = lines.slice(i, sigEnd + 1).join("\n")
      const bodyEnd = findBodyEnd(lines, sigEnd + 1),
        body = lines.slice(sigEnd + 1, bodyEnd).join("\n")
      s.signatures.push(sig)
      s.bodies.push({ sig, body })
      i = bodyEnd
      continue
    }
    if (/^\s*class\s+\w+/.test(l)) {
      const sigEnd = findSigEnd(lines, i)
      s.signatures.push(lines.slice(i, sigEnd + 1).join("\n"))
      i = sigEnd + 1
      continue
    }
    s.rest.push(l)
    i++
  }
  return s
}

function countTokens(t: string) {
  return Math.max(1, Math.floor(t.length / 4))
}

function compressBody(
  body: string,
  max: number,
  cfg: CodeCompressorConfig
): string {
  const lines = body.split("\n").filter((l) => l.trim())
  if (lines.length <= max) return body
  if (cfg.compressComments) {
    const filt = lines.filter((l) => !/^\s*(#|\/\/|\/\*|\*)/.test(l))
    if (filt.length <= max) return filt.join("\n")
    return (
      filt.slice(0, max).join("\n") +
      `\n    # ... (${lines.length - max} lines compressed)`
    )
  }
  return (
    lines.slice(0, max).join("\n") +
    `\n    # ... (${lines.length - max} lines compressed)`
  )
}

/** Compress code while preserving imports and function signatures. */
export function compressCode(
  code: string,
  config: Partial<CodeCompressorConfig> = {}
): CodeCompressionResult {
  const cfg = { ...DEFAULT, ...config },
    orig = countTokens(code)
  if (orig < cfg.minTokensForCompression)
    return {
      compressed: code,
      original: code,
      originalTokens: orig,
      compressedTokens: orig,
      compressionRatio: 1.0,
      language: "unknown",
      preservedImports: 0,
      preservedSignatures: 0,
      compressedBodies: 0,
      strategy: "passthrough",
    }

  const { language } = cfg.languageHint
    ? { language: cfg.languageHint }
    : detectLanguage(code)
  const st = extractStructure(code)
  const parts: string[] = []
  let pImp = 0,
    pSig = 0,
    cBod = 0

  if (cfg.preserveImports) {
    parts.push(...st.imports)
    pImp = st.imports.length
  }
  for (const { sig, body } of st.bodies) {
    if (cfg.preserveSignatures) {
      parts.push(sig)
      pSig++
    }
    const origLines = body.split("\n").filter((l) => l.trim()).length
    if (origLines > cfg.maxBodyLines) {
      parts.push(compressBody(body, cfg.maxBodyLines, cfg))
      cBod++
    } else {
      parts.push(body)
    }
  }
  parts.push(...st.rest)
  const compressed = parts.join("\n"),
    comp = countTokens(compressed)
  return {
    compressed,
    original: code,
    originalTokens: orig,
    compressedTokens: comp,
    compressionRatio: comp / Math.max(orig, 1),
    language,
    preservedImports: pImp,
    preservedSignatures: pSig,
    compressedBodies: cBod,
    strategy: cBod > 0 ? "code_aware" : "passthrough",
  }
}

/** Effect-based code compression. */
export function compressCodeEffect(
  code: string,
  config: Partial<CodeCompressorConfig> = {}
): Effect.Effect<CodeCompressionResult> {
  return Effect.sync(() => compressCode(code, config))
}
