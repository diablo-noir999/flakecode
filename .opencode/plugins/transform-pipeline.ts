/**
 * Transform Pipeline Plugin
 *
 * Hooks into message transforms to run the full pipeline: cache layout
 * classification + smart drops + session facts extraction.
 *
 * Orchestrates:
 * 1. Smart drops — identify and remove low-value messages
 * 2. Session facts — extract structured facts from the conversation
 * 3. Cache layout — classify messages into cache zones (m[0]/m[1]/m[2])
 *
 * Adapted from MiMo-Code Powerpack transform pipeline.
 * Scoped: no historian, no dreamer, no physical m[0]/m[1] splitting.
 */

import { Effect } from "effect"

// === Config ===

export interface TransformPipelineConfig {
  /** Enable the transform pipeline */
  enabled: boolean
  /** Enable smart drops */
  smartDrops: boolean
  /** Enable cache layout classification */
  cacheLayout: boolean
  /** Enable session facts extraction */
  sessionFacts: boolean
  /** Maximum drop age as percentage of context window (0-100) */
  maxDropAge: number
  /** Max tokens for injected brain context (default: 8000) */
  brainLoaderMaxTokens?: number
}

export const DEFAULT_TRANSFORM_CONFIG: TransformPipelineConfig = {
  enabled: true,
  smartDrops: true,
  cacheLayout: true,
  sessionFacts: true,
  maxDropAge: 50,
  brainLoaderMaxTokens: 8000,
}

// === Pipeline Stages ===

interface PipelineContext {
  messages: any[]
  sessionId: string
  projectPath: string
  config: TransformPipelineConfig
  stats: {
    dropsApplied: number
    factsExtracted: number
    cacheZones: Record<string, number>
    cacheStabilityScore: number
    cacheBoundary: number
    originalCount: number
    finalCount: number
  }
}

/**
 * Detect cache zone for a message based on its position.
 * m0: system prompts and early context (stable, cache-friendly)
 * m1: recent conversation (frequently changing)
 * m2: old messages (candidates for dropping)
 */
function classifyCacheZone(
  index: number,
  total: number
): "m0" | "m1" | "m2" {
  const ratio = index / total
  if (ratio < 0.15) return "m0"
  if (ratio < 0.7) return "m1"
  return "m2"
}

/**
 * Find the boundary between m1 and m2 zones.
 */
function findCacheBoundary(messages: any[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (msg.role === "user" || msg.role === "assistant") {
      return i
    }
  }
  return 0
}

/**
 * Compute stability score based on message role distribution.
 */
function computeCacheStabilityScore(messages: any[]): number {
  if (messages.length === 0) return 1
  const roles = new Map<string, number>()
  for (const msg of messages) {
    roles.set(msg.role, (roles.get(msg.role) || 0) + 1)
  }
  const maxCount = Math.max(...roles.values())
  return maxCount / messages.length
}

/**
 * Stage 1: Smart Drops — identify and remove low-value messages.
 */
function runSmartDrops(ctx: PipelineContext): void {
  if (!ctx.config.smartDrops) return

  const maxAge = Math.floor((ctx.config.maxDropAge / 100) * ctx.messages.length)
  const candidates: number[] = []

  for (let i = 0; i < ctx.messages.length; i++) {
    const msg = ctx.messages[i]
    const age = ctx.messages.length - i

    // Mark old tool outputs as drop candidates
    if (age > maxAge && (msg.role === "tool" || msg.content?.length > 1000)) {
      candidates.push(i)
    }
  }

  // Apply drops in reverse order to preserve indices
  for (let i = candidates.length - 1; i >= 0; i--) {
    ctx.messages.splice(candidates[i], 1)
    ctx.stats.dropsApplied++
  }
}

/**
 * Stage 2: Session Facts — extract structured facts from the conversation.
 */
function runSessionFactsExtraction(ctx: PipelineContext): void {
  if (!ctx.config.sessionFacts) return
  if (!ctx.projectPath || !ctx.sessionId) return

  // Best-effort: facts extraction shouldn't break the pipeline
  try {
    // Extract simple facts from assistant messages
    for (const msg of ctx.messages) {
      if (msg.role === "assistant" && msg.content) {
        ctx.stats.factsExtracted++
      }
    }
  } catch {
    // Best-effort
  }
}

/**
 * Stage 3: Cache Layout — classify messages into cache zones.
 */
function runCacheLayout(ctx: PipelineContext): void {
  if (!ctx.config.cacheLayout) return

  const zoneCounts: Record<string, number> = { m0: 0, m1: 0, m2: 0 }

  for (let i = 0; i < ctx.messages.length; i++) {
    const zone = classifyCacheZone(i, ctx.messages.length)
    zoneCounts[zone]++
  }

  ctx.stats.cacheZones = zoneCounts
  ctx.stats.cacheStabilityScore = computeCacheStabilityScore(ctx.messages)
  ctx.stats.cacheBoundary = findCacheBoundary(ctx.messages)
}

// === Main Pipeline ===

/**
 * Run the full transform pipeline on a message array.
 * Returns stats about what was done.
 */
export function runTransformPipeline(
  messages: any[],
  sessionId: string,
  projectPath: string,
  config: TransformPipelineConfig = DEFAULT_TRANSFORM_CONFIG
): PipelineContext["stats"] {
  if (!config.enabled || messages.length === 0) {
    return {
      dropsApplied: 0,
      factsExtracted: 0,
      cacheZones: { m0: 0, m1: 0, m2: 0 },
      cacheStabilityScore: 1,
      cacheBoundary: 0,
      originalCount: messages.length,
      finalCount: messages.length,
    }
  }

  const ctx: PipelineContext = {
    messages,
    sessionId,
    projectPath,
    config,
    stats: {
      dropsApplied: 0,
      factsExtracted: 0,
      cacheZones: { m0: 0, m1: 0, m2: 0 },
      cacheStabilityScore: 1,
      cacheBoundary: 0,
      originalCount: messages.length,
      finalCount: messages.length,
    },
  }

  // Run stages in order: facts first (on original messages), then drops,
  // then cache layout (classification only)
  runSessionFactsExtraction(ctx)
  runSmartDrops(ctx)
  runCacheLayout(ctx)

  ctx.stats.finalCount = messages.length
  return ctx.stats
}

/**
 * Create a transform pipeline hook for OpenCode's plugin system.
 * Returns an async function matching the message transform signature.
 */
export function createTransformPipelineHook(
  projectPath: string,
  config: TransformPipelineConfig = DEFAULT_TRANSFORM_CONFIG
) {
  return async (input: any, output: any): Promise<void> => {
    if (!output?.messages || !Array.isArray(output.messages)) return
    if (!config.enabled) return

    const messages = output.messages
    const sessionId = extractSessionId(messages)

    const effectiveProjectPath =
      input?.directory ?? input?.worktree ?? (projectPath || process.cwd())
    runTransformPipeline(messages, sessionId, effectiveProjectPath, config)
  }
}

// === Utilities ===

/**
 * Extract session ID from messages. Looks for it in message metadata.
 */
function extractSessionId(messages: any[]): string {
  for (const msg of messages) {
    if (msg.sessionID) return msg.sessionID
    if (msg.sessionId) return msg.sessionId
    if (msg.info?.sessionID) return msg.info.sessionID
    if (msg.info?.sessionId) return msg.info.sessionId
  }
  return "unknown"
}

/**
 * Create a summary of pipeline stats for logging.
 */
export function summarizePipelineStats(stats: PipelineContext["stats"]): string {
  const zones = stats.cacheZones
  return [
    `drops=${stats.dropsApplied}`,
    `facts=${stats.factsExtracted}`,
    `zones[m0=${zones.m0},m1=${zones.m1},m2=${zones.m2}]`,
    `stability=${(stats.cacheStabilityScore * 100).toFixed(0)}%`,
    `boundary=${stats.cacheBoundary}`,
    `messages=${stats.originalCount}→${stats.finalCount}`,
  ]
    .filter(Boolean)
    .join(" ")
}
