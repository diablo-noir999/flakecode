import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260808120000_history_fts",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE IF NOT EXISTS \`history_fts\` (
          \`part_id\` text PRIMARY KEY,
          \`session_id\` text NOT NULL,
          \`message_id\` text NOT NULL,
          \`project_id\` text NOT NULL,
          \`kind\` text NOT NULL,
          \`tool_name\` text,
          \`body\` text NOT NULL,
          \`time_created\` integer NOT NULL
        );
      `)
      yield* tx.run(`
        CREATE INDEX IF NOT EXISTS \`history_fts_session_idx\`
        ON \`history_fts\` (\`session_id\`, \`time_created\`);
      `)
      yield* tx.run(`
        CREATE INDEX IF NOT EXISTS \`history_fts_project_idx\`
        ON \`history_fts\` (\`project_id\`, \`time_created\`);
      `)
      yield* tx.run(`
        CREATE INDEX IF NOT EXISTS \`history_fts_message_idx\`
        ON \`history_fts\` (\`message_id\`);
      `)
      yield* tx.run(`
        CREATE VIRTUAL TABLE IF NOT EXISTS \`history_fts_idx\`
        USING fts5(
          \`part_id\`,
          \`session_id\`,
          \`project_id\`,
          \`kind\`,
          \`tool_name\`,
          \`body\`,
          content=\`history_fts\`,
          content_rowid=\`rowid\`,
          tokenize='unicode61 remove_diacritics 2'
        );
      `)
    })
  },
} satisfies DatabaseMigration.Migration
