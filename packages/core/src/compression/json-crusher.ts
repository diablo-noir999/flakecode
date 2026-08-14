/**
 * JSON Array Crusher — field dedup, row reduction, lossless compaction.
 * Extracted from headroom's SmartCrusher patterns.
 *
 * Adapted for OpenCode with Effect-based architecture.
 */

import { Effect } from "effect"

export interface CrushResult {
  compressed: string
  original: string
  wasModified: boolean
  strategy: string
  ratio: number
}

export interface JsonCrusherConfig {
  minItemsToAnalyze: number
  coreFieldFraction: number
  maxItemsAfterCrush: number
  similarityThreshold: number
  firstFraction: number
  lastFraction: number
  dedupIdentical: boolean
  minSavingsRatio: number
}

const DEFAULT: JsonCrusherConfig = {
  minItemsToAnalyze: 5,
  coreFieldFraction: 0.8,
  maxItemsAfterCrush: 15,
  similarityThreshold: 0.8,
  firstFraction: 0.3,
  lastFraction: 0.15,
  dedupIdentical: true,
  minSavingsRatio: 0.1,
}

function inferSchema(items: Record<string, unknown>[]) {
  const counts = new Map<string, number>()
  for (const item of items)
    for (const k of Object.keys(item))
      counts.set(k, (counts.get(k) || 0) + 1)
  return counts
}

function coreFields(
  schema: Map<string, number>,
  n: number,
  frac: number
) {
  const thr = Math.ceil(n * frac)
  return Array.from(schema.entries())
    .filter(([_, c]) => c >= thr)
    .map(([k]) => k)
    .sort()
}

function rowSim(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
  fields: string[]
) {
  if (!fields.length) return 0
  let m = 0
  for (const f of fields) {
    if (JSON.stringify(a[f]) === JSON.stringify(b[f])) m++
  }
  return m / fields.length
}

function dedupIdentical(items: Record<string, unknown>[]) {
  const seen = new Map<string, Record<string, unknown>>()
  const kept: Record<string, unknown>[] = []
  for (const item of items) {
    const k = JSON.stringify(item, Object.keys(item).sort())
    if (!seen.has(k)) {
      seen.set(k, item)
      kept.push(item)
    }
  }
  return kept
}

function selectRows(
  items: Record<string, unknown>[],
  core: string[],
  cfg: JsonCrusherConfig
) {
  const n = items.length,
    max = Math.min(cfg.maxItemsAfterCrush, n)
  if (n <= max) return items
  const first = Math.max(1, Math.floor(n * cfg.firstFraction))
  const last = Math.max(1, Math.floor(n * cfg.lastFraction))
  const mid = items.slice(first, n - last)
  const budget = max - first - last
  if (budget <= 0)
    return [...items.slice(0, first), ...items.slice(-last)]

  const selected: Record<string, unknown>[] = [mid[0]]
  const rest = mid.slice(1)
  while (selected.length < budget && rest.length > 0) {
    let bestI = 0,
      bestMin = -1
    for (let i = 0; i < rest.length; i++) {
      let minS = 1
      for (const s of selected) {
        const sim = rowSim(rest[i], s, core)
        if (sim < minS) minS = sim
      }
      if (minS > bestMin) {
        bestMin = minS
        bestI = i
      }
    }
    if (bestMin < cfg.similarityThreshold)
      selected.push(rest.splice(bestI, 1)[0])
    else break
  }
  return [...items.slice(0, first), ...selected, ...items.slice(-last)]
}

/** Crush a JSON array string — dedup fields, reduce rows, compact. */
export function crushJsonArray(
  input: string,
  config: Partial<JsonCrusherConfig> = {}
): CrushResult {
  const cfg = { ...DEFAULT, ...config }
  const original = input
  let items: unknown[]
  try {
    items = JSON.parse(input)
  } catch {
    return {
      compressed: input,
      original,
      wasModified: false,
      strategy: "passthrough",
      ratio: 1.0,
    }
  }
  if (!Array.isArray(items) || items.length < cfg.minItemsToAnalyze)
    return {
      compressed: input,
      original,
      wasModified: false,
      strategy: "passthrough",
      ratio: 1.0,
    }

  const objs = items.filter(
    (i): i is Record<string, unknown> =>
      typeof i === "object" && i !== null && !Array.isArray(i)
  )
  if (objs.length < cfg.minItemsToAnalyze)
    return {
      compressed: input,
      original,
      wasModified: false,
      strategy: "passthrough",
      ratio: 1.0,
    }

  const schema = inferSchema(objs)
  const core = coreFields(schema, objs.length, cfg.coreFieldFraction)
  if (!core.length)
    return {
      compressed: input,
      original,
      wasModified: false,
      strategy: "passthrough",
      ratio: 1.0,
    }

  let result = [...objs],
    strategy = "passthrough"
  if (cfg.dedupIdentical) {
    const before = result.length
    result = dedupIdentical(result)
    if (result.length < before) strategy = "dedup_identical"
  }
  if (result.length > cfg.maxItemsAfterCrush) {
    result = selectRows(result, core, cfg)
    strategy = "row_reduce"
  }

  const compressed = JSON.stringify(result)
  const ratio =
    Buffer.byteLength(compressed, "utf8") /
    Math.max(Buffer.byteLength(input, "utf8"), 1)
  if (ratio > 1 - cfg.minSavingsRatio && strategy === "passthrough")
    return {
      compressed: input,
      original,
      wasModified: false,
      strategy: "passthrough",
      ratio: 1.0,
    }
  return {
    compressed,
    original,
    wasModified: compressed !== input,
    strategy: compressed !== input ? strategy : "passthrough",
    ratio,
  }
}

/** Crush a JSON string — detect if array and apply strategy. */
export function crushJson(
  input: string,
  config: Partial<JsonCrusherConfig> = {}
): CrushResult {
  const t = input.trim()
  if (!t.startsWith("[") && !t.startsWith("{"))
    return {
      compressed: input,
      original: input,
      wasModified: false,
      strategy: "passthrough",
      ratio: 1.0,
    }
  try {
    const p = JSON.parse(t)
    return Array.isArray(p)
      ? crushJsonArray(t, config)
      : (() => {
          const c = JSON.stringify(p)
          return {
            compressed: c,
            original: input,
            wasModified: c !== t,
            strategy: c !== t ? "minify" : "passthrough",
            ratio:
              Buffer.byteLength(c, "utf8") / Buffer.byteLength(input, "utf8"),
          }
        })()
  } catch {
    return {
      compressed: input,
      original: input,
      wasModified: false,
      strategy: "passthrough",
      ratio: 1.0,
    }
  }
}

/** Effect-based JSON crushing. */
export function crushJsonEffect(
  input: string,
  config: Partial<JsonCrusherConfig> = {}
): Effect.Effect<CrushResult> {
  return Effect.sync(() => crushJson(input, config))
}
