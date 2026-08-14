/**
 * Pure data-gathering module for the brain map feature.
 * Aggregates session checkpoints, memory DB entries, and knowledge graph data
 * into a unified BrainData structure. No side effects.
 */

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import { getMemoryStore, getKnowledgeGraph } from "./store";
import { getMemoryDbPath, type Memory, type MemoryCategory, MEMORY_CATEGORIES } from "./types";
import type { KGNode, KGEdge } from "./knowledge-graph";

const MEMORY_BASE = `${process.env.HOME}/.local/share/mimocode/memory`;

// === Types ===

export interface BrainSession {
  id: string;
  topic: string;
  createdAt: number;
  sections: Record<string, string>;
  notes: string;
}

export interface BrainData {
  sessions: BrainSession[];
  memories: Memory[];
  graph: {
    nodes: KGNode[];
    edges: KGEdge[];
    stats: {
      totalNodes: number;
      totalEdges: number;
      nodesByType: Record<string, number>;
      edgesByRelation: Record<string, number>;
    };
  };
}

// === Checkpoint parsing ===

export function parseCheckpoint(content: string): {
  topic: string;
  sections: Record<string, string>;
} {
  const lines = content.split("\n");
  let topic = "";
  let body = content;

  const firstLine = lines[0]?.trim() ?? "";
  const topicMatch = firstLine.match(/^Topic:\s*(.+)/);
  if (topicMatch) {
    topic = topicMatch[1].trim();
    body = lines.slice(1).join("\n");
  }

  const sections: Record<string, string> = {};
  const parts = body.split(/^## /m);

  for (const part of parts) {
    const headingMatch = part.match(/^(§\d+\s+.+?)\n([\s\S]*)/);
    if (headingMatch) {
      sections[headingMatch[1].trim()] = headingMatch[2].trim();
    }
  }

  return { topic, sections };
}

// === Session scanning ===

export function scanSessionDirs(memoryBasePath: string): string[] {
  const sessionsDir = join(memoryBasePath, "sessions");
  try {
    const entries = readdirSync(sessionsDir);
    const checkpoints: string[] = [];
    for (const entry of entries) {
      const cp = join(sessionsDir, entry, "checkpoint.md");
      if (existsSync(cp)) checkpoints.push(cp);
    }
    return checkpoints;
  } catch {
    return [];
  }
}

// === Memory grouping ===

export function groupMemoriesByCategory(
  memories: Memory[],
): Record<MemoryCategory, Memory[]> {
  const grouped = {} as Record<MemoryCategory, Memory[]>;
  for (const cat of MEMORY_CATEGORIES) {
    grouped[cat] = [];
  }
  for (const mem of memories) {
    grouped[mem.category].push(mem);
  }
  return grouped;
}

// === Main gatherer ===

export function gatherBrainData(projectPath: string): BrainData {
  const sessions: BrainSession[] = [];
  const checkpointPaths = scanSessionDirs(MEMORY_BASE);

  for (const cpPath of checkpointPaths) {
    try {
      const content = readFileSync(cpPath, "utf-8");
      const { topic, sections } = parseCheckpoint(content);
      const stat = statSync(cpPath);

      const dir = cpPath.replace(/\/checkpoint\.md$/, "");
      let notes = "";
      const notesPath = join(dir, "notes.md");
      if (existsSync(notesPath)) {
        notes = readFileSync(notesPath, "utf-8");
      }

      const id = dir.split("/").pop() ?? cpPath;
      sessions.push({
        id,
        topic,
        createdAt: stat.mtimeMs,
        sections,
        notes,
      });
    } catch {
      // skip unreadable checkpoint files
    }
  }

  sessions.sort((a, b) => b.createdAt - a.createdAt);

  // Gather memories
  let memories: Memory[] = [];
  const dbPath = getMemoryDbPath(projectPath);
  if (existsSync(dbPath)) {
    try {
      const store = getMemoryStore(dbPath);
      memories = store.getAll(projectPath);
    } catch {
      memories = [];
    }
  }

  // Gather knowledge graph
  const emptyStats = {
    totalNodes: 0,
    totalEdges: 0,
    nodesByType: {} as Record<string, number>,
    edgesByRelation: {} as Record<string, number>,
  };
  let graphNodes: KGNode[] = [];
  let graphEdges: KGEdge[] = [];
  let graphStats = { ...emptyStats };

  if (existsSync(dbPath)) {
    try {
      const kg = getKnowledgeGraph(dbPath);
      graphStats = kg.getStats(projectPath);

      const store = getMemoryStore(dbPath);
      const db = store.getDb();

      const nodeRows = db
        .prepare("SELECT * FROM kg_nodes WHERE project_path = ?")
        .all(projectPath) as any[];
      graphNodes = nodeRows.map((r) => ({
        id: r.id,
        projectPath: r.project_path,
        nodeType: r.node_type,
        name: r.name,
        content: r.content,
        metadata: r.metadata ? JSON.parse(r.metadata) : null,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      }));

      const edgeRows = db
        .prepare("SELECT * FROM kg_edges WHERE project_path = ?")
        .all(projectPath) as any[];
      graphEdges = edgeRows.map((r) => ({
        id: r.id,
        projectPath: r.project_path,
        sourceId: r.source_id,
        targetId: r.target_id,
        relation: r.relation,
        weight: r.weight,
        metadata: r.metadata ? JSON.parse(r.metadata) : null,
        createdAt: r.created_at,
      }));
    } catch {
      // leave empty
    }
  }

  return {
    sessions,
    memories,
    graph: {
      nodes: graphNodes,
      edges: graphEdges,
      stats: graphStats,
    },
  };
}
