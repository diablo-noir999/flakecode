/**
 * m[0]/m[1] Cache Layout — Anthropic Prompt Cache Optimization
 *
 * Classifies messages into cache zones for optimal prompt cache hits.
 * Adapted from dev/opencode-magic-context cache-busting-signals.ts and
 * transform-context-state.ts. Scoped: taxonomy/classification only,
 * no physical message splitting.
 *
 * Cache zones:
 * - m[0]: Stable system/context — rarely changes (project docs, rules, config)
 * - m[1]: Recent conversation — changes each turn (last N messages)
 * - m[2]: Ephemeral — always changes (current user message, tool calls in flight)
 */

// === Cache Zone Classification ===

export type CacheZone = "m0" | "m1" | "m2";

export interface CacheZoneEntry {
  zone: CacheZone;
  reason: string;
}

/**
 * Cache-bust taxonomy — classifies what causes cache invalidation.
 * Ported from magic-context's cache-busting-signals.ts.
 */
export type CacheBustCause =
  | "system-prompt-change"
  | "tool-definition-change"
  | "message-add"
  | "message-remove"
  | "message-content-change"
  | "turn-boundary"
  | "model-change";

/**
 * Classify a message's cache zone based on its position and role.
 *
 * Rules:
 * - System messages → m[0] (stable)
 * - User messages in the last N of the conversation → m[1] (recent)
 * - Older user messages → m[0] (stable, part of history context)
 * - Assistant messages in the last N → m[1] (recent)
 * - Tool result messages → m[2] (ephemeral, will be replaced)
 * - The very last message (current turn) → m[2] (ephemeral)
 */
export function classifyCacheZone(
  message: { role?: string; content?: string; parts?: unknown[] },
  index: number,
  totalMessages: number,
  recentWindow: number = 10,
): CacheZoneEntry {
  const role = message.role ?? "unknown";

  // Current message (always ephemeral)
  if (index === totalMessages - 1) {
    return { zone: "m2", reason: "current-message" };
  }

  // Tool results are ephemeral — they'll be replaced on next call
  if (role === "tool" || role === "tool-result") {
    return { zone: "m2", reason: "tool-result" };
  }

  // System messages are always stable
  if (role === "system") {
    return { zone: "m0", reason: "system-message" };
  }

  // Messages in the recent window are m[1]
  const distanceFromEnd = totalMessages - 1 - index;
  if (distanceFromEnd < recentWindow) {
    return { zone: "m1", reason: `within-recent-window-${recentWindow}` };
  }

  // Everything else is stable history
  return { zone: "m0", reason: "stable-history" };
}

/**
 * Detect which cache zone a change falls in, determining cache-bust severity.
 *
 * A change in m[0] busts the ENTIRE cache (stable prefix changed).
 * A change in m[1] busts m[1] and m[2] (recent window invalidated).
 * A change in m[2] busts only m[2] (ephemeral, expected).
 */
export function classifyCacheBustSeverity(
  zone: CacheZone,
): { bustsZones: CacheZone[]; severity: "high" | "medium" | "low" } {
  switch (zone) {
    case "m0":
      return { bustsZones: ["m0", "m1", "m2"], severity: "high" };
    case "m1":
      return { bustsZones: ["m1", "m2"], severity: "medium" };
    case "m2":
      return { bustsZones: ["m2"], severity: "low" };
  }
}

/**
 * Compute cache stability score for a message sequence.
 * Returns 0-1 where 1 = fully stable (cache-friendly).
 *
 * Factors:
 * - Ratio of m[0] to total (more stable = higher score)
 * - No tool results in the prefix (tool results break cache)
 * - Consistent message ordering
 */
export function computeCacheStabilityScore(
  messages: Array<{ role?: string }>,
  recentWindow: number = 10,
): number {
  if (messages.length === 0) return 1;

  let stableCount = 0;
  let toolResultCount = 0;

  for (let i = 0; i < messages.length; i++) {
    const zone = classifyCacheZone(messages[i], i, messages.length, recentWindow);
    if (zone.zone === "m0") stableCount++;
    if (zone.zone === "m2" && (messages[i].role === "tool" || messages[i].role === "tool-result")) {
      toolResultCount++;
    }
  }

  const stableRatio = stableCount / messages.length;
  const toolResultPenalty = Math.min(toolResultCount / messages.length, 0.3);

  return Math.max(0, Math.min(1, stableRatio - toolResultPenalty));
}

/**
 * Identify the cache boundary — the index where m[0] ends and m[1] begins.
 * This is the "compaction boundary" in magic-context terms.
 */
export function findCacheBoundary(
  messages: Array<{ role?: string }>,
  recentWindow: number = 10,
): number {
  for (let i = 0; i < messages.length; i++) {
    const zone = classifyCacheZone(messages[i], i, messages.length, recentWindow);
    if (zone.zone !== "m0") return i;
  }
  return messages.length;
}
