/**
 * Memory search — BM25 FTS5 with vector semantic search and TF-IDF fallback.
 *
 * Adapted from dev/opencode-magic-context storage-memory-fts.ts.
 * The BM25 path uses SQLite FTS5 directly. Vector search provides true
 * semantic matching via embeddings. TF-IDF is the lightweight fallback.
 */

import type { Memory, SearchResult } from "./types";
import { MemoryStore, type MemoryRow } from "./store";
import { embed, isEmbeddingsReady, DEFAULT_EMBEDDING_MODEL } from "./embeddings";
import { searchVector, blendResults } from "./vector-store";
import { rowToMemory } from "./memory-utils";
import type { KnowledgeGraph } from "./knowledge-graph";

/** FTS query result row — MemoryRow plus computed bm25_score */
interface FtsRow extends MemoryRow {
  bm25_score: number;
}

const DEFAULT_SEARCH_LIMIT = 10;
const FEEDBACK_INFLUENCE = 0.3;

export type SearchMode = "hybrid" | "semantic" | "fts" | "tfidf" | "graph";

// === FTS5 Query Sanitization (from magic-context) ===

/**
 * Sanitize a user query for FTS5 MATCH syntax.
 * Wraps each token in double quotes so special characters are literal.
 */
export function sanitizeFtsQuery(query: string): string {
  const tokens = query.split(/\s+/).filter((t) => t.length > 0);
  if (tokens.length === 0) return "";
  return tokens.map((t) => `"${t.replace(/"/g, '""')}"`).join(" ");
}

// === BM25 Search ===

/**
 * Search memories using FTS5 BM25 ranking.
 */
export function searchFTS(
  store: MemoryStore,
  projectPath: string,
  query: string,
  limit = DEFAULT_SEARCH_LIMIT,
): SearchResult[] {
  const trimmed = query.trim();
  if (trimmed.length === 0 || limit <= 0) return [];

  const sanitized = sanitizeFtsQuery(trimmed);
  if (sanitized.length === 0) return [];

  const db = store.getDb();
  const now = Date.now();

  try {
    const rows = db
      .prepare(
        `SELECT m.*, bm25(memories_fts) AS bm25_score
         FROM memories_fts
         INNER JOIN memories m ON m.id = memories_fts.rowid
         WHERE m.project_path = ?
           AND m.status IN ('active', 'permanent')
           AND (m.expires_at IS NULL OR m.expires_at > ?)
           AND memories_fts MATCH ?
         ORDER BY bm25(memories_fts), m.updated_at DESC, m.id ASC
         LIMIT ?`,
      )
      .all(projectPath, now, sanitized, limit) as FtsRow[];

    return rows.map((row) => ({
      memory: rowToMemory(row),
      score: -row.bm25_score, // bm25 returns negative (lower = better)
      matchType: "fts" as const,
    }));
  } catch {
    return [];
  }
}

// === TF-IDF Cosine Similarity Fallback ===

/**
 * Tokenize text into lowercased words.
 */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[\s,;:!?.()[\]{}'"]+/)
    .filter((t) => t.length > 1);
}

/**
 * Compute term frequency for a document.
 */
function termFreq(terms: string[]): Map<string, number> {
  const freq = new Map<string, number>();
  for (const t of terms) {
    freq.set(t, (freq.get(t) ?? 0) + 1);
  }
  // Normalize by doc length
  const len = terms.length;
  if (len > 0) {
    for (const [k, v] of freq) {
      freq.set(k, v / len);
    }
  }
  return freq;
}

// IDF corpus cache
let _idfCacheKey = "";
let _idfCache: Map<string, number> | null = null;

export function invalidateIdfCache(): void {
  _idfCache = null;
  _idfCacheKey = "";
}

/**
 * Compute inverse document frequency for terms across a corpus.
 */
function idf(corpus: Map<string, number>[], totalDocs: number): Map<string, number> {
  const key = `${totalDocs}:${corpus.length}`;
  if (_idfCache && _idfCacheKey === key) return _idfCache;
  const docFreq = new Map<string, number>();
  for (const doc of corpus) {
    for (const term of doc.keys()) {
      docFreq.set(term, (docFreq.get(term) ?? 0) + 1);
    }
  }
  const result = new Map<string, number>();
  for (const [term, df] of docFreq) {
    result.set(term, Math.log((totalDocs + 1) / (df + 1)) + 1);
  }
  _idfCacheKey = key;
  _idfCache = result;
  return result;
}

/**
 * Compute cosine similarity between two TF-IDF vectors.
 */
function cosineSimilarity(a: Map<string, number>, b: Map<string, number>): number {
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (const [term, tfidf] of a) {
    const other = b.get(term) ?? 0;
    dotProduct += tfidf * other;
    normA += tfidf * tfidf;
  }
  for (const tfidf of b.values()) {
    normB += tfidf * tfidf;
  }

  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dotProduct / denom;
}

/**
 * Search memories using TF-IDF cosine similarity.
 * Used as fallback when FTS5 returns insufficient results.
 */
export function searchTFIDF(
  store: MemoryStore,
  projectPath: string,
  query: string,
  limit = DEFAULT_SEARCH_LIMIT,
): SearchResult[] {
  const queryTerms = tokenize(query);
  if (queryTerms.length === 0) return [];

  const memories = store.getByProject(projectPath);
  if (memories.length === 0) return [];

  // Build corpus TF maps
  const docTFs = memories.map((m) => termFreq(tokenize(m.content)));
  const idfMap = idf(docTFs, memories.length);

  // Compute query TF-IDF
  const queryTF = termFreq(queryTerms);
  const queryTFIDF = new Map<string, number>();
  for (const [term, tf] of queryTF) {
    const idfVal = idfMap.get(term) ?? 1;
    queryTFIDF.set(term, tf * idfVal);
  }

  // Score each document
  const results: SearchResult[] = [];
  for (let i = 0; i < memories.length; i++) {
    const docTFIDF = new Map<string, number>();
    for (const [term, tf] of docTFs[i]) {
      const idfVal = idfMap.get(term) ?? 1;
      docTFIDF.set(term, tf * idfVal);
    }
    const score = cosineSimilarity(queryTFIDF, docTFIDF);
    if (score > 0) {
      results.push({
        memory: memories[i],
        score,
        matchType: "semantic",
      });
    }
  }

  results.sort((a, b) => b.score - a.score);
  return results.slice(0, limit);
}

// === Combined Search ===

/**
 * Search memories with vector embeddings + BM25, or fallback to TF-IDF.
 *
 * Modes:
 *  - "hybrid" (default): blend vector semantic + BM25 scores (SEMANTIC_WEIGHT=0.7, FTS_WEIGHT=0.3)
 *  - "semantic": vector-only search (requires embeddings enabled)
 *  - "fts": BM25-only (lexical)
 *  - "tfidf": TF-IDF cosine only (lightweight semantic fallback)
 *  - "graph": knowledge graph search (concept traversal)
 */
export async function searchMemories(
  store: MemoryStore,
  projectPath: string,
  query: string,
  limit = DEFAULT_SEARCH_LIMIT,
  mode: SearchMode = "hybrid",
): Promise<SearchResult[]> {
  // Graph mode: search knowledge graph for related concepts
  if (mode === "graph") {
    return searchGraph(store, projectPath, query, limit);
  }

  // Semantic-only or hybrid with embeddings
  if ((mode === "semantic" || mode === "hybrid") && isEmbeddingsReady()) {
    const queryEmbedding = await embed(query);
    if (queryEmbedding) {
      // For semantic-only, just do vector search
      if (mode === "semantic") {
        const allMemories = store.getByProject(projectPath);
        const vectorStore = store.getVectorStore();
        const results = searchVector(vectorStore, projectPath, DEFAULT_EMBEDDING_MODEL, queryEmbedding, allMemories, limit);
        return applyFeedbackWeight(results);
      }

      // Hybrid: blend vector + BM25
      const ftsResults = searchFTS(store, projectPath, query, limit);
      const allMemories = store.getByProject(projectPath);
      const vectorStore = store.getVectorStore();
      const vectorResults = searchVector(vectorStore, projectPath, DEFAULT_EMBEDDING_MODEL, queryEmbedding, allMemories, limit);

      if (vectorResults.length === 0 && ftsResults.length === 0) return [];
      if (vectorResults.length === 0) return applyFeedbackWeight(ftsResults.slice(0, limit));
      if (ftsResults.length === 0) return applyFeedbackWeight(vectorResults.slice(0, limit));

      return applyFeedbackWeight(blendResults(ftsResults, vectorResults, limit));
    }
  }

  // FTS-only mode or embeddings unavailable — fall back to original behavior
  const ftsResults = searchFTS(store, projectPath, query, limit);

  if (mode === "fts") return applyFeedbackWeight(ftsResults.slice(0, limit));

  if (ftsResults.length >= limit) {
    return applyFeedbackWeight(ftsResults.slice(0, limit));
  }

  // Fill remaining with TF-IDF results not already found
  const existingIds = new Set(ftsResults.map((r) => r.memory.id));
  const remaining = limit - ftsResults.length;
  const tfidfResults = searchTFIDF(store, projectPath, query, remaining * 2);

  const combined = [...ftsResults];
  for (const r of tfidfResults) {
    if (!existingIds.has(r.memory.id) && combined.length < limit) {
      combined.push(r);
      existingIds.add(r.memory.id);
    }
  }

  // Re-rank by blending scores
  return applyFeedbackWeight(combined.sort((a, b) => b.score - a.score));
}

/**
 * Backfill embeddings for all unembedded memories in a project.
 * Best-effort: skips failures, returns count of newly embedded.
 */
export async function backfillEmbeddings(
  store: MemoryStore,
  projectPath: string,
  modelId = DEFAULT_EMBEDDING_MODEL,
  batchSize = 20,
): Promise<number> {
  if (!isEmbeddingsReady()) return 0;

  const vectorStore = store.getVectorStore();
  let totalEmbedded = 0;

  while (true) {
    const unembedded = vectorStore.getUnembeddedMemories(projectPath, modelId, batchSize);
    if (unembedded.length === 0) break;

    const texts = unembedded.map((m) => m.content);
    const { embedBatch } = await import("./embeddings");
    const embeddings = await embedBatch(texts, modelId);

    for (let i = 0; i < unembedded.length; i++) {
      if (embeddings[i]) {
        try {
          vectorStore.saveEmbedding(unembedded[i].id, embeddings[i]!, modelId);
          totalEmbedded++;
        } catch {
          // skip individual failures
        }
      }
    }
  }

  return totalEmbedded;
}

// === Feedback-Weighted Retrieval ===

/**
 * Compute average feedback score for a memory from its feedback payload.
 * Returns null if no feedback payload exists.
 */
function getAverageFeedback(memory: Memory): number | null {
  if (!memory.payload || memory.payload.type !== "feedback") return null;
  return memory.payload.score;
}

/**
 * Apply feedback multiplier to search results.
 * finalScore = blendedScore * (1 + feedbackInfluence * avgFeedback)
 */
export function applyFeedbackWeight(results: SearchResult[]): SearchResult[] {
  return results.map((r) => {
    const feedback = getAverageFeedback(r.memory);
    if (feedback === null) return r;
    return {
      ...r,
      score: r.score * (1 + FEEDBACK_INFLUENCE * feedback),
    };
  });
}

// === Graph Search ===

/**
 * Search the knowledge graph for related concepts, return connected memories.
 */
export function searchGraph(
  store: MemoryStore,
  projectPath: string,
  query: string,
  limit = DEFAULT_SEARCH_LIMIT,
): SearchResult[] {
  const kg = store.getKnowledgeGraph();
  const nodes = kg.searchNodes(projectPath, query, limit);
  if (nodes.length === 0) return [];

  const seenMemoryIds = new Set<number>();
  const results: SearchResult[] = [];

  for (const node of nodes) {
    const connections = kg.getConnections(node.id);
    for (const edge of connections) {
      const neighborId = edge.sourceId === node.id ? edge.targetId : edge.sourceId;
      const neighbor = kg.getNode(neighborId);
      if (!neighbor) continue;

      // Try to find a memory with matching name in the project
      const memories = store.getByProject(projectPath);
      for (const mem of memories) {
        if (seenMemoryIds.has(mem.id)) continue;
        if (mem.content.toLowerCase().includes(neighbor.name.toLowerCase()) ||
            mem.content.toLowerCase().includes(neighbor.content.toLowerCase())) {
          seenMemoryIds.add(mem.id);
          results.push({ memory: mem, score: edge.weight, matchType: "combined" });
          if (results.length >= limit) break;
        }
      }
      if (results.length >= limit) break;
    }
    if (results.length >= limit) break;
  }

  return results;
}
