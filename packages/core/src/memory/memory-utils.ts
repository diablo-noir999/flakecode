/**
 * Shared utilities for memory module.
 *
 * Row-to-Memory conversion shared between store and search.
 */

import type { Memory, MemoryPayload, PayloadType } from "./types";

function parsePayload(payloadType: string | null, payloadJson: string | null): { payloadType: PayloadType | null; payload: MemoryPayload | null } {
  if (!payloadType || !payloadJson) return { payloadType: null, payload: null };
  try {
    const parsed = JSON.parse(payloadJson);
    return { payloadType: payloadType as PayloadType, payload: parsed as MemoryPayload };
  } catch {
    return { payloadType: null, payload: null };
  }
}

export function rowToMemory(row: any): Memory {
  const { payloadType, payload } = parsePayload(row.payload_type ?? null, row.payload ?? null);
  return {
    id: row.id,
    projectPath: row.project_path,
    category: row.category,
    content: row.content,
    normalizedHash: row.normalized_hash,
    importance: row.importance,
    scope: row.scope,
    sourceSessionId: row.source_session_id,
    sourceType: row.source_type,
    seenCount: row.seen_count,
    retrievalCount: row.retrieval_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastSeenAt: row.last_seen_at,
    lastRetrievedAt: row.last_retrieved_at,
    status: row.status,
    expiresAt: row.expires_at,
    payloadType,
    payload,
  };
}
