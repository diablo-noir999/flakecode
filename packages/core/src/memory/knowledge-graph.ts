/**
 * Lightweight knowledge graph backed by SQLite in the same memory.db.
 *
 * Stores concepts, files, functions, decisions, bugs, people, and tools
 * with typed edges and k-hop traversal for context retrieval.
 */

import { Database } from "bun:sqlite";

// === Types ===

export type NodeType = "concept" | "file" | "function" | "decision" | "bug" | "person" | "tool";
export type RelationType = "depends_on" | "fixes" | "related_to" | "calls" | "imports" | "decided_by" | "found_in";

export interface KGNode {
  id: number;
  projectPath: string;
  nodeType: NodeType;
  name: string;
  content: string;
  metadata: Record<string, unknown> | null;
  createdAt: number;
  updatedAt: number;
}

export interface KGEdge {
  id: number;
  projectPath: string;
  sourceId: number;
  targetId: number;
  relation: RelationType;
  weight: number;
  metadata: Record<string, unknown> | null;
  createdAt: number;
}

interface KGNodeRow {
  id: number;
  project_path: string;
  node_type: string;
  name: string;
  content: string;
  metadata: string | null;
  created_at: number;
  updated_at: number;
}

interface KGEdgeRow {
  id: number;
  project_path: string;
  source_id: number;
  target_id: number;
  relation: string;
  weight: number;
  metadata: string | null;
  created_at: number;
}

interface StatRow {
  node_type: string;
  relation: string;
  count: number;
}

// === Schema ===

const KG_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS kg_nodes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_path TEXT NOT NULL,
  node_type TEXT NOT NULL,
  name TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  metadata TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(project_path, node_type, name)
);

CREATE TABLE IF NOT EXISTS kg_edges (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_path TEXT NOT NULL,
  source_id INTEGER NOT NULL,
  target_id INTEGER NOT NULL,
  relation TEXT NOT NULL,
  weight REAL NOT NULL DEFAULT 1.0,
  metadata TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE(project_path, source_id, target_id, relation),
  FOREIGN KEY (source_id) REFERENCES kg_nodes(id) ON DELETE CASCADE,
  FOREIGN KEY (target_id) REFERENCES kg_nodes(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_kg_nodes_project ON kg_nodes(project_path);
CREATE INDEX IF NOT EXISTS idx_kg_nodes_type ON kg_nodes(project_path, node_type);
CREATE INDEX IF NOT EXISTS idx_kg_edges_project ON kg_edges(project_path);
CREATE INDEX IF NOT EXISTS idx_kg_edges_source ON kg_edges(project_path, source_id);
CREATE INDEX IF NOT EXISTS idx_kg_edges_target ON kg_edges(project_path, target_id);
`;

const KG_FTS_SCHEMA_SQL = `
CREATE VIRTUAL TABLE IF NOT EXISTS kg_nodes_fts USING fts5(
  name,
  content,
  content='kg_nodes',
  content_rowid='id',
  tokenize='porter unicode61'
);
`;

const KG_FTS_TRIGGERS_SQL = `
CREATE TRIGGER IF NOT EXISTS kg_nodes_ai AFTER INSERT ON kg_nodes BEGIN
  INSERT INTO kg_nodes_fts(rowid, name, content) VALUES (new.id, new.name, new.content);
END;
CREATE TRIGGER IF NOT EXISTS kg_nodes_ad AFTER DELETE ON kg_nodes BEGIN
  INSERT INTO kg_nodes_fts(kg_nodes_fts, rowid, name, content) VALUES('delete', old.id, old.name, old.content);
END;
CREATE TRIGGER IF NOT EXISTS kg_nodes_au AFTER UPDATE ON kg_nodes BEGIN
  INSERT INTO kg_nodes_fts(kg_nodes_fts, rowid, name, content) VALUES('delete', old.id, old.name, old.content);
  INSERT INTO kg_nodes_fts(rowid, name, content) VALUES (new.id, new.name, new.content);
END;
`;

// === Helpers ===

function parseMeta(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

function nodeRowToNode(row: KGNodeRow): KGNode {
  return {
    id: row.id,
    projectPath: row.project_path,
    nodeType: row.node_type as NodeType,
    name: row.name,
    content: row.content,
    metadata: parseMeta(row.metadata),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function edgeRowToEdge(row: KGEdgeRow): KGEdge {
  return {
    id: row.id,
    projectPath: row.project_path,
    sourceId: row.source_id,
    targetId: row.target_id,
    relation: row.relation as RelationType,
    weight: row.weight,
    metadata: parseMeta(row.metadata),
    createdAt: row.created_at,
  };
}

// === KnowledgeGraph ===

export class KnowledgeGraph {
  private db: Database;

  constructor(db: Database) {
    this.db = db;
    this.db.exec(KG_SCHEMA_SQL);
    this.db.exec(KG_FTS_SCHEMA_SQL);
    this.db.exec(KG_FTS_TRIGGERS_SQL);
  }

  addNode(
    projectPath: string,
    nodeType: NodeType,
    name: string,
    content = "",
    metadata?: Record<string, unknown>,
  ): KGNode {
    const now = Date.now();
    const metaJson = metadata ? JSON.stringify(metadata) : null;
    const result = this.db.prepare(
      `INSERT INTO kg_nodes (project_path, node_type, name, content, metadata, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(project_path, node_type, name)
       DO UPDATE SET content = excluded.content, metadata = excluded.metadata, updated_at = excluded.updated_at`,
    ).run(projectPath, nodeType, name, content, metaJson, now, now);

    const row = this.db.prepare(
      "SELECT * FROM kg_nodes WHERE project_path = ? AND node_type = ? AND name = ?",
    ).get(projectPath, nodeType, name) as KGNodeRow | undefined;
    if (!row) throw new Error("Failed to retrieve inserted kg_node");
    return nodeRowToNode(row);
  }

  addEdge(
    projectPath: string,
    sourceId: number,
    targetId: number,
    relation: RelationType,
    weight = 1.0,
    metadata?: Record<string, unknown>,
  ): KGEdge {
    const now = Date.now();
    const metaJson = metadata ? JSON.stringify(metadata) : null;
    const result = this.db.prepare(
      `INSERT INTO kg_edges (project_path, source_id, target_id, relation, weight, metadata, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(project_path, source_id, target_id, relation)
       DO UPDATE SET weight = excluded.weight, metadata = excluded.metadata`,
    ).run(projectPath, sourceId, targetId, relation, weight, metaJson, now);

    const row = this.db.prepare(
      "SELECT * FROM kg_edges WHERE project_path = ? AND source_id = ? AND target_id = ? AND relation = ?",
    ).get(projectPath, sourceId, targetId, relation) as KGEdgeRow | undefined;
    if (!row) throw new Error("Failed to retrieve inserted kg_edge");
    return edgeRowToEdge(row);
  }

  getNode(id: number): KGNode | null {
    const row = this.db.prepare("SELECT * FROM kg_nodes WHERE id = ?").get(id) as KGNodeRow | undefined;
    return row ? nodeRowToNode(row) : null;
  }

  getNeighbors(
    nodeId: number,
    depth = 1,
    relationTypes?: RelationType[],
  ): KGNode[] {
    const visited = new Set<number>();
    const result: KGNode[] = [];
    let frontier = [nodeId];
    visited.add(nodeId);

    const relFilter = relationTypes
      ? `AND e.relation IN (${relationTypes.map(() => "?").join(",")})`
      : "";

    const stmtForward = this.db.prepare(
      `SELECT DISTINCT n.id FROM kg_edges e
       INNER JOIN kg_nodes n ON n.id = e.target_id
       WHERE e.source_id = ? ${relFilter}`,
    );
    const stmtBackward = this.db.prepare(
      `SELECT DISTINCT n.id FROM kg_edges e
       INNER JOIN kg_nodes n ON n.id = e.source_id
       WHERE e.target_id = ? ${relFilter}`,
    );

    for (let d = 0; d < depth; d++) {
      const nextFrontier: number[] = [];
      for (const nid of frontier) {
        const args = relFilter ? [nid, ...(relationTypes ?? [])] : [nid];
        for (const row of stmtForward.all(...args) as { id: number }[]) {
          if (!visited.has(row.id)) {
            visited.add(row.id);
            nextFrontier.push(row.id);
            const node = this.getNode(row.id);
            if (node) result.push(node);
          }
        }
        for (const row of stmtBackward.all(...args) as { id: number }[]) {
          if (!visited.has(row.id)) {
            visited.add(row.id);
            nextFrontier.push(row.id);
            const node = this.getNode(row.id);
            if (node) result.push(node);
          }
        }
      }
      frontier = nextFrontier;
    }

    return result;
  }

  getConnections(nodeId: number): KGEdge[] {
    const rows = this.db.prepare(
      `SELECT * FROM kg_edges WHERE source_id = ? OR target_id = ? ORDER BY weight DESC`,
    ).all(nodeId, nodeId) as KGEdgeRow[];
    return rows.map(edgeRowToEdge);
  }

  searchNodes(projectPath: string, query: string, limit = 10): KGNode[] {
    const tokens = query.split(/\s+/).filter(t => t.length > 0);
    if (tokens.length === 0) return [];
    const sanitized = tokens.map(t => `"${t.replace(/"/g, '""')}"`).join(" ");
    try {
      const rows = this.db.prepare(
        `SELECT n.* FROM kg_nodes_fts fts
         INNER JOIN kg_nodes n ON n.id = fts.rowid
         WHERE fts.kg_nodes_fts MATCH ? AND n.project_path = ?
         ORDER BY rank
         LIMIT ?`,
      ).all(sanitized, projectPath, limit) as KGNodeRow[];
      return rows.map(nodeRowToNode);
    } catch {
      return [];
    }
  }

  findRelated(projectPath: string, name: string, nodeType?: NodeType): KGNode[] {
    const typeFilter = nodeType ? `AND node_type = ?` : "";
    const args = nodeType ? [projectPath, `%${name}%`, nodeType] : [projectPath, `%${name}%`];
    const rows = this.db.prepare(
      `SELECT * FROM kg_nodes WHERE project_path = ? AND name LIKE ? ${typeFilter} LIMIT 20`,
    ).all(...args) as KGNodeRow[];
    return rows.map(nodeRowToNode);
  }

  updateEdgeWeight(edgeId: number, weight: number): void {
    this.db.prepare("UPDATE kg_edges SET weight = ? WHERE id = ?").run(weight, edgeId);
  }

  getSubgraph(projectPath: string, nodeIds: number[]): { nodes: KGNode[]; edges: KGEdge[] } {
    if (nodeIds.length === 0) return { nodes: [], edges: [] };
    const placeholders = nodeIds.map(() => "?").join(",");
    const nodes = this.db.prepare(
      `SELECT * FROM kg_nodes WHERE project_path = ? AND id IN (${placeholders})`,
    ).all(projectPath, ...nodeIds) as KGNodeRow[];
    const edges = this.db.prepare(
      `SELECT * FROM kg_edges WHERE project_path = ? AND source_id IN (${placeholders}) AND target_id IN (${placeholders})`,
    ).all(projectPath, ...nodeIds, ...nodeIds) as KGEdgeRow[];
    return {
      nodes: nodes.map(nodeRowToNode),
      edges: edges.map(edgeRowToEdge),
    };
  }

  deleteNode(nodeId: number): void {
    this.db.prepare("DELETE FROM kg_edges WHERE source_id = ? OR target_id = ?").run(nodeId, nodeId);
    this.db.prepare("DELETE FROM kg_nodes WHERE id = ?").run(nodeId);
  }

  getStats(projectPath: string): { totalNodes: number; totalEdges: number; nodesByType: Record<string, number>; edgesByRelation: Record<string, number> } {
    const totalNodes = (this.db.prepare(
      "SELECT COUNT(*) AS c FROM kg_nodes WHERE project_path = ?",
    ).get(projectPath) as { c: number }).c;
    const totalEdges = (this.db.prepare(
      "SELECT COUNT(*) AS c FROM kg_edges WHERE project_path = ?",
    ).get(projectPath) as { c: number }).c;

    const nodeTypeRows = this.db.prepare(
      "SELECT node_type, COUNT(*) AS count FROM kg_nodes WHERE project_path = ? GROUP BY node_type",
    ).all(projectPath) as StatRow[];
    const nodesByType: Record<string, number> = {};
    for (const r of nodeTypeRows) nodesByType[r.node_type] = r.count;

    const edgeTypeRows = this.db.prepare(
      "SELECT relation, COUNT(*) AS count FROM kg_edges WHERE project_path = ? GROUP BY relation",
    ).all(projectPath) as StatRow[];
    const edgesByRelation: Record<string, number> = {};
    for (const r of edgeTypeRows) edgesByRelation[r.relation] = r.count;

    return { totalNodes, totalEdges, nodesByType, edgesByRelation };
  }
}
