/**
 * Memory Promotion — Auto-capture facts from sessions into durable memory.
 *
 * Adapted from dev/opencode-magic-context promotion.ts. Simplified pattern:
 * session facts are promoted to project memories when they match promotable
 * categories and pass deduplication via normalized hash.
 */

import { type Memory, type MemoryCategory, type MemoryInput, CATEGORY_DEFAULT_TTL } from "./types";

interface SessionFact {
  category: string;
  content: string;
}

export interface PromotedMemoryRef {
  memoryId: number;
  content: string;
}

const PROMOTABLE_CATEGORIES: MemoryCategory[] = [
  "PROJECT_RULES",
  "ARCHITECTURE",
  "CONSTRAINTS",
  "CONFIG_VALUES",
  "NAMING",
  "LESSONS_LEARNED",
  "BUG_FIXES",
  "USER_PREFERENCES",
];

function isPromotableCategory(category: string): category is MemoryCategory {
  return PROMOTABLE_CATEGORIES.includes(category as MemoryCategory);
}

/**
 * Promote eligible session facts to cross-session memories.
 *
 * - Deduplicates via normalized hash
 * - Skips non-promotable categories
 * - Returns refs for async embedding
 */
export function promoteSessionFacts(
  getMemoryByHash: (projectPath: string, category: MemoryCategory, content: string) => Memory | null,
  insertMemory: (input: MemoryInput) => Memory,
  updateSeenCount: (id: number) => void,
  projectPath: string,
  sessionId: string,
  facts: SessionFact[],
): PromotedMemoryRef[] {
  const refs: PromotedMemoryRef[] = [];

  for (const fact of facts) {
    if (
      !fact ||
      typeof fact.category !== "string" ||
      typeof fact.content !== "string" ||
      fact.content.trim().length === 0
    ) {
      continue;
    }

    if (!isPromotableCategory(fact.category)) {
      continue;
    }

    const existing = getMemoryByHash(projectPath, fact.category, fact.content);
    if (existing) {
      updateSeenCount(existing.id);
      continue;
    }

    const ttl = CATEGORY_DEFAULT_TTL[fact.category] ?? null;
    const memoryInput: MemoryInput = {
      projectPath,
      category: fact.category,
      content: fact.content,
      sourceSessionId: sessionId,
      sourceType: "session_promote",
      expiresAt: ttl ? Date.now() + ttl : null,
    };

    const memory = insertMemory(memoryInput);
    refs.push({ memoryId: memory.id, content: memory.content });
  }

  return refs;
}

/**
 * Extract promotable facts from compartment output.
 * The historian agent returns facts in this shape; we extract them here.
 */
export function extractPromotableFacts(
  compartmentFacts: Array<{ category: string; content: string }>,
): SessionFact[] {
  return compartmentFacts.filter(
    (f) =>
      f &&
      typeof f.category === "string" &&
      typeof f.content === "string" &&
      f.content.trim().length > 0,
  );
}
