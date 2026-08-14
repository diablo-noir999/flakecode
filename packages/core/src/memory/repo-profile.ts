/**
 * Git-SHA-keyed project profile cache.
 *
 * Generates a question-agnostic profile (languages, frameworks, dependencies,
 * topology, conventions, vocabulary) for the current repository and caches it
 * keyed by git SHA. The cache is invalidated on any commit (HEAD changes) or
 * when profile-input files are modified.
 *
 * Cache location: /tmp/mimocode/repo-profile/<root-sha>/<head-sha>.json
 *
 * This is a simplified port of compound-engineering's repo-profile-cache,
 * adapted for TypeScript/Bun runtime. The derivation is done via filesystem
 * scanning + git commands; no LLM call is needed for the deterministic part.
 */

import { readdir, readFile, stat, mkdir } from "node:fs/promises";
import { join, relative, basename, extname } from "node:path";
import { execSync } from "node:child_process";
import { existsSync, writeFileSync, renameSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";

// === Schema version — bump when the profile shape changes ===
const PROFILE_SCHEMA_VERSION = "1";

// === Cache root ===
const CACHE_ROOT = join(tmpdir(), "mimocode", "repo-profile");

// === Profile types ===

export interface StackProfile {
  languages: string[];
  frameworks: string[];
  tooling: string[];
}

export interface DependencyProfile {
  manifests: string[];
  lockfiles: string[];
  top_level: string[];
  project_license: string | null;
}

export interface TopologyProfile {
  monorepo: boolean;
  workspaces: string[];
  deployment: string | null;
  api_styles: string[];
  data_stores: string[];
  module_layout: string | null;
}

export interface ConventionsProfile {
  instruction_files: string[];
  coding_standards: string | null;
  testing: string | null;
  review_process: string | null;
}

export interface VocabularyProfile {
  concepts_present: boolean;
  terms: string[];
}

export interface RepoProfile {
  stack: StackProfile;
  dependencies: DependencyProfile;
  topology: TopologyProfile;
  conventions: ConventionsProfile;
  vocabulary: VocabularyProfile;
}

export interface CachedProfile {
  profile_schema_version: string;
  root_sha: string;
  head_sha: string;
  built_at: string;
  profile: RepoProfile;
}

// === Profile-input file sets (conservative superset) ===

const MANIFEST_LOCKFILE = new Set([
  "package.json", "package-lock.json", "yarn.lock", "pnpm-lock.yaml",
  "pnpm-workspace.yaml", "bun.lock", "bun.lockb", "npm-shrinkwrap.json",
  "deno.json", "deno.jsonc", "deno.lock",
  "nx.json", "lerna.json", "turbo.json", "rush.json",
  "go.mod", "go.sum", "go.work", "go.work.sum",
  "Cargo.toml", "Cargo.lock",
  "Gemfile", "Gemfile.lock",
  "pyproject.toml", "poetry.lock", "Pipfile", "Pipfile.lock",
  "requirements.txt", "setup.py", "setup.cfg",
  "uv.lock", "pdm.lock",
  "composer.json", "composer.lock",
  "pom.xml", "build.gradle", "build.gradle.kts",
  "mix.exs", "mix.lock",
  "Package.swift", "Package.resolved",
]);

const PROJECT_FILE_SUFFIXES = [".csproj", ".fsproj", ".vbproj", ".sln", ".cabal", ".tf"];

const LICENSE_FILES = new Set(["LICENSE", "LICENSE.md", "LICENSE.txt", "COPYING"]);

const TOPOLOGY_FILES = new Set([
  "Dockerfile", "Containerfile",
  "docker-compose.yml", "docker-compose.yaml",
  "vercel.json", "netlify.toml", "fly.toml",
  "serverless.yml", "serverless.yaml",
  ".gitlab-ci.yml", "Jenkinsfile",
]);

const VERSION_SELECTORS = new Set([
  ".nvmrc", ".node-version", ".python-version", ".ruby-version",
  ".java-version", ".go-version", ".tool-versions", "mise.toml",
]);

const ROOT_DOCS = new Set([
  "AGENTS.md", "CLAUDE.md", "GEMINI.md",
  "CONCEPTS.md", "STRATEGY.md",
  "ARCHITECTURE.md", "README.md", "CONTRIBUTING.md",
]);

const INPUT_PREFIXES = [".cursor/", ".github/workflows/", ".circleci/"];

// === Git helpers ===

function git(...args: string[]): string | null {
  try {
    return execSync(`git ${args.join(" ")}`, {
      encoding: "utf-8",
      timeout: 5000,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  } catch {
    return null;
  }
}

function rootSha(): string | null {
  const out = git("rev-list", "--max-parents=0", "HEAD");
  if (!out) return null;
  return out.split("\n").sort()[0];
}

function headSha(): string | null {
  return git("rev-parse", "HEAD");
}

function isProfileInput(path: string): boolean {
  const base = basename(path);
  if (
    MANIFEST_LOCKFILE.has(base) ||
    LICENSE_FILES.has(base) ||
    TOPOLOGY_FILES.has(base) ||
    VERSION_SELECTORS.has(base)
  ) return true;
  if (PROJECT_FILE_SUFFIXES.some(s => base.endsWith(s))) return true;
  if (!path.includes("/") && ROOT_DOCS.has(base)) return true;
  if (INPUT_PREFIXES.some(p => path.startsWith(p))) return true;
  return false;
}

function changedPaths(): string[] | null {
  try {
    const out = execSync("git status --porcelain --untracked-files=all", {
      encoding: "utf-8",
      timeout: 5000,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const paths: string[] = [];
    for (const line of out.split("\n")) {
      if (!line.trim()) continue;
      const rest = line.substring(3);
      if (rest.includes(" -> ")) {
        for (const token of rest.split(" -> ")) {
          const p = token.trim().replace(/^"|"$/g, "");
          if (p) paths.push(p);
        }
        continue;
      }
      const p = rest.trim().replace(/^"|"$/g, "");
      if (p) paths.push(p);
    }
    return paths;
  } catch {
    return null;
  }
}

// === Cache I/O ===

function cachePath(root: string, head: string): string {
  return join(CACHE_ROOT, root, `${head}.json`);
}

function isValidProfile(profile: unknown): profile is RepoProfile {
  if (!profile || typeof profile !== "object") return false;
  const p = profile as Record<string, unknown>;
  return (
    "stack" in p && "dependencies" in p && "topology" in p &&
    "conventions" in p && "vocabulary" in p
  );
}

// === Filesystem scanning ===

const SCAN_SKIP = new Set(["node_modules", "dist", ".git", ".mimocode", "tmp", "build", "target", "__pycache__"]);

async function listFiles(dir: string, depth = 0): Promise<string[]> {
  if (depth > 6) return [];
  const results: string[] = [];
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith(".") && entry.name !== ".mimocode") continue;
      if (SCAN_SKIP.has(entry.name)) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        results.push(...await listFiles(full, depth + 1));
      } else if (entry.isFile()) {
        results.push(full);
      }
    }
  } catch { /* skip unreadable dirs */ }
  return results;
}

async function detectLanguages(projectRoot: string): Promise<string[]> {
  const langMap: Record<string, string> = {
    ".ts": "TypeScript", ".tsx": "TypeScript", ".js": "JavaScript", ".jsx": "JavaScript",
    ".py": "Python", ".go": "Go", ".rs": "Rust", ".java": "Java", ".rb": "Ruby",
    ".c": "C", ".cpp": "C++", ".cs": "C#", ".swift": "Swift", ".kt": "Kotlin",
    ".php": "PHP", ".lua": "Lua", ".sh": "Shell", ".ex": "Elixir",
  };
  const counts: Record<string, number> = {};
  const files = await listFiles(projectRoot);
  for (const f of files) {
    const ext = extname(f).toLowerCase();
    const lang = langMap[ext];
    if (lang) counts[lang] = (counts[lang] || 0) + 1;
  }
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([lang]) => lang);
}

async function findManifests(projectRoot: string): Promise<{ manifests: string[]; lockfiles: string[] }> {
  const manifests: string[] = [];
  const lockfiles: string[] = [];
  const files = await listFiles(projectRoot);
  for (const f of files) {
    const base = basename(f);
    const rel = relative(projectRoot, f);
    if (MANIFEST_LOCKFILE.has(base)) {
      if (base.includes("lock") || base.endsWith(".sum") || base.endsWith(".resolved")) {
        lockfiles.push(rel);
      } else {
        manifests.push(rel);
      }
    }
  }
  return { manifests: [...new Set(manifests)].slice(0, 20), lockfiles: [...new Set(lockfiles)].slice(0, 20) };
}

async function detectTopology(projectRoot: string): Promise<TopologyProfile> {
  const files = await listFiles(projectRoot);
  const bases = new Set(files.map(f => basename(f)));

  const monorepo = bases.has("pnpm-workspace.yaml") || bases.has("lerna.json") ||
    bases.has("nx.json") || bases.has("turbo.json");

  const workspaces: string[] = [];
  if (monorepo) {
    try {
      const pkgJson = JSON.parse(await readFile(join(projectRoot, "package.json"), "utf-8"));
      if (pkgJson.workspaces) {
        const ws = Array.isArray(pkgJson.workspaces) ? pkgJson.workspaces : pkgJson.workspaces.packages;
        workspaces.push(...(ws || []).slice(0, 20));
      }
    } catch { /* no root package.json */ }
  }

  const deployment = bases.has("Dockerfile") ? "container" :
    bases.has("docker-compose.yml") || bases.has("docker-compose.yaml") ? "container" :
    bases.has("vercel.json") || bases.has("netlify.toml") ? "serverless" :
    bases.has("fly.toml") ? "container" : null;

  const api_styles: string[] = [];
  if (files.some(f => f.includes("graphql") || f.endsWith(".graphql"))) api_styles.push("GraphQL");
  if (files.some(f => f.includes("proto"))) api_styles.push("gRPC");
  if (files.some(f => basename(f) === "openapi.json" || basename(f) === "swagger.json")) api_styles.push("REST");

  const data_stores: string[] = [];
  if (bases.has("docker-compose.yml") || bases.has("docker-compose.yaml")) {
    try {
      const dc = await readFile(join(projectRoot, "docker-compose.yml"), "utf-8");
      if (dc.includes("postgres")) data_stores.push("PostgreSQL");
      if (dc.includes("mysql")) data_stores.push("MySQL");
      if (dc.includes("redis")) data_stores.push("Redis");
      if (dc.includes("mongo")) data_stores.push("MongoDB");
    } catch { /* skip */ }
  }

  return { monorepo, workspaces, deployment, api_styles, data_stores, module_layout: null };
}

async function findConventions(projectRoot: string): Promise<ConventionsProfile> {
  const files = await listFiles(projectRoot);
  const bases = new Set(files.map(f => basename(f)));
  const instruction_files = [...ROOT_DOCS].filter(d => bases.has(d));

  let testing: string | null = null;
  if (bases.has("jest.config.js") || bases.has("jest.config.ts")) testing = "Jest";
  else if (bases.has("vitest.config.ts") || bases.has("vitest.config.js")) testing = "Vitest";
  else if (bases.has("pytest.ini") || bases.has("pyproject.toml")) testing = "pytest";

  return { instruction_files, coding_standards: null, testing, review_process: null };
}

async function findVocabulary(projectRoot: string): Promise<VocabularyProfile> {
  const conceptsPath = join(projectRoot, "CONCEPTS.md");
  if (!existsSync(conceptsPath)) return { concepts_present: false, terms: [] };
  try {
    const content = await readFile(conceptsPath, "utf-8");
    const terms = content.match(/^[-*]\s+\*\*([^*]+)\*\*/gm)?.map(m => m.replace(/^[-*]\s+\*\*|\*\*$/g, "")) || [];
    return { concepts_present: true, terms: terms.slice(0, 30) };
  } catch {
    return { concepts_present: false, terms: [] };
  }
}

async function detectFrameworks(projectRoot: string): Promise<string[]> {
  const frameworks: string[] = [];
  try {
    const pkgJson = JSON.parse(await readFile(join(projectRoot, "package.json"), "utf-8"));
    const allDeps = { ...pkgJson.dependencies, ...pkgJson.devDependencies };
    const fwNames = ["react", "vue", "svelte", "next", "nuxt", "express", "fastify", "hono",
      "nestjs", "@angular/core", "tailwindcss", "prisma", "drizzle-orm"];
    for (const name of fwNames) {
      if (allDeps[name]) frameworks.push(name);
    }
  } catch { /* no package.json */ }
  return frameworks;
}

// === Profile generation ===

async function generateProfile(projectRoot: string): Promise<RepoProfile> {
  const [languages, { manifests, lockfiles }, topology, conventions, vocabulary, frameworks] = await Promise.all([
    detectLanguages(projectRoot),
    findManifests(projectRoot),
    detectTopology(projectRoot),
    findConventions(projectRoot),
    findVocabulary(projectRoot),
    detectFrameworks(projectRoot),
  ]);

  let project_license: string | null = null;
  for (const name of ["LICENSE", "LICENSE.md", "LICENSE.txt", "COPYING"]) {
    if (existsSync(join(projectRoot, name))) {
      project_license = name;
      break;
    }
  }

  return {
    stack: { languages, frameworks, tooling: [] },
    dependencies: { manifests, lockfiles, top_level: [], project_license },
    topology,
    conventions,
    vocabulary,
  };
}

// === Public API ===

export interface RepoProfileResult {
  profile: RepoProfile;
  fromCache: boolean;
}

/**
 * Get the project profile for the current repository.
 * Returns cached profile if HEAD and inputs haven't changed;
 * otherwise generates fresh and caches.
 */
export async function getRepoProfile(projectRoot: string): Promise<RepoProfileResult> {
  const root = rootSha();
  const head = headSha();

  if (!root || !head) {
    return { profile: await generateProfile(projectRoot), fromCache: false };
  }

  const path = cachePath(root, head);

  // Try cache hit
  if (existsSync(path)) {
    try {
      const raw = await readFile(path, "utf-8");
      const doc: CachedProfile = JSON.parse(raw);
      if (
        doc.profile_schema_version === PROFILE_SCHEMA_VERSION &&
        doc.head_sha === head &&
        isValidProfile(doc.profile)
      ) {
        const changed = changedPaths();
        if (changed !== null && !changed.some(p => isProfileInput(p))) {
          return { profile: doc.profile, fromCache: true };
        }
      }
    } catch { /* corrupted cache, regenerate */ }
  }

  // Generate fresh
  const profile = await generateProfile(projectRoot);

  // Cache (best-effort)
  try {
    const dir = join(CACHE_ROOT, root);
    await mkdir(dir, { recursive: true });
    const doc: CachedProfile = {
      profile_schema_version: PROFILE_SCHEMA_VERSION,
      root_sha: root,
      head_sha: head,
      built_at: new Date().toISOString(),
      profile,
    };
    const tmpPath = path + ".tmp";
    writeFileSync(tmpPath, JSON.stringify(doc, null, 2));
    renameSync(tmpPath, path);
  } catch { /* caching is best-effort */ }

  return { profile, fromCache: false };
}

/**
 * Clear the profile cache for the current repository.
 */
export function clearProfileCache(): void {
  const root = rootSha();
  const head = headSha();
  if (root && head) {
    const path = cachePath(root, head);
    try { unlinkSync(path); } catch { /* not found is fine */ }
  }
}
