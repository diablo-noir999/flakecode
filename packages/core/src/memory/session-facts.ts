/**
 * Session Facts Extraction — Structured Fact Storage
 *
 * Extracts structured facts from conversations: tool calls, decisions,
 * file changes, error patterns. Stores in SQLite for cross-session linking.
 * Adapted from dev/opencode-magic-context session-facts patterns. Scoped:
 * extraction and storage only, no historian subagent or dreamer.
 *
 * Fact categories:
 * - TOOL_CALL: tool invocations with name, args summary, result status
 * - FILE_CHANGE: file edits/writes with path and operation type
 * - DECISION: explicit decisions or architectural choices
 * - ERROR_PATTERN: recurring errors or workarounds
 * - CONFIG_CHANGE: configuration modifications
 */

import { Database } from "bun:sqlite";
import { isRecord, getToolName, getToolInput } from "./message-utils";

// === Types ===

export type FactCategory =
  | "TOOL_CALL"
  | "FILE_CHANGE"
  | "DECISION"
  | "ERROR_PATTERN"
  | "CONFIG_CHANGE";

export type FactSeverity = "info" | "warning" | "critical";

export interface SessionFact {
  id: number;
  sessionId: string;
  projectPath: string;
  category: FactCategory;
  content: string;
  metadata: string; // JSON-serialized metadata
  severity: FactSeverity;
  messageIndex: number;
  createdAt: number;
}

export interface SessionFactInput {
  sessionId: string;
  projectPath: string;
  category: FactCategory;
  content: string;
  metadata?: Record<string, unknown>;
  severity?: FactSeverity;
  messageIndex: number;
}

// === Helpers ===

function getMessageText(message: any): string {
  if (typeof message.content === "string") return message.content;
  if (Array.isArray(message.parts)) {
    return message.parts
      .filter((p: any) => isRecord(p) && p.type === "text" && typeof p.text === "string")
      .map((p: any) => p.text)
      .join("\n");
  }
  return "";
}

// === Schema ===

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS session_facts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  project_path TEXT NOT NULL,
  category TEXT NOT NULL,
  content TEXT NOT NULL,
  metadata TEXT NOT NULL DEFAULT '{}',
  severity TEXT NOT NULL DEFAULT 'info',
  message_index INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_session_facts_session ON session_facts(session_id);
CREATE INDEX IF NOT EXISTS idx_session_facts_project ON session_facts(project_path);
CREATE INDEX IF NOT EXISTS idx_session_facts_category ON session_facts(category);
CREATE INDEX IF NOT EXISTS idx_session_facts_severity ON session_facts(severity);
`;

// === Store ===

export class SessionFactsStore {
  private db: Database;
  private stmtInsert: any;
  private stmtGetBySession: any;
  private stmtGetByProject: any;
  private stmtGetByCategory: any;
  private stmtGetRecentErrors: any;
  private stmtGetFileChanges: any;
  private stmtCount: any;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.exec("PRAGMA journal_mode=WAL");
    this.db.exec(SCHEMA_SQL);

    this.stmtInsert = this.db.prepare(
      `INSERT INTO session_facts (session_id, project_path, category, content, metadata, severity, message_index, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.stmtGetBySession = this.db.prepare(
      "SELECT * FROM session_facts WHERE session_id = ? ORDER BY message_index ASC",
    );
    this.stmtGetByProject = this.db.prepare(
      "SELECT * FROM session_facts WHERE project_path = ? ORDER BY created_at DESC LIMIT ?",
    );
    this.stmtGetByCategory = this.db.prepare(
      "SELECT * FROM session_facts WHERE project_path = ? AND category = ? ORDER BY created_at DESC LIMIT ?",
    );
    this.stmtGetRecentErrors = this.db.prepare(
      `SELECT * FROM session_facts WHERE project_path = ? AND category = 'ERROR_PATTERN' AND created_at > ? ORDER BY created_at DESC`,
    );
    this.stmtGetFileChanges = this.db.prepare(
      `SELECT * FROM session_facts WHERE project_path = ? AND category = 'FILE_CHANGE' AND content LIKE ? ORDER BY created_at DESC LIMIT ?`,
    );
    this.stmtCount = this.db.prepare(
      "SELECT COUNT(*) AS count FROM session_facts WHERE project_path = ?",
    );
  }

  // === CRUD ===

  insert(input: SessionFactInput): SessionFact {
    const now = Date.now();
    const result = this.stmtInsert.run(
      input.sessionId,
      input.projectPath,
      input.category,
      input.content,
      JSON.stringify(input.metadata ?? {}),
      input.severity ?? "info",
      input.messageIndex,
      now,
    );

    return {
      id: Number(result.lastInsertRowid),
      sessionId: input.sessionId,
      projectPath: input.projectPath,
      category: input.category,
      content: input.content,
      metadata: JSON.stringify(input.metadata ?? {}),
      severity: input.severity ?? "info",
      messageIndex: input.messageIndex,
      createdAt: now,
    };
  }

  getBySession(sessionId: string): SessionFact[] {
    return this.stmtGetBySession.all(sessionId) as SessionFact[];
  }

  getByProject(projectPath: string, limit: number = 100): SessionFact[] {
    return this.stmtGetByProject.all(projectPath, limit) as SessionFact[];
  }

  getByCategory(projectPath: string, category: FactCategory, limit: number = 50): SessionFact[] {
    return this.stmtGetByCategory.all(projectPath, category, limit) as SessionFact[];
  }

  getRecentErrors(projectPath: string, sinceMs: number): SessionFact[] {
    return this.stmtGetRecentErrors.all(projectPath, sinceMs) as SessionFact[];
  }

  getFileChangesForPath(projectPath: string, filePath: string, limit: number = 20): SessionFact[] {
    return this.stmtGetFileChanges.all(projectPath, `%${filePath}%`, limit) as SessionFact[];
  }

  count(projectPath: string): number {
    const row = this.stmtCount.get(projectPath) as { count: number } | undefined;
    return row?.count ?? 0;
  }

  close(): void {
    this.db.close();
  }
}

// === Extraction ===

/**
 * Extract facts from a single message. Returns an array of facts found.
 */
function extractFactsFromMessage(
  message: any,
  index: number,
  sessionId: string,
  projectPath: string,
): SessionFactInput[] {
  const facts: SessionFactInput[] = [];
  const role = message.role ?? "unknown";

  // Tool calls (from tool-role messages or tool parts)
  if (role === "tool" || role === "tool-result") {
    const toolName = getToolName(message);
    const isError = message.is_error || message.isError || message.error;

    facts.push({
      sessionId,
      projectPath,
      category: "TOOL_CALL",
      content: `Tool: ${toolName ?? "unknown"} — ${isError ? "FAILED" : "success"}`,
      metadata: {
        toolName,
        isError: !!isError,
        errorMessage: isError ? getMessageText(message).slice(0, 200) : undefined,
      },
      severity: isError ? "warning" : "info",
      messageIndex: index,
    });

    // File changes from edit/write/apply_patch calls
    if (toolName === "edit" || toolName === "write" || toolName === "apply_patch") {
      const input = getToolInput(message);
      if (input) {
        const filePath = (input.filePath ?? input.file_path ?? input.path ?? "") as string;
        if (filePath) {
          facts.push({
            sessionId,
            projectPath,
            category: "FILE_CHANGE",
            content: `${toolName}: ${filePath}`,
            metadata: {
              toolName,
              filePath,
              operation: toolName === "write" ? "create" : "modify",
            },
            severity: "info",
            messageIndex: index,
          });
        }
      }
    }
  }

  // Decision detection from user messages
  if (role === "user") {
    const text = getMessageText(message).toLowerCase();
    const decisionPatterns = [
      /(?:decide|decision|let's go with|choosing|we'll use|the approach is|the plan is)/i,
      /(?:architecture|design pattern|framework|library choice)/i,
      /(?:instead of|rather than|replacing|upgrading from)/i,
    ];

    for (const pattern of decisionPatterns) {
      if (pattern.test(getMessageText(message))) {
        facts.push({
          sessionId,
          projectPath,
          category: "DECISION",
          content: getMessageText(message).slice(0, 500),
          metadata: { pattern: pattern.source },
          severity: "info",
          messageIndex: index,
        });
        break;
      }
    }
  }

  // Error patterns from assistant messages
  if (role === "assistant") {
    const text = getMessageText(message);
    const errorPatterns = [
      /(?:error|bug|issue|crash|failure|broken|workaround)/i,
      /(?:had to fix|turned out|root cause|regression)/i,
    ];

    for (const pattern of errorPatterns) {
      if (pattern.test(text)) {
        facts.push({
          sessionId,
          projectPath,
          category: "ERROR_PATTERN",
          content: text.slice(0, 500),
          metadata: { pattern: pattern.source },
          severity: "warning",
          messageIndex: index,
        });
        break;
      }
    }
  }

  // Config changes
  if (role === "assistant") {
    const text = getMessageText(message);
    if (/(?:config|setting|\.env|\.json|\.yaml|\.toml).*(?:changed|updated|modified|added)/i.test(text)) {
      facts.push({
        sessionId,
        projectPath,
        category: "CONFIG_CHANGE",
        content: text.slice(0, 500),
        metadata: {},
        severity: "info",
        messageIndex: index,
      });
    }
  }

  return facts;
}

/**
 * Extract all facts from a session's messages.
 */
export function extractSessionFacts(
  messages: any[],
  sessionId: string,
  projectPath: string,
): SessionFactInput[] {
  const allFacts: SessionFactInput[] = [];

  for (let i = 0; i < messages.length; i++) {
    const facts = extractFactsFromMessage(messages[i], i, sessionId, projectPath);
    allFacts.push(...facts);
  }

  return allFacts;
}

/**
 * Extract and store facts from a session. Returns the count of facts stored.
 */
export function extractAndStoreFacts(
  store: SessionFactsStore,
  messages: any[],
  sessionId: string,
  projectPath: string,
): number {
  const facts = extractSessionFacts(messages, sessionId, projectPath);
  let stored = 0;

  for (const fact of facts) {
    try {
      store.insert(fact);
      stored++;
    } catch {
      // Best-effort: don't break on individual fact failures
    }
  }

  return stored;
}

// === Singleton ===

const _instances = new Map<string, SessionFactsStore>();

export function getSessionFactsStore(dbPath: string): SessionFactsStore {
  let instance = _instances.get(dbPath);
  if (!instance) {
    instance = new SessionFactsStore(dbPath);
    _instances.set(dbPath, instance);
  }
  return instance;
}
