/**
 * Content Type Detection — routes content to appropriate compressor.
 * Extracted from headroom's content_detector.py patterns.
 *
 * Adapted for OpenCode with Effect-based architecture.
 */

import { Effect } from "effect"

export enum ContentType {
  JSON_ARRAY = "json_array",
  SOURCE_CODE = "source_code",
  SEARCH_RESULTS = "search",
  BUILD_OUTPUT = "build",
  GIT_DIFF = "diff",
  PLAIN_TEXT = "text",
}

export interface DetectionResult {
  contentType: ContentType
  confidence: number
  metadata: Record<string, unknown>
}

const SEARCH_RE = /^[^\s:]+:\d+:/
const DIFF_RE = /^(diff --git|--- a\/|@@\s+-\d+,\d+\s+\+\d+,\d+\s+@@)/
const CODE_PATTERNS: Record<string, RegExp[]> = {
  python: [/^\s*(def|class|import|from|async def)\s+\w+/m, /^\s*@\w+/m, /^\s*"""/m],
  javascript: [/^\s*(function|const|let|var|class|import|export)\s+\w+/m, /^\s*module\.exports/m],
  typescript: [/^\s*(interface|type|enum|namespace)\s+\w+/m, /:\s*(string|number|boolean|any|void)\b/m],
  go: [/^\s*(func|type|package|import)\s+/m, /^\s*func\s+\([^)]+\)\s+\w+/m],
  rust: [/^\s*(fn|struct|enum|impl|mod|use|pub)\s+/m, /^\s*#\[/m],
}
const LOG_RE = [
  /\b(ERROR|FAIL|FAILED|FATAL|CRITICAL)\b/i,
  /Traceback \(most recent call last\)/,
  /^\w*(Error|Exception):/m,
]

function tryJson(c: string): DetectionResult | null {
  const t = c.trim()
  if (!t) return null
  try {
    const p = JSON.parse(t)
    if (Array.isArray(p))
      return {
        contentType: ContentType.JSON_ARRAY,
        confidence:
          p.length > 0 &&
          p.every(
            (i) => typeof i === "object" && i !== null && !Array.isArray(i)
          )
            ? 1.0
            : 0.8,
        metadata: { itemCount: p.length },
      }
    if (typeof p === "object" && p !== null)
      return {
        contentType: ContentType.JSON_ARRAY,
        confidence: 0.9,
        metadata: { isObject: true },
      }
  } catch {
    /* not JSON */
  }
  return null
}

function tryDiff(c: string): DetectionResult | null {
  const lines = c.split("\n").slice(0, 500)
  let h = 0,
    ch = 0
  for (const l of lines) {
    if (DIFF_RE.test(l)) h++
    if (/^[+-][^+-]/.test(l)) ch++
  }
  return h > 0
    ? {
        contentType: ContentType.GIT_DIFF,
        confidence: Math.min(1.0, 0.5 + h * 0.2 + ch * 0.05),
        metadata: {},
      }
    : null
}

function trySearch(c: string): DetectionResult | null {
  const lines = c.split("\n").slice(0, 100)
  let m = 0,
    ne = 0
  for (const l of lines) {
    if (l.trim()) {
      ne++
      if (SEARCH_RE.test(l)) m++
    }
  }
  if (!ne) return null
  const r = m / ne
  return r >= 0.3
    ? {
        contentType: ContentType.SEARCH_RESULTS,
        confidence: Math.min(1.0, 0.4 + r * 0.6),
        metadata: {},
      }
    : null
}

function tryLog(c: string): DetectionResult | null {
  const lines = c.split("\n").slice(0, 200)
  let m = 0
  for (const l of lines)
    for (const p of LOG_RE) {
      if (p.test(l)) {
        m++
        break
      }
    }
  const ne = lines.filter((l) => l.trim()).length
  if (!ne) return null
  const r = m / ne
  return r >= 0.1
    ? {
        contentType: ContentType.BUILD_OUTPUT,
        confidence: Math.min(1.0, 0.3 + r * 0.5),
        metadata: {},
      }
    : null
}

function tryCode(c: string): DetectionResult | null {
  const lines = c.split("\n").slice(0, 100)
  const scores: Record<string, number> = {}
  for (const l of lines)
    for (const [lang, pats] of Object.entries(CODE_PATTERNS)) {
      for (const p of pats) {
        if (p.test(l)) {
          scores[lang] = (scores[lang] || 0) + 1
          break
        }
      }
    }
  const best = Object.entries(scores).sort((a, b) => b[1] - a[1])[0]
  if (!best || best[1] < 3) return null
  return {
    contentType: ContentType.SOURCE_CODE,
    confidence: Math.min(1.0, 0.4 + best[1] * 0.02),
    metadata: { language: best[0] },
  }
}

/** Detect content type for compression routing. */
export function detectContentType(content: string): DetectionResult {
  if (!content?.trim())
    return {
      contentType: ContentType.PLAIN_TEXT,
      confidence: 0,
      metadata: {},
    }
  return (
    tryJson(content) ||
    tryDiff(content) ||
    trySearch(content) ||
    tryLog(content) ||
    tryCode(content) || {
      contentType: ContentType.PLAIN_TEXT,
      confidence: 0.5,
      metadata: {},
    }
  )
}

/** Effect-based content type detection. */
export function detectContentTypeEffect(
  content: string
): Effect.Effect<DetectionResult> {
  return Effect.sync(() => detectContentType(content))
}
