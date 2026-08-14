/**
 * Auto-capture hooks — extract memories from completed sessions.
 *
 * Adapted from dev/opencode-mem auto-capture.ts. Simplified: extracts
 * technical content from session messages and stores as memories.
 */

import type { MemoryCategory, MemoryInput } from "./types";
import { MemoryStore, computeNormalizedHash } from "./store";

const MAX_CONTENT_LENGTH = 2000;
const MIN_CONTENT_LENGTH = 20;

// Simple keyword-based category detection
const CATEGORY_KEYWORDS: Record<MemoryCategory, string[]> = {
  PROJECT_RULES: ["rule", "must", "always", "never", "constraint", "convention"],
  ARCHITECTURE: ["architecture", "design", "pattern", "module", "component", "service"],
  CONSTRAINTS: ["constraint", "limitation", "requirement", "must", "cannot", "blocked"],
  CONFIG_VALUES: ["config", "setting", "env", "variable", "parameter", "option"],
  NAMING: ["naming", "name", "convention", "style", "prefix", "suffix"],
  LESSONS_LEARNED: ["learned", "discovered", "realized", "found out", "turns out"],
  BUG_FIXES: ["bug", "fix", "error", "issue", "crash", "broken", "workaround"],
  USER_PREFERENCES: ["prefer", "like", "want", "style", "approach", "habit"],
};

/**
 * Detect the most likely memory category from content.
 */
function detectCategory(content: string): MemoryCategory {
  const lower = content.toLowerCase();
  let bestCategory: MemoryCategory = "LESSONS_LEARNED";
  let bestScore = 0;

  for (const [category, keywords] of Object.entries(CATEGORY_KEYWORDS)) {
    let score = 0;
    for (const kw of keywords) {
      if (lower.includes(kw)) score++;
    }
    if (score >= bestScore) {
      bestScore = score;
      bestCategory = category as MemoryCategory;
    }
  }

  return bestCategory;
}

/**
 * Extract key technical content from a text block.
 * Returns cleaned content suitable for memory storage.
 */
function extractTechnicalContent(text: string): string | null {
  // Strip code blocks for cleaner memory entries
  const cleaned = text
    .replace(/```[\s\S]*?```/g, "[code block]")
    .replace(/`[^`]+`/g, (m) => m.slice(1, -1)) // inline code keep text
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  if (cleaned.length < MIN_CONTENT_LENGTH || cleaned.length > MAX_CONTENT_LENGTH) {
    return null;
  }

  return cleaned;
}

/**
 * Capture a memory from explicit user/agent content.
 */
export function captureMemory(
  store: MemoryStore,
  projectPath: string,
  content: string,
  options?: {
    category?: MemoryCategory;
    importance?: number;
    sourceSessionId?: string;
    sourceType?: "manual" | "auto_capture" | "session_promote";
  },
): { success: boolean; memoryId?: number; duplicate?: boolean } {
  const extracted = extractTechnicalContent(content);
  if (!extracted) {
    return { success: false };
  }

  const category = options?.category ?? detectCategory(extracted);

  // Dedup check
  const existing = store.getByHash(projectPath, category, extracted);
  if (existing) {
    store.updateSeen(existing.id);
    return { success: true, memoryId: existing.id, duplicate: true };
  }

  const input: MemoryInput = {
    projectPath,
    category,
    content: extracted,
    importance: options?.importance ?? 50,
    sourceSessionId: options?.sourceSessionId,
    sourceType: options?.sourceType ?? "manual",
  };

  const memory = store.insert(input);
  return { success: true, memoryId: memory.id };
}

/**
 * Extract memories from completed session messages.
 * Adapted from opencode-mem auto-capture.ts extractAIContent pattern.
 */
export function captureFromSession(
  store: MemoryStore,
  projectPath: string,
  sessionId: string,
  messages: Array<{ role: string; content: string }>,
): number {
  // Phase 1: Extract all candidates
  const candidates: Array<{ category: MemoryCategory; content: string }> = [];
  for (const msg of messages) {
    if (msg.role !== "assistant" && msg.role !== "user") continue;
    const content = extractTechnicalContent(msg.content);
    if (!content) continue;
    candidates.push({ category: detectCategory(content), content });
  }

  if (candidates.length === 0) return 0;

  // Phase 2: Batch dedup check
  const hashes = candidates.map((c) => computeNormalizedHash(c.content));
  const categories = candidates.map((c) => c.category);
  const existingHashes = new Set(store.getByHashBatch(projectPath, categories, hashes));

  // Phase 3: Batch update seen for existing
  const toUpdate: number[] = [];
  for (let i = 0; i < candidates.length; i++) {
    if (existingHashes.has(hashes[i])) {
      const existing = store.getByHash(projectPath, candidates[i]!.category, candidates[i]!.content);
      if (existing) toUpdate.push(existing.id);
    }
  }
  if (toUpdate.length > 0) store.updateSeenBatch(toUpdate);

  // Phase 4: Batch insert new entries
  const toInsert = candidates.filter((_, i) => !existingHashes.has(hashes[i]!));
  if (toInsert.length > 0) {
    store.insertBatch(projectPath, sessionId, toInsert);
  }

  return toInsert.length;
}
