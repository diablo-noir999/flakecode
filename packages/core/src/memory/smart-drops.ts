/**
 * Smart Context Pruning — Drop Strategy
 *
 * Identifies and drops low-value messages from context to reclaim tokens.
 * Adapted from dev/opencode-magic-context tool-drop-target.ts,
 * emergency-drop.ts, and drop-stale-reduce-calls.ts. Simplified:
 * no tag database, no tiered emergency planning, no composite keys.
 *
 * Drop categories:
 * 1. Spent tool outputs — tool results older than threshold, no longer relevant
 * 2. Superseded edits — edit/write calls where a later call edits the same file
 * 3. Low-value messages — empty messages, placeholder-only messages, stale reduce calls
 */

// === Types ===

const STALE_REDUCE_MIN_AGE = 5;
const CHARS_PER_TOKEN_ESTIMATE = 4;

import { isRecord, getToolName, getToolInput } from "./message-utils";
import { estimateMessageTokens } from "./token-utils";

export type DropCategory =
  | "spent-tool-output"
  | "superseded-edit"
  | "low-value-message"
  | "stale-reduce-call"
  | "dropped-placeholder";

export interface DropCandidate {
  index: number;
  category: DropCategory;
  reason: string;
  estimatedTokens: number;
}

export interface DropStrategyConfig {
  /** Maximum age (in messages from end) before tool outputs are considered spent */
  maxToolOutputAge: number;
  /** Whether to detect superseded edits */
  detectSupersededEdits: boolean;
  /** Whether to drop low-value messages */
  dropLowValue: boolean;
  /** Whether to drop stale reduce calls */
  dropStaleReduceCalls: boolean;
  /** Minimum token savings to justify a drop */
  minTokenSavings: number;
}

export const DEFAULT_DROP_CONFIG: DropStrategyConfig = {
  maxToolOutputAge: 50,
  detectSupersededEdits: true,
  dropLowValue: true,
  dropStaleReduceCalls: true,
  minTokenSavings: 100,
};

// === Helpers ===

function isDroppedPlaceholder(message: any): boolean {
  if (typeof message.content === "string") {
    return /^\[dropped/.test(message.content) || message.content === "[dropped]";
  }
  if (Array.isArray(message.parts)) {
    return (
      message.parts.length === 1 &&
      isRecord(message.parts[0]) &&
      message.parts[0].type === "text" &&
      (message.parts[0].text === "" || message.parts[0].text === "[dropped]")
    );
  }
  return false;
}

function isEmptyMessage(message: any): boolean {
  const tokens = estimateMessageTokens(message);
  return tokens === 0;
}

function isStaleReduceCall(message: any): boolean {
  const toolName = getToolName(message);
  return toolName === "ctx_reduce";
}

// === Drop Strategies ===

/**
 * Find spent tool outputs — tool results that are old enough to be irrelevant.
 * Ported from magic-context's tier-based drop but simplified to age-only.
 */
function findSpentToolOutputs(
  messages: any[],
  config: DropStrategyConfig,
): DropCandidate[] {
  const candidates: DropCandidate[] = [];
  const lastUserIndex = findLastUserIndex(messages);

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role !== "tool" && msg.role !== "tool-result") continue;

    // Calculate age from the last user message
    const age = lastUserIndex >= 0 ? lastUserIndex - i : messages.length - i;
    if (age <= config.maxToolOutputAge) continue;

    candidates.push({
      index: i,
      category: "spent-tool-output",
      reason: `tool output ${age} messages old (max: ${config.maxToolOutputAge})`,
      estimatedTokens: estimateMessageTokens(msg),
    });
  }

  return candidates;
}

/**
 * Find superseded edits — edit/write calls where a later call edits the same file.
 * Ported from magic-context's supersession detection but simplified.
 */
function findSupersededEdits(
  messages: any[],
  config: DropStrategyConfig,
): DropCandidate[] {
  if (!config.detectSupersededEdits) return [];

  const candidates: DropCandidate[] = [];
  const editHistory = new Map<string, number>(); // filePath -> last edit index

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    const toolName = getToolName(msg);

    if (toolName === "edit" || toolName === "write" || toolName === "apply_patch") {
      const input = getToolInput(msg);
      if (!input) continue;

      const filePath = (input.filePath ?? input.file_path ?? input.path ?? "") as string;
      if (!filePath) continue;

      const prevIndex = editHistory.get(filePath);
      if (prevIndex !== undefined) {
        // Previous edit to this file is superseded
        candidates.push({
          index: prevIndex,
          category: "superseded-edit",
          reason: `edit to ${filePath} superseded by edit at index ${i}`,
          estimatedTokens: estimateMessageTokens(messages[prevIndex]),
        });
      }
      editHistory.set(filePath, i);
    }
  }

  return candidates;
}

/**
 * Find low-value messages — empty messages, placeholder-only messages.
 */
function findLowValueMessages(
  messages: any[],
  config: DropStrategyConfig,
): DropCandidate[] {
  if (!config.dropLowValue) return [];

  const candidates: DropCandidate[] = [];

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];

    // Skip user messages — they anchor turn boundaries
    if (msg.role === "user") continue;

    if (isDroppedPlaceholder(msg)) {
      candidates.push({
        index: i,
        category: "dropped-placeholder",
        reason: "message is a dropped placeholder",
        estimatedTokens: 0,
      });
    } else if (isEmptyMessage(msg)) {
      candidates.push({
        index: i,
        category: "low-value-message",
        reason: "message has no content",
        estimatedTokens: 0,
      });
    }
  }

  return candidates;
}

/**
 * Find stale reduce calls — ctx_reduce tool calls that are old.
 * Ported from magic-context drop-stale-reduce-calls.ts.
 */
function findStaleReduceCalls(
  messages: any[],
  config: DropStrategyConfig,
): DropCandidate[] {
  if (!config.dropStaleReduceCalls) return [];

  const candidates: DropCandidate[] = [];
  const lastUserIndex = findLastUserIndex(messages);

  for (let i = 0; i < messages.length; i++) {
    if (!isStaleReduceCall(messages[i])) continue;

    const age = lastUserIndex >= 0 ? lastUserIndex - i : messages.length - i;
    if (age <= STALE_REDUCE_MIN_AGE) continue; // Keep recent reduce calls

    candidates.push({
      index: i,
      category: "stale-reduce-call",
      reason: `stale ctx_reduce call ${age} messages old`,
      estimatedTokens: estimateMessageTokens(messages[i]),
    });
  }

  return candidates;
}

// === Public API ===

function findLastUserIndex(messages: any[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") return i;
  }
  return -1;
}

export interface SmartDropResult {
  candidates: DropCandidate[];
  totalEstimatedTokens: number;
  strategy: DropStrategyConfig;
}

/**
 * Run all drop strategies and return candidates for removal.
 * Does NOT modify the messages array — caller decides what to apply.
 */
export function findDropCandidates(
  messages: any[],
  config: DropStrategyConfig = DEFAULT_DROP_CONFIG,
): SmartDropResult {
  const allCandidates: DropCandidate[] = [
    ...findSpentToolOutputs(messages, config),
    ...findSupersededEdits(messages, config),
    ...findLowValueMessages(messages, config),
    ...findStaleReduceCalls(messages, config),
  ];

  // Sort by estimated token savings (largest first) and filter by minimum
  const filtered = allCandidates
    .filter((c) => c.estimatedTokens >= config.minTokenSavings || c.category === "dropped-placeholder")
    .sort((a, b) => b.estimatedTokens - a.estimatedTokens);

  return {
    candidates: filtered,
    totalEstimatedTokens: filtered.reduce((sum, c) => sum + c.estimatedTokens, 0),
    strategy: config,
  };
}

/**
 * Apply drop candidates to a message array by replacing dropped messages
 * with placeholder content.
 *
 * WARNING: Only call this on a copy or when the original is no longer needed.
 */
export function applyDrops(messages: any[], candidates: DropCandidate[]): number {
  let applied = 0;

  for (const candidate of candidates) {
    const msg = messages[candidate.index];
    if (!msg) continue;

    // Never drop user messages — they anchor turn boundaries
    if (msg.role === "user") continue;

    // Replace content with a minimal placeholder
    if (typeof msg.content === "string") {
      messages[candidate.index] = {
        ...msg,
        content: `[${candidate.category} dropped — ${candidate.reason}]`,
      };
    } else if (Array.isArray(msg.parts)) {
      messages[candidate.index] = {
        ...msg,
        parts: [{ type: "text", text: `[${candidate.category} dropped]` }],
      };
    }
    applied++;
  }

  return applied;
}
