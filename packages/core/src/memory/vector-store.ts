/**
 * Vector storage — SQLite BLOB-backed embeddings with cosine similarity search.
 *
 * Adapted from dev/opencode-magic-context storage-memory-embeddings.ts.
 * Stores Float32Array embeddings as raw Buffer BLOBs in a separate table.
 * Loads all vectors for a project into memory for brute-force cosine scan.
 */

import { Database } from "bun:sqlite";
import type { Memory, SearchResult } from "./types";
import { EMBEDDING_DIMENSIONS } from "./embeddings";

// === Row Interfaces ===

interface EmbeddingRow {
  memoryId: number;
  embedding: Buffer;
  modelId: string;
}

interface ModelIdRow {
  modelId: string;
}

interface UnembeddedRow {
  id: number;
  content: string;
}

interface CoverageRow {
  total: number;
  embedded: number;
}

// === Cosine Similarity (from magic-context) ===

export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dotProduct / denom;
}

// === Schema ===

const VECTOR_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS memory_embeddings (
  memory_id INTEGER NOT NULL,
  model_id TEXT NOT NULL,
  embedding BLOB NOT NULL,
  dims INTEGER NOT NULL DEFAULT ${EMBEDDING_DIMENSIONS},
  created_at INTEGER NOT NULL,
  PRIMARY KEY (memory_id, model_id),
  FOREIGN KEY (memory_id) REFERENCES memories(id) ON DELETE CASCADE
);
`;

// === Storage Operations ===

function toFloat32Array(blob: Buffer | Uint8Array | ArrayBuffer): Float32Array {
  if (blob instanceof Uint8Array) {
    const buf = blob.buffer.slice(blob.byteOffset, blob.byteOffset + blob.byteLength);
    return new Float32Array(buf);
  }
  if (blob instanceof ArrayBuffer) {
    return new Float32Array(blob.slice(0));
  }
  // Buffer (bun:sqlite returns Buffer for BLOB)
  const buf = (blob as Buffer);
  return new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
}

function embeddingToBuffer(embedding: Float32Array): Buffer {
  return Buffer.from(
    embedding.buffer,
    embedding.byteOffset,
    embedding.byteLength,
  );
}

export interface StoredEmbedding {
  memoryId: number;
  embedding: Float32Array;
  modelId: string;
}

export class VectorStore {
  private db: Database;
  private stmtSave: any;
  private stmtLoadAll: any;
  private stmtDelete: any;
  private stmtDeleteAll: any;
  private stmtGetModelIds: any;
  private stmtUnembedded: any;
  private stmtEmbedCoverage: any;
  private _embeddingCache = new Map<string, { data: Map<number, StoredEmbedding>; expiresAt: number }>();
  private static CACHE_TTL_MS = 60_000;

  constructor(db: Database) {
    this.db = db;
    this.db.exec(VECTOR_SCHEMA_SQL);

    this.stmtSave = this.db.prepare(
      `INSERT INTO memory_embeddings (memory_id, model_id, embedding, dims, created_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(memory_id, model_id) DO UPDATE SET embedding = excluded.embedding, dims = excluded.dims`,
    );
    this.stmtLoadAll = this.db.prepare(
      `SELECT me.memory_id AS memoryId, me.embedding, me.model_id AS modelId
       FROM memory_embeddings me
       INNER JOIN memories m ON m.id = me.memory_id
       WHERE m.project_path = ? AND me.model_id = ?
       ORDER BY me.memory_id ASC`,
    );
    this.stmtDelete = this.db.prepare(
      "DELETE FROM memory_embeddings WHERE memory_id = ?",
    );
    this.stmtDeleteAll = this.db.prepare(
      `DELETE FROM memory_embeddings WHERE memory_id IN (
        SELECT id FROM memories WHERE project_path = ?
      )`,
    );
    this.stmtGetModelIds = this.db.prepare(
      `SELECT DISTINCT me.model_id AS modelId
       FROM memory_embeddings me
       INNER JOIN memories m ON m.id = me.memory_id
       WHERE m.project_path = ?`,
    );
    this.stmtUnembedded = this.db.prepare(
      `SELECT m.id, m.content FROM memories m
       LEFT JOIN memory_embeddings me ON m.id = me.memory_id AND me.model_id = ?
       WHERE m.project_path = ? AND m.status IN ('active', 'permanent')
         AND (m.expires_at IS NULL OR m.expires_at > ?)
         AND me.memory_id IS NULL
       LIMIT ?`,
    );
    this.stmtEmbedCoverage = this.db.prepare(
      `SELECT
         COUNT(*) AS total,
         SUM(CASE WHEN EXISTS (
           SELECT 1 FROM memory_embeddings e WHERE e.memory_id = m.id AND e.model_id = ?
         ) THEN 1 ELSE 0 END) AS embedded
       FROM memories m
       WHERE m.project_path = ? AND m.status IN ('active', 'permanent')
         AND (m.expires_at IS NULL OR m.expires_at > ?)`,
    );
  }

  saveEmbedding(memoryId: number, embedding: Float32Array, modelId: string): void {
    const blob = embeddingToBuffer(embedding);
    this.stmtSave.run(memoryId, modelId, blob, embedding.length, Date.now());
    this._embeddingCache.clear();
  }

  loadAllEmbeddings(projectPath: string, modelId: string): Map<number, StoredEmbedding> {
    const cacheKey = `${projectPath}\0${modelId}`;
    const cached = this._embeddingCache.get(cacheKey);
    if (cached && Date.now() < cached.expiresAt) {
      return cached.data;
    }
    const rows = this.stmtLoadAll.all(projectPath, modelId) as EmbeddingRow[];
    const map = new Map<number, StoredEmbedding>();
    for (const row of rows) {
      map.set(row.memoryId, {
        memoryId: row.memoryId,
        embedding: toFloat32Array(row.embedding),
        modelId: row.modelId,
      });
    }
    this._embeddingCache.set(cacheKey, {
      data: map,
      expiresAt: Date.now() + VectorStore.CACHE_TTL_MS,
    });
    return map;
  }

  /** Invalidate the embedding cache (call after saves/deletes). */
  invalidateEmbeddingCache(projectPath?: string): void {
    if (projectPath) {
      for (const key of this._embeddingCache.keys()) {
        if (key.startsWith(projectPath)) this._embeddingCache.delete(key);
      }
    } else {
      this._embeddingCache.clear();
    }
  }

  deleteEmbedding(memoryId: number): void {
    this.stmtDelete.run(memoryId);
    this._embeddingCache.clear();
  }

  clearEmbeddings(projectPath: string): number {
    const changes = this.stmtDeleteAll.run(projectPath).changes;
    this._embeddingCache.clear();
    return changes;
  }

  getStoredModelIds(projectPath: string): string[] {
    const rows = this.stmtGetModelIds.all(projectPath) as ModelIdRow[];
    return rows.map((r) => r.modelId).filter(Boolean);
  }

  getUnembeddedMemories(
    projectPath: string,
    modelId: string,
    limit = 50,
  ): Array<{ id: number; content: string }> {
    const now = Date.now();
    return this.stmtUnembedded.all(modelId, projectPath, now, limit) as UnembeddedRow[];
  }

  getEmbedCoverage(
    projectPath: string,
    modelId: string,
  ): { embedded: number; total: number } {
    const now = Date.now();
    const row = this.stmtEmbedCoverage.get(modelId, projectPath, now) as CoverageRow | undefined;
    return {
      total: row?.total ?? 0,
      embedded: row?.embedded ?? 0,
    };
  }
}

// === Vector Search ===

const SEMANTIC_WEIGHT = 0.7;
const FTS_WEIGHT = 0.3;

/**
 * Search memories using vector cosine similarity against a query embedding.
 * Returns results with semantic scores (0-1 range).
 */
export function searchVector(
  vectorStore: VectorStore,
  projectPath: string,
  modelId: string,
  queryEmbedding: Float32Array,
  memories: Memory[],
  limit: number,
): SearchResult[] {
  const storedEmbeddings = vectorStore.loadAllEmbeddings(projectPath, modelId);
  if (storedEmbeddings.size === 0) return [];

  const results: SearchResult[] = [];

  for (const memory of memories) {
    const stored = storedEmbeddings.get(memory.id);
    if (!stored) continue;

    const score = cosineSimilarity(queryEmbedding, stored.embedding);
    if (score > 0) {
      results.push({
        memory,
        score,
        matchType: "semantic",
      });
    }
  }

  results.sort((a, b) => b.score - a.score);
  return results.slice(0, limit);
}

/**
 * Blend FTS and vector scores with weighted combination.
 * Normalizes both score ranges to [0, 1] before blending.
 */
export function blendResults(
  ftsResults: SearchResult[],
  vectorResults: SearchResult[],
  limit: number,
): SearchResult[] {
  // Normalize FTS scores to [0, 1]
  const maxFts = Math.max(...ftsResults.map((r) => r.score), 1);
  const normalizedFts = ftsResults.map((r) => ({
    ...r,
    score: r.score / maxFts,
    matchType: "combined" as const,
  }));

  // Normalize vector scores to [0, 1]
  const maxVec = Math.max(...vectorResults.map((r) => r.score), 1);
  const normalizedVec = vectorResults.map((r) => ({
    ...r,
    score: r.score / maxVec,
    matchType: "combined" as const,
  }));

  // Merge by memory ID, blending scores
  const merged = new Map<number, { memory: Memory; score: number; matchType: "combined" }>();

  for (const r of normalizedFts) {
    merged.set(r.memory.id, {
      memory: r.memory,
      score: r.score * FTS_WEIGHT,
      matchType: "combined",
    });
  }

  for (const r of normalizedVec) {
    const existing = merged.get(r.memory.id);
    if (existing) {
      existing.score += r.score * SEMANTIC_WEIGHT;
    } else {
      merged.set(r.memory.id, {
        memory: r.memory,
        score: r.score * SEMANTIC_WEIGHT,
        matchType: "combined",
      });
    }
  }

  return Array.from(merged.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}
