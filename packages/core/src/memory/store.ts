/**
 * SQLite-backed memory store using bun:sqlite.
 *
 * Adapted from dev/opencode-magic-context storage-memory.ts and
 * dev/opencode-magic-context decay-curve.ts. Uses bun:sqlite directly
 * (bun runtime) instead of the abstract Database type from magic-context.
 */

import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import {
  type Memory,
  type MemoryCategory,
  type MemoryInput,
  type MemoryScope,
  type MemorySourceType,
  type MemoryStatus,
  type MemoryPayload,
  type PayloadType,
  CATEGORY_DEFAULT_TTL,
  MEMORY_CATEGORY_ORDER_SQL,
} from "./types";
import { tier, shouldArchive, computeBudgetPressure } from "./decay";
import { VectorStore } from "./vector-store";
import { embed, DEFAULT_EMBEDDING_MODEL } from "./embeddings";
import { rowToMemory } from "./memory-utils";
import { KnowledgeGraph } from "./knowledge-graph";

// === Row Interfaces ===

/** Raw row shape returned from SQLite memories table queries */
export interface MemoryRow {
  id: number;
  project_path: string;
  category: string;
  content: string;
  importance: number;
  scope?: string;
  source_session_id: string | null;
  source_type: string;
  seen_count: number;
  retrieval_count: number;
  created_at: number;
  updated_at: number;
  last_seen_at?: number;
  last_retrieved_at: number | null;
  status: string;
  normalized_hash: string;
  expires_at: number | null;
  payload_type: string | null;
  payload: string | null;
}

// === Normalized hash (from magic-context normalize-hash.ts) ===

function normalizeMemoryContent(content: string): string {
  return content.toLowerCase().replace(/\s+/g, " ").trim();
}

export function computeNormalizedHash(content: string): string {
  const normalized = normalizeMemoryContent(content);
  // SECURITY: Use SHA-256 instead of MD5 for collision resistance
  return createHash("sha256").update(normalized).digest("hex");
}

// === Schema ===

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS memories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_path TEXT NOT NULL,
  category TEXT NOT NULL,
  content TEXT NOT NULL,
  normalized_hash TEXT NOT NULL,
  importance INTEGER NOT NULL DEFAULT 50,
  scope TEXT NOT NULL DEFAULT 'project',
  source_session_id TEXT,
  source_type TEXT NOT NULL DEFAULT 'manual',
  seen_count INTEGER NOT NULL DEFAULT 1,
  retrieval_count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  last_retrieved_at INTEGER,
  status TEXT NOT NULL DEFAULT 'active',
  expires_at INTEGER,
  payload_type TEXT,
  payload TEXT
);

CREATE INDEX IF NOT EXISTS idx_memories_project ON memories(project_path);
CREATE INDEX IF NOT EXISTS idx_memories_category ON memories(category);
CREATE INDEX IF NOT EXISTS idx_memories_hash ON memories(project_path, category, normalized_hash);
CREATE INDEX IF NOT EXISTS idx_memories_status ON memories(status);
CREATE INDEX IF NOT EXISTS idx_memories_expires ON memories(expires_at);
`;

const FTS_SCHEMA_SQL = `
CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
  content,
  content='memories',
  content_rowid='id',
  tokenize='porter unicode61'
);
`;

const FTS_TRIGGERS_SQL = `
CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
  INSERT INTO memories_fts(rowid, content) VALUES (new.id, new.content);
END;
CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, content) VALUES('delete', old.id, old.content);
END;
CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, content) VALUES('delete', old.id, old.content);
  INSERT INTO memories_fts(rowid, content) VALUES (new.id, new.content);
END;
`;

// === Store ===

export class MemoryStore {
  private db: Database;
  private stmtInsert: any;
  private stmtGetById: any;
  private stmtGetByHash: any;
  private stmtGetByProject: any;
  private stmtUpdateSeen: any;
  private stmtUpdateRetrieval: any;
  private stmtUpdateStatus: any;
  private stmtDelete: any;
  private stmtCount: any;
  private stmtGetAll: any;
  private _vectorStore: VectorStore | null = null;
  private _knowledgeGraph: KnowledgeGraph | null = null;



  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.exec("PRAGMA journal_mode=WAL");
    this.db.exec("PRAGMA foreign_keys=ON");
    this.db.exec(SCHEMA_SQL);
    this.db.exec(FTS_SCHEMA_SQL);
    this.db.exec(FTS_TRIGGERS_SQL);

    // Prepare statements
    this.stmtInsert = this.db.prepare(
      `INSERT INTO memories (project_path, category, content, normalized_hash, importance, scope, source_session_id, source_type, seen_count, retrieval_count, created_at, updated_at, last_seen_at, last_retrieved_at, status, expires_at, payload_type, payload)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.stmtGetById = this.db.prepare("SELECT * FROM memories WHERE id = ?");
    this.stmtGetByHash = this.db.prepare(
      "SELECT * FROM memories WHERE project_path = ? AND category = ? AND normalized_hash = ?",
    );
    this.stmtGetByProject = this.db.prepare(
      `SELECT * FROM memories WHERE project_path = ? AND status IN (?, ?) AND (expires_at IS NULL OR expires_at > ?) ORDER BY category ASC, updated_at DESC, id ASC`,
    );
    this.stmtUpdateSeen = this.db.prepare(
      "UPDATE memories SET seen_count = seen_count + 1, last_seen_at = ?, updated_at = ? WHERE id = ?",
    );
    this.stmtUpdateRetrieval = this.db.prepare(
      "UPDATE memories SET retrieval_count = retrieval_count + 1, last_retrieved_at = ?, updated_at = ? WHERE id = ?",
    );
    this.stmtUpdateStatus = this.db.prepare(
      "UPDATE memories SET status = ?, updated_at = ? WHERE id = ?",
    );
    this.stmtDelete = this.db.prepare("DELETE FROM memories WHERE id = ?");
    this.stmtCount = this.db.prepare("SELECT COUNT(*) AS count FROM memories WHERE project_path = ?");
    this.stmtGetAll = this.db.prepare(
      `SELECT * FROM memories WHERE project_path = ? ORDER BY category ASC, updated_at DESC`,
    );
  }

  // === CRUD ===

  insert(input: MemoryInput): Memory {
    const now = Date.now();
    const hash = computeNormalizedHash(input.content);
    const ttl = CATEGORY_DEFAULT_TTL[input.category] ?? null;
    const expiresAt = input.expiresAt ?? (ttl ? now + ttl : null);
    const payloadType = input.payloadType ?? null;
    const payloadJson = input.payload ? JSON.stringify(input.payload) : null;

    const result = this.stmtInsert.run(
      input.projectPath,
      input.category,
      input.content,
      hash,
      input.importance ?? 50,
      "project",
      input.sourceSessionId ?? null,
      input.sourceType ?? "manual",
      1,
      0,
      now,
      now,
      now,
      null,
      "active",
      expiresAt,
      payloadType,
      payloadJson,
    );

    const memory = this.getById(Number(result.lastInsertRowid));
    if (!memory) throw new Error('Failed to retrieve inserted memory');

    // Embed-on-write: generate embedding in background (best-effort)
    if (memory) {
      const memId = memory.id;
      const content = memory.content;
      const projectPath = input.projectPath;
      embed(content).then((embedding) => {
        if (embedding) {
          try {
            const vs = this.getVectorStore();
            vs.saveEmbedding(memId, embedding, DEFAULT_EMBEDDING_MODEL);
          } catch {
            // non-fatal: embedding failure shouldn't block write
          }
        }
      }).catch(() => {});
    }

    return memory;
  }

  getById(id: number): Memory | null {
    const row = this.stmtGetById.get(id) as MemoryRow | undefined;
    return row ? rowToMemory(row) : null;
  }

  getByHash(projectPath: string, category: MemoryCategory, content: string): Memory | null {
    const hash = computeNormalizedHash(content);
    const row = this.stmtGetByHash.get(projectPath, category, hash) as MemoryRow | undefined;
    return row ? rowToMemory(row) : null;
  }

  getByProject(
    projectPath: string,
    statuses: MemoryStatus[] = ["active", "permanent"],
  ): Memory[] {
    const now = Date.now();
    const rows = this.stmtGetByProject.all(
      projectPath,
      ...statuses,
      now,
    ) as MemoryRow[];
    return rows.map((r) => rowToMemory(r));
  }

  getAll(projectPath: string): Memory[] {
    const rows = this.stmtGetAll.all(projectPath) as MemoryRow[];
    return rows.map((r) => rowToMemory(r));
  }

  updateSeen(id: number): void {
    const now = Date.now();
    this.stmtUpdateSeen.run(now, now, id);
  }

  updateRetrieval(id: number): void {
    const now = Date.now();
    this.stmtUpdateRetrieval.run(now, now, id);
  }

  updateStatus(id: number, status: MemoryStatus): void {
    this.stmtUpdateStatus.run(status, Date.now(), id);
  }

  archive(id: number): void {
    this.updateStatus(id, "archived");
  }

  delete(id: number): void {
    this.stmtDelete.run(id);
  }

  count(projectPath: string): number {
    const row = this.stmtCount.get(projectPath) as { count: number } | undefined;
    return row?.count ?? 0;
  }

  getByHashBatch(projectPath: string, categories: MemoryCategory[], hashes: string[]): string[] {
    const existing: string[] = [];
    for (let i = 0; i < hashes.length; i++) {
      const row = this.stmtGetByHash.get(projectPath, categories[i], hashes[i]) as MemoryRow | undefined;
      if (row) existing.push(hashes[i]);
    }
    return existing;
  }

  updateSeenBatch(ids: number[]): void {
    const now = Date.now();
    for (const id of ids) {
      this.stmtUpdateSeen.run(now, now, id);
    }
  }

  insertBatch(projectPath: string, sessionId: string, entries: Array<{ category: MemoryCategory; content: string }>): number {
    const now = Date.now();
    let count = 0;
    const transaction = this.db.transaction(() => {
      for (const entry of entries) {
        const hash = computeNormalizedHash(entry.content);
        const ttl = CATEGORY_DEFAULT_TTL[entry.category] ?? null;
        const expiresAt = ttl ? now + ttl : null;
        this.stmtInsert.run(projectPath, entry.category, entry.content, hash, 50, 'project', sessionId, 'session_promote', 1, 0, now, now, now, null, 'active', expiresAt, null, null);
        count++;
      }
    });
    transaction();
    return count;
  }

  // === Tiered Decay (from decay-curve.ts) ===

  getDecayedTier(
    memoryIndex: number,
    importance: number,
    budgetPressure: number,
  ): number {
    return tier(memoryIndex, importance, budgetPressure);
  }

  shouldArchiveMemory(
    memoryIndex: number,
    importance: number,
    budgetPressure: number,
  ): boolean {
    return shouldArchive(memoryIndex, importance, budgetPressure);
  }

  computeBudgetPressure(
    memories: Array<{ index: number; importance: number }>,
    budget: number,
  ): number {
    return computeBudgetPressure(memories, budget);
  }

  // === Vector Store ===

  getVectorStore(): VectorStore {
    if (!this._vectorStore) {
      this._vectorStore = new VectorStore(this.db);
    }
    return this._vectorStore;
  }

  // === Knowledge Graph ===

  getKnowledgeGraph(): KnowledgeGraph {
    if (!this._knowledgeGraph) {
      this._knowledgeGraph = new KnowledgeGraph(this.db);
    }
    return this._knowledgeGraph;
  }

  /** Expose raw db for vector store access from search module */
  getDb(): Database {
    return this.db;
  }

  // === Cleanup ===

  pruneExpired(): number {
    const result = this.db
      .prepare(
        "UPDATE memories SET status = 'archived', updated_at = ? WHERE status = 'active' AND expires_at IS NOT NULL AND expires_at <= ?",
      )
      .run(Date.now(), Date.now());
    return result.changes;
  }

  close(): void {
    this.db.close();
  }

}

// === Singleton ===

const _instances = new Map<string, MemoryStore>();

export function getMemoryStore(dbPath: string): MemoryStore {
  let instance = _instances.get(dbPath);
  if (!instance) {
    instance = new MemoryStore(dbPath);
    _instances.set(dbPath, instance);
  }
  return instance;
}

export function getKnowledgeGraph(dbPath: string): KnowledgeGraph {
  return getMemoryStore(dbPath).getKnowledgeGraph();
}

// SECURITY: Close all singleton stores on process exit to prevent data corruption.
// SQLite WAL mode requires proper shutdown to flush the WAL to the main database.
function closeAllStores(): void {
  for (const [path, store] of _instances) {
    try {
      store.close();
    } catch {
      // Best-effort: don't crash during shutdown
    }
  }
  _instances.clear();
}

process.on("exit", closeAllStores);
process.on("SIGINT", () => { closeAllStores(); process.exit(0); });
process.on("SIGTERM", () => { closeAllStores(); process.exit(0); });
