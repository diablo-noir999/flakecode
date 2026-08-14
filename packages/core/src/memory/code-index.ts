/**
 * Codebase semantic search — indexes source files for semantic search.
 *
 * Scans project source files, chunks them into embeddable units,
 * stores embeddings in SQLite, and supports semantic similarity search.
 *
 * Optimized: async FS, parallel chunking/embedding, batched DB writes,
 * incremental indexing, and progress reporting.
 */

import { Database } from "bun:sqlite";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative, extname } from "node:path";
import { embedBatch, DEFAULT_EMBEDDING_MODEL } from "./embeddings";
import { cosineSimilarity } from "./vector-store";

// Inline constants (replacing ../constants imports)
const EMBEDDING_DIMENSIONS = 768;

// === Concurrency helper ===

async function parallelMap<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const i = nextIndex++;
      results[i] = await fn(items[i], i);
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

// === Constants ===

const FILE_READ_CONCURRENCY = 32;
const EMBED_CONCURRENCY = 2;
const EMBED_CHUNK_SIZE = 256;
const DB_BATCH_SIZE = 500;
const SCAN_CONCURRENCY = 16;

// === Types ===

export interface CodeChunk {
  id: number;
  filePath: string;
  startLine: number;
  endLine: number;
  chunkType: "file" | "function" | "window";
  content: string;
}

export interface CodeSearchResult {
  chunk: CodeChunk;
  score: number;
}

export interface IndexProgress {
  stage: "scanning" | "chunking" | "embedding" | "writing";
  processed: number;
  total: number;
  file: string;
  startedAt: number;
}

interface CodeChunkRow {
  id: number;
  project_path: string;
  file_path: string;
  start_line: number;
  end_line: number;
  chunk_type: string;
  content: string;
  embedding: Buffer | null;
  model_id: string;
  indexed_at: number;
}

interface StatsRow {
  files: number;
  chunks: number;
}

// === Schema ===

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS code_chunks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_path TEXT NOT NULL,
  file_path TEXT NOT NULL,
  start_line INTEGER NOT NULL,
  end_line INTEGER NOT NULL,
  chunk_type TEXT NOT NULL,
  content TEXT NOT NULL,
  embedding BLOB,
  model_id TEXT NOT NULL,
  indexed_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_code_chunks_project ON code_chunks(project_path);
CREATE INDEX IF NOT EXISTS idx_code_chunks_file ON code_chunks(project_path, file_path);
CREATE INDEX IF NOT EXISTS idx_code_chunks_model ON code_chunks(model_id);
`;

// === Chunking ===

const INCLUDE_EXTS = new Set([".ts", ".tsx", ".js", ".jsx", ".py", ".go", ".rs", ".java", ".rb"]);
const SKIP_DIRS = new Set(["node_modules", "dist", ".git", ".mimocode", ".powerpack", "tmp"]);

// Tree-sitter availability check (loaded lazily)
let treeSitterAvailable = false;
let treeSitterProcess: typeof import("@xberg-io/tree-sitter-language-pack")["process"] | null = null;
let treeSitterDetectLanguage: typeof import("@xberg-io/tree-sitter-language-pack")["detectLanguageFromContent"] | null = null;
let treeSitterHasLanguage: typeof import("@xberg-io/tree-sitter-language-pack")["hasLanguage"] | null = null;

let treeSitterPromise: Promise<void> | null = null;

async function ensureTreeSitter(): Promise<void> {
  if (treeSitterAvailable) return;
  if (!treeSitterPromise) {
    treeSitterPromise = (async () => {
      try {
        const ts = await import("@xberg-io/tree-sitter-language-pack");
        treeSitterProcess = ts.process;
        treeSitterDetectLanguage = ts.detectLanguageFromContent;
        treeSitterHasLanguage = ts.hasLanguage;
        treeSitterAvailable = true;
      } catch {
        // Package not installed — regex fallback will be used
      }
    })();
  }
  return treeSitterPromise;
}

const LANG_MAP: Record<string, string> = {
  ".ts": "typescript",
  ".tsx": "typescriptreact",
  ".js": "javascript",
  ".jsx": "javascriptreact",
  ".py": "python",
  ".go": "go",
  ".rs": "rust",
  ".java": "java",
  ".rb": "ruby",
  ".c": "c",
  ".cpp": "cpp",
};

function shouldSkipFile(name: string): boolean {
  if (name.endsWith(".db")) return true;
  return false;
}

function chunkFile(content: string, filePath: string, chunkSizeTokens: number = 2048): Omit<CodeChunk, "id">[] {
  if (!content.trim()) return [];

  // Try tree-sitter AST-aware chunking
  if (treeSitterAvailable && treeSitterProcess) {
    try {
      return chunkFileTreeSitter(content, filePath, chunkSizeTokens);
    } catch {
      // Fall through to regex fallback
    }
  }

  // Regex fallback
  return chunkFileRegex(content, filePath);
}

function chunkFileTreeSitter(content: string, filePath: string, chunkSizeTokens: number): Omit<CodeChunk, "id">[] {
  const ext = extname(filePath).toLowerCase();
  const language = LANG_MAP[ext] || "auto";

  // Estimate byte budget from token count (Chonkie's approach)
  const textBytes = Buffer.byteLength(content, "utf-8");
  const textChars = content.length;
  const bytesPerToken = textChars > 0 ? textBytes / textChars : 1;
  const chunkMaxBytes = Math.max(1, Math.floor(chunkSizeTokens * bytesPerToken));

  const result = treeSitterProcess!(content, {
    language,
    chunkMaxSize: chunkMaxBytes,
    structure: true,
  });

  if (!result.chunks || result.chunks.length === 0) {
    // Fallback: whole file as one chunk
    return [{
      filePath,
      startLine: 1,
      endLine: content.split("\n").length,
      chunkType: "file",
      content,
    }];
  }

  return result.chunks.map((cc: any) => {
    const nodeType = cc.metadata?.nodeTypes?.[0];
    const chunkType: CodeChunk["chunkType"] =
      nodeType === "function_definition" || nodeType === "function_declaration" || nodeType === "method_definition"
        ? "function"
        : nodeType === "class_definition" || nodeType === "class_declaration"
          ? "function"
          : "file";

    return {
      filePath,
      startLine: (cc.startLine ?? 0) + 1, // tree-sitter uses 0-indexed
      endLine: (cc.endLine ?? 0) + 1,
      chunkType,
      content: cc.content,
    };
  });
}

// Regex fallback (original approach)

function chunkFileRegex(content: string, filePath: string): Omit<CodeChunk, "id">[] {
  const lines = content.split("\n");
  if (lines.length === 0) return [];

  // Small file: embed as single chunk
  if (lines.length <= 100) {
    return [{ filePath, startLine: 1, endLine: lines.length, chunkType: "file", content }];
  }

  // Medium file: split by top-level function/class boundaries
  if (lines.length <= 500) {
    const chunks = splitByBoundaries(lines, filePath);
    if (chunks.length > 1) return chunks;
  }

  // Large file or no boundaries found: windowed split
  return splitByWindow(lines, filePath);
}

const FUNCTION_PATTERN = /^(export\s+)?(async\s+)?(function|class|const\s+\w+\s*=\s*(async\s+)?\(|interface|type)\s/m;

function splitByBoundaries(lines: string[], filePath: string): Omit<CodeChunk, "id">[] {
  const chunks: Omit<CodeChunk, "id">[] = [];
  let lastBreak = 0;

  for (let i = 0; i < lines.length; i++) {
    if (FUNCTION_PATTERN.test(lines[i]) && i > lastBreak + 10) {
      const chunkContent = lines.slice(lastBreak, i).join("\n").trim();
      if (chunkContent.length > 50) {
        chunks.push({
          filePath,
          startLine: lastBreak + 1,
          endLine: i,
          chunkType: "function",
          content: chunkContent,
        });
      }
      lastBreak = i;
    }
  }

  if (lastBreak < lines.length) {
    const chunkContent = lines.slice(lastBreak).join("\n").trim();
    if (chunkContent.length > 50) {
      chunks.push({
        filePath,
        startLine: lastBreak + 1,
        endLine: lines.length,
        chunkType: "function",
        content: chunkContent,
      });
    }
  }

  return chunks.filter((c) => c.content.length > 50);
}

function splitByWindow(lines: string[], filePath: string, windowSize = 100, overlap = 20): Omit<CodeChunk, "id">[] {
  const chunks: Omit<CodeChunk, "id">[] = [];
  let start = 0;

  while (start < lines.length) {
    const end = Math.min(start + windowSize, lines.length);
    const chunkContent = lines.slice(start, end).join("\n").trim();

    if (chunkContent.length > 50) {
      chunks.push({
        filePath,
        startLine: start + 1,
        endLine: end,
        chunkType: "window",
        content: chunkContent,
      });
    }

    if (end >= lines.length) break;
    start = end - overlap;
  }

  return chunks;
}

// === Embedding helpers ===

function embeddingToBuffer(embedding: Float32Array): Buffer {
  return Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength);
}

function bufferToFloat32Array(buf: Buffer): Float32Array {
  const arrayBuf = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  return new Float32Array(arrayBuf);
}

// === CodeIndexer ===

export class CodeIndexer {
  private db: Database;
  private stmtInsert: any;
  private stmtDeleteByProject: any;
  private stmtDeleteByFile: any;
  private stmtGetByFile: any;
  private stmtGetAllByProject: any;
  private stmtCount: any;
  private stmtHasEmbedding: any;
  private stmtGetIndexedTime: any;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.exec("PRAGMA journal_mode=WAL");
    this.db.exec("PRAGMA cache_size=-65536"); // 64 MB page cache
    this.db.exec("PRAGMA synchronous=NORMAL");
    this.db.exec("PRAGMA mmap_size=268435456"); // 256 MB mmap
    this.db.exec(SCHEMA_SQL);

    this.stmtInsert = this.db.prepare(
      `INSERT INTO code_chunks (project_path, file_path, start_line, end_line, chunk_type, content, embedding, model_id, indexed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.stmtDeleteByProject = this.db.prepare("DELETE FROM code_chunks WHERE project_path = ?");
    this.stmtDeleteByFile = this.db.prepare("DELETE FROM code_chunks WHERE project_path = ? AND file_path = ?");
    this.stmtGetByFile = this.db.prepare(
      "SELECT * FROM code_chunks WHERE project_path = ? AND file_path = ?",
    );
    this.stmtGetAllByProject = this.db.prepare(
      "SELECT * FROM code_chunks WHERE project_path = ?",
    );
    this.stmtCount = this.db.prepare(
      "SELECT COUNT(DISTINCT file_path) AS files, COUNT(*) AS chunks FROM code_chunks WHERE project_path = ?",
    );
    this.stmtHasEmbedding = this.db.prepare(
      "SELECT id FROM code_chunks WHERE project_path = ? AND embedding IS NOT NULL LIMIT 1",
    );
    this.stmtGetIndexedTime = this.db.prepare(
      "SELECT MAX(indexed_at) AS last_indexed FROM code_chunks WHERE project_path = ? AND file_path = ?",
    );
  }

  async indexProject(
    projectPath: string,
    options?: {
      exclude?: string[];
      maxChunkLines?: number;
      incremental?: boolean;
      onProgress?: (progress: IndexProgress) => void;
    },
  ): Promise<{ indexed: number; chunks: number; errors: number; skipped: number }> {
    const excludeSet = new Set(options?.exclude ?? []);
    const modelId = DEFAULT_EMBEDDING_MODEL;
    const startedAt = Date.now();

    await ensureTreeSitter();

    const report = (stage: IndexProgress["stage"], processed: number, total: number, file: string) => {
      options?.onProgress?.({ stage, processed, total, file, startedAt });
    };

    // --- Stage 1: Scan files ---
    report("scanning", 0, 0, "");
    const allFiles = await this.scanFilesAsync(projectPath, excludeSet);

    // --- Incremental: filter unchanged files ---
    let files = allFiles;
    let skipped = 0;
    if (options?.incremental) {
      const filtered = await this.filterUnchangedFiles(projectPath, allFiles);
      skipped = allFiles.length - filtered.length;
      files = filtered;
    }

    if (files.length === 0) {
      return { indexed: 0, chunks: 0, errors: 0, skipped };
    }

    report("scanning", allFiles.length, allFiles.length, "");

    // --- Stage 2: Parallel read + chunk ---
    report("chunking", 0, files.length, "");
    const fileResults = await parallelMap(files, FILE_READ_CONCURRENCY, async (filePath) => {
      const content = await readFile(filePath, "utf-8");
      const relPath = relative(projectPath, filePath);
      const fileChunks = chunkFile(content, relPath);
      return { filePath, relPath, chunks: fileChunks };
    });

    // Flatten chunks, count errors
    let indexed = 0;
    let errors = 0;
    let totalChunks = 0;
    const allChunks: { relPath: string; chunk: Omit<CodeChunk, "id"> }[] = [];

    for (const result of fileResults) {
      if (result.chunks.length === 0) {
        errors++;
        continue;
      }
      indexed++;
      for (const chunk of result.chunks) {
        allChunks.push({ relPath: result.relPath, chunk });
        totalChunks++;
      }
    }

    report("chunking", files.length, files.length, "");

    if (allChunks.length === 0) {
      return { indexed, chunks: 0, errors, skipped };
    }

    // --- Stage 3: Parallel embedding in batches ---
    report("embedding", 0, allChunks.length, "");
    const allEmbeddings = new Array(allChunks.length);

    const embedBatches: { start: number; texts: string[] }[] = [];
    for (let i = 0; i < allChunks.length; i += EMBED_CHUNK_SIZE) {
      embedBatches.push({
        start: i,
        texts: allChunks.slice(i, i + EMBED_CHUNK_SIZE).map((c) => c.chunk.content),
      });
    }

    let embeddedCount = 0;
    await parallelMap(embedBatches, EMBED_CONCURRENCY, async (batch, batchIdx) => {
      const embeddings = await embedBatch(batch.texts, modelId);
      for (let j = 0; j < embeddings.length; j++) {
        allEmbeddings[batch.start + j] = embeddings[j];
      }
      embeddedCount += batch.texts.length;
      report("embedding", embeddedCount, allChunks.length, `batch ${batchIdx + 1}/${embedBatches.length}`);
    });

    // --- Stage 4: Batched DB writes ---
    report("writing", 0, allChunks.length, "");

    // For incremental: delete only re-indexed files
    if (options?.incremental) {
      const indexedFiles = new Set(fileResults.map((r) => r.relPath));
      const deleteBatch = this.db.transaction(() => {
        for (const relPath of indexedFiles) {
          this.stmtDeleteByFile.run(projectPath, relPath);
        }
      });
      deleteBatch();
    } else {
      this.stmtDeleteByProject.run(projectPath);
    }

    const now = Date.now();
    for (let i = 0; i < allChunks.length; i += DB_BATCH_SIZE) {
      const batch = allChunks.slice(i, i + DB_BATCH_SIZE);
      const batchEmbeddings = allEmbeddings.slice(i, i + DB_BATCH_SIZE);

      const insertBatch = this.db.transaction(() => {
        for (let j = 0; j < batch.length; j++) {
          const { relPath, chunk } = batch[j];
          const embedding = batchEmbeddings[j];
          const blob = embedding ? embeddingToBuffer(embedding) : null;
          this.stmtInsert.run(
            projectPath,
            relPath,
            chunk.startLine,
            chunk.endLine,
            chunk.chunkType,
            chunk.content,
            blob,
            modelId,
            now,
          );
        }
      });
      insertBatch();
      report("writing", Math.min(i + DB_BATCH_SIZE, allChunks.length), allChunks.length, "");
    }

    return { indexed, chunks: totalChunks, errors, skipped };
  }

  async search(
    query: string,
    projectPath: string,
    limit = 20,
  ): Promise<CodeSearchResult[]> {
    const modelId = DEFAULT_EMBEDDING_MODEL;
    const queryEmbedding = await embedBatch([query], modelId);
    if (!queryEmbedding[0]) return [];

    // Load all chunks with embeddings for this project
    const rows = this.stmtGetAllByProject.all(projectPath) as CodeChunkRow[];
    const qVec = queryEmbedding[0];

    // Parallel cosine-similarity scoring
    const results = await parallelMap(rows, 4, async (row) => {
      if (!row.embedding) return null;
      const storedEmbedding = bufferToFloat32Array(row.embedding);
      const score = cosineSimilarity(qVec, storedEmbedding);
      if (score > 0.1) {
        return { chunk: rowToChunk(row), score } as CodeSearchResult;
      }
      return null;
    });

    return results
      .filter((r): r is CodeSearchResult => r !== null)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  getChunksForFile(filePath: string, projectPath?: string): CodeChunk[] {
    if (projectPath) {
      const rows = this.stmtGetByFile.all(projectPath, filePath) as CodeChunkRow[];
      return rows.map(rowToChunk);
    }
    // Without projectPath, search all projects (less efficient)
    const rows = this.stmtGetAllByProject.all("") as CodeChunkRow[];
    return rows.filter((r) => r.file_path === filePath).map(rowToChunk);
  }

  clearIndex(projectPath: string): void {
    this.stmtDeleteByProject.run(projectPath);
  }

  stats(projectPath: string): { files: number; chunks: number; indexed: boolean } {
    const row = this.stmtCount.get(projectPath) as StatsRow | undefined;
    const hasEmbedding = this.stmtHasEmbedding.get(projectPath) as { id: number } | undefined;
    return {
      files: row?.files ?? 0,
      chunks: row?.chunks ?? 0,
      indexed: hasEmbedding !== undefined,
    };
  }

  getLastIndexedTime(projectPath: string, filePath: string): number | null {
    const row = this.stmtGetIndexedTime.get(projectPath, filePath) as { last_indexed: number | null } | undefined;
    return row?.last_indexed ?? null;
  }

  close(): void {
    this.db.close();
  }

  // --- Async parallel BFS file scanner ---

  private async scanFilesAsync(dir: string, excludeSet: Set<string>): Promise<string[]> {
    const results: string[] = [];
    const queue: string[] = [dir];

    while (queue.length > 0) {
      const current = queue.splice(0, Math.min(queue.length, 64));
      const entries = await parallelMap(current, SCAN_CONCURRENCY, async (d) => {
        try {
          const dirEntries = await readdir(d, { withFileTypes: true });
          return dirEntries.map((e) => ({ dir: d, entry: e }));
        } catch {
          return [] as { dir: string; entry: any }[];
        }
      });

      for (const batch of entries) {
        for (const { dir: parent, entry } of batch) {
          if (entry.name.startsWith(".") && entry.name !== ".mimocode") continue;
          if (SKIP_DIRS.has(entry.name)) continue;
          if (excludeSet.has(entry.name)) continue;

          const fullPath = join(parent, entry.name);

          if (entry.isDirectory()) {
            queue.push(fullPath);
          } else if (entry.isFile()) {
            if (shouldSkipFile(entry.name)) continue;
            const ext = extname(entry.name);
            if (INCLUDE_EXTS.has(ext)) {
              results.push(fullPath);
            }
          }
        }
      }
    }

    return results;
  }

  // --- Filter files unchanged since last index ---

  private async filterUnchangedFiles(projectPath: string, files: string[]): Promise<string[]> {
    const result = await parallelMap(files, FILE_READ_CONCURRENCY, async (filePath) => {
      const lastIndexed = this.getLastIndexedTime(projectPath, filePath);
      if (lastIndexed === null) return filePath;
      try {
        const st = await stat(filePath);
        return st.mtimeMs >= lastIndexed ? filePath : null;
      } catch {
        return null;
      }
    });

    return result.filter((f): f is string => f !== null);
  }
}

// === Helpers ===

function rowToChunk(row: CodeChunkRow): CodeChunk {
  return {
    id: row.id,
    filePath: row.file_path,
    startLine: row.start_line,
    endLine: row.end_line,
    chunkType: row.chunk_type as CodeChunk["chunkType"],
    content: row.content,
  };
}

// === Singleton ===

const _instances = new Map<string, CodeIndexer>();

export function getCodeIndexer(dbPath: string): CodeIndexer {
  let instance = _instances.get(dbPath);
  if (!instance) {
    instance = new CodeIndexer(dbPath);
    _instances.set(dbPath, instance);
  }
  return instance;
}

function closeAllIndexers(): void {
  for (const [path, indexer] of _instances) {
    try {
      indexer.close();
    } catch {
      // Best-effort
    }
  }
  _instances.clear();
}

process.on("exit", closeAllIndexers);
process.on("SIGINT", () => { closeAllIndexers(); process.exit(0); });
process.on("SIGTERM", () => { closeAllIndexers(); process.exit(0); });
