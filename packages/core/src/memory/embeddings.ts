/**
 * Embedding service — local ONNX inference via @huggingface/transformers.
 *
 * Uses onnx-community/granite-embedding-small-english-r2-ONNX (384-dim, 47M params).
 * ModernBERT architecture with 8192 token context length.
 * Lazy model download on first use; cached under .mimocode/models/.
 */

import { mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

export const DEFAULT_EMBEDDING_MODEL = "onnx-community/granite-embedding-small-english-r2-ONNX";
export const EMBEDDING_DIMENSIONS = 384;

// Old models to purge on init — these are from previous plugin versions
const STALE_MODEL_PREFIXES = ["Xenova/", "BAAI/", "ibm-granite/"];

type EmbeddingPipeline = {
  (
    input: string | string[],
    options: { pooling: "mean"; normalize: true },
  ): Promise<{ data: ArrayLike<number> | ArrayLike<number>[]; dims?: number[] }>;
  dispose?: () => Promise<void> | void;
};

type CreateEmbeddingPipeline = (
  task: "feature-extraction",
  model: string,
  options: { dtype: string },
) => Promise<EmbeddingPipeline>;

let pipeline: EmbeddingPipeline | null = null;
let initPromise: Promise<boolean> | null = null;
let nativeRuntimeMissing = false;

function isNativeRuntimeMissingError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  const lower = message.toLowerCase();
  const code = (error as { code?: unknown } | null)?.code;
  if (code === "ERR_DLOPEN_FAILED" && lower.includes("onnxruntime")) return true;
  const mentionsNative = lower.includes("onnxruntime-node") || lower.includes("onnxruntime_binding");
  if (!mentionsNative) return false;
  return (
    code === "ERR_MODULE_NOT_FOUND" ||
    lower.includes("cannot find package") ||
    lower.includes("cannot find module") ||
    lower.includes("err_module_not_found")
  );
}

function cleanupStaleModels(modelCacheDir: string) {
  try {
    const entries = readdirSync(modelCacheDir);
    for (const entry of entries) {
      if (STALE_MODEL_PREFIXES.some(prefix => entry.startsWith(prefix))) {
        const dirPath = join(modelCacheDir, entry);
        if (statSync(dirPath).isDirectory()) {
          rmSync(dirPath, { recursive: true, force: true });
          console.debug(`[powerpack] Cleaned stale model cache: ${entry}`);
        }
      }
    }
  } catch {
    // non-fatal — cache dir may not exist yet
  }
}

function toFloat32Array(values: ArrayLike<number>): Float32Array {
  return values instanceof Float32Array
    ? new Float32Array(values)
    : Float32Array.from(Array.from(values));
}

function extractEmbedding(
  result: { data: ArrayLike<number> | ArrayLike<number>[]; dims?: number[] },
): Float32Array | null {
  const { data } = result;
  if (Array.isArray(data) && data.length === 1 && typeof data[0] !== "number" && "length" in data[0]) {
    return toFloat32Array(data[0] as ArrayLike<number>);
  }
  if (Array.isArray(data) && data.length > 0 && typeof data[0] !== "number") {
    return toFloat32Array(data[0] as ArrayLike<number>);
  }
  if ("length" in data && typeof (data as any)[0] === "number") {
    return toFloat32Array(data as ArrayLike<number>);
  }
  return null;
}

async function initPipeline(model: string, modelCacheDir: string): Promise<boolean> {
  if (pipeline) return true;
  if (nativeRuntimeMissing) return false;
  if (initPromise) {
    await initPromise;
    return pipeline !== null;
  }

  initPromise = (async () => {
    try {
      mkdirSync(modelCacheDir, { recursive: true });
      cleanupStaleModels(modelCacheDir);

      // Non-literal import to prevent Bun static analysis
      const transformersSpec = `@huggingface/${"transformers"}`;
      const mod = (await import(transformersSpec)) as Record<string, unknown>;
      const env = mod.env as { logLevel?: unknown; cacheDir?: string };
      const LogLevel = mod.LogLevel as Record<string, unknown> | undefined;
      if (LogLevel && "ERROR" in LogLevel) {
        env.logLevel = LogLevel.ERROR;
      }
      // Save the original cache dir so we don't pollute global state for
      // other @huggingface/transformers users in the same process (e.g.
      // MiMoCode's own embedding code which may use Xenova/all-MiniLM-L6-v2).
      // Without this restore, those callers would download into our project
      // .mimocode/models/ dir and recreate stale model dirs we just cleaned.
      const originalCacheDir = env.cacheDir;
      env.cacheDir = modelCacheDir;

      try {
        const createPipeline = mod.pipeline as CreateEmbeddingPipeline;
        const loaded = await createPipeline(
          "feature-extraction",
          model,
          { dtype: "fp32", cache_dir: modelCacheDir } as Parameters<typeof createPipeline>[2] & { cache_dir?: string },
        );
        pipeline = loaded;
        console.log(`[powerpack] Embeddings initialized with model ${model}`);
        return true;
      } finally {
        env.cacheDir = originalCacheDir;
        // Run cleanup again AFTER pipeline creation — other @huggingface/transformers
        // users in the same process (e.g. MiMoCode's Xenova embeddings) may have
        // downloaded stale models into our cache dir while env.cacheDir was set to it.
        cleanupStaleModels(modelCacheDir);
      }
    } catch (error) {
      if (isNativeRuntimeMissingError(error)) {
        nativeRuntimeMissing = true;
        console.error("[powerpack] ONNX runtime not found. Embeddings disabled. Install onnxruntime-node: bun add onnxruntime-node");
      } else {
        console.error("[powerpack] Embedding init failed:", error instanceof Error ? error.message : String(error));
      }
      pipeline = null;
      return false;
    } finally {
      initPromise = null;
    }
  })();

  await initPromise;
  return pipeline !== null;
}

/**
 * Initialize the embedding service. Call once before embedding.
 * Returns true if the pipeline is ready, false if unavailable.
 */
export async function initEmbeddings(model?: string, cacheDir?: string): Promise<boolean> {
  const m = model || DEFAULT_EMBEDDING_MODEL;
  const dir = cacheDir || join(process.cwd(), ".mimocode", "models");
  // Clean before init too — covers the case where stale models appear between sessions
  cleanupStaleModels(dir);
  return initPipeline(m, dir);
}

/**
 * Embed a single text string. Returns null if unavailable.
 */
export async function embed(text: string, model?: string): Promise<Float32Array | null> {
  const m = model || DEFAULT_EMBEDDING_MODEL;
  const dir = join(process.cwd(), ".mimocode", "models");
  // Clean stale models before every embed call — other code in the same process
  // (e.g. MiMoCode's own Xenova embeddings) may re-download them after our init cleanup.
  cleanupStaleModels(dir);
  if (!(await initPipeline(m, dir))) return null;
  if (!pipeline) return null;

  try {
    const result = await pipeline(text, { pooling: "mean", normalize: true });
    return extractEmbedding(result);
  } catch (error) {
    console.error("[powerpack] Embed failed:", error instanceof Error ? error.message : String(error));
    return null;
  }
}

/**
 * Embed a batch of texts. Returns array of embeddings (null for failures).
 */
export async function embedBatch(
  texts: string[],
  model?: string,
): Promise<(Float32Array | null)[]> {
  if (texts.length === 0) return [];
  const m = model || DEFAULT_EMBEDDING_MODEL;
  const dir = join(process.cwd(), ".mimocode", "models");
  cleanupStaleModels(dir);
  if (!(await initPipeline(m, dir))) return Array.from({ length: texts.length }, () => null);
  if (!pipeline) return Array.from({ length: texts.length }, () => null);

  try {
    const result = await pipeline(texts, { pooling: "mean", normalize: true });
    const { data } = result;

    // Batch result: array of arrays
    if (Array.isArray(data) && data.length === texts.length) {
      return data.map((entry) => {
        if (typeof entry === "number") return null;
        return toFloat32Array(entry as ArrayLike<number>);
      });
    }

    // Flat array: split by dimension
    if (!Array.isArray(data) && "length" in data) {
      const flat = toFloat32Array(data as ArrayLike<number>);
      const dim = result.dims?.at(-1) ?? flat.length / texts.length;
      if (Number.isInteger(dim) && dim > 0 && flat.length === texts.length * dim) {
        const embeddings: Float32Array[] = [];
        for (let i = 0; i < texts.length; i++) {
          embeddings.push(flat.slice(i * dim, (i + 1) * dim));
        }
        return embeddings;
      }
    }

    // Fallback: embed one at a time
    const results: (Float32Array | null)[] = [];
    for (const text of texts) {
      results.push(await embed(text, model));
    }
    return results;
  } catch (error) {
    console.error("[powerpack] Batch embed failed:", error instanceof Error ? error.message : String(error));
    return Array.from({ length: texts.length }, () => null);
  }
}

/**
 * Check if the embedding service is ready.
 */
export function isEmbeddingsReady(): boolean {
  return pipeline !== null;
}

/**
 * Dispose the embedding pipeline.
 */
export async function disposeEmbeddings(): Promise<void> {
  if (pipeline) {
    try {
      await pipeline.dispose?.();
    } catch {
      // non-fatal
    }
    pipeline = null;
  }
}

// SECURITY: Register dispose handler to clean up ONNX pipeline on process exit
process.on('exit', () => { if (pipeline) { try { pipeline.dispose?.() } catch {} } })
