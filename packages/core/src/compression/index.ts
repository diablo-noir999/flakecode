/**
 * Content-Aware Compression Module
 * Routes content to appropriate compressor based on detected type.
 * Extracted from headroom's compression patterns.
 *
 * Adapted for OpenCode with Effect-based architecture.
 */

import { Effect } from "effect"
import {
  detectContentType,
  ContentType,
  type DetectionResult,
} from "./content-router"
import {
  crushJson,
  type CrushResult,
  type JsonCrusherConfig,
} from "./json-crusher"
import {
  compressCode,
  type CodeCompressionResult,
  type CodeCompressorConfig,
} from "./code-compressor"

export interface CompressionResult {
  compressed: string
  original: string
  ratio: number
  strategy: string
  contentType: ContentType
  wasModified: boolean
  details?: CrushResult | CodeCompressionResult
}

export interface CompressionConfig {
  enableJson: boolean
  enableCode: boolean
  minContentLength: number
  jsonConfig?: Partial<JsonCrusherConfig>
  codeConfig?: Partial<CodeCompressorConfig>
}

const DEFAULT: CompressionConfig = {
  enableJson: true,
  enableCode: true,
  minContentLength: 200,
}

function passthrough(
  content: string,
  det?: DetectionResult
): CompressionResult {
  return {
    compressed: content,
    original: content,
    ratio: 1.0,
    strategy: "passthrough",
    contentType: det?.contentType ?? ContentType.PLAIN_TEXT,
    wasModified: false,
  }
}

/** Compress content-aware tool output. Routes JSON→JsonCrusher, code→CodeCompressor. */
export function compress(
  content: string,
  config: Partial<CompressionConfig> = {}
): CompressionResult {
  const cfg = { ...DEFAULT, ...config }
  if (!content || content.length < cfg.minContentLength)
    return passthrough(content)
  const det = detectContentType(content)

  if (det.contentType === ContentType.JSON_ARRAY && cfg.enableJson) {
    const r = crushJson(content, cfg.jsonConfig)
    return {
      compressed: r.compressed,
      original: r.original,
      ratio: r.ratio,
      strategy: r.strategy,
      contentType: ContentType.JSON_ARRAY,
      wasModified: r.wasModified,
      details: r,
    }
  }
  if (det.contentType === ContentType.SOURCE_CODE && cfg.enableCode) {
    const r = compressCode(content, cfg.codeConfig)
    return {
      compressed: r.compressed,
      original: r.original,
      ratio: r.compressionRatio,
      strategy: r.strategy,
      contentType: ContentType.SOURCE_CODE,
      wasModified: r.compressed !== r.original,
      details: r,
    }
  }
  return passthrough(content, det)
}

/** Effect-based compression. */
export function compressEffect(
  content: string,
  config: Partial<CompressionConfig> = {}
): Effect.Effect<CompressionResult> {
  return Effect.sync(() => compress(content, config))
}

export {
  detectContentType,
  ContentType,
  type DetectionResult,
} from "./content-router"
export {
  crushJson,
  crushJsonArray,
  type CrushResult,
  type JsonCrusherConfig,
} from "./json-crusher"
export {
  compressCode,
  detectLanguage,
  type CodeCompressionResult,
  type CodeCompressorConfig,
} from "./code-compressor"

export function compressAll(
  contents: string[],
  config: Partial<CompressionConfig> = {}
): CompressionResult[] {
  return contents.map((c) => compress(c, config))
}

export function totalSavings(results: CompressionResult[]) {
  let o = 0,
    c = 0
  for (const r of results) {
    o += r.original.length
    c += r.compressed.length
  }
  return {
    originalTokens: Math.floor(o / 4),
    compressedTokens: Math.floor(c / 4),
    savingsPercent: o > 0 ? ((o - c) / o) * 100 : 0,
  }
}
