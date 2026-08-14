import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260814100000_task_tables",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE IF NOT EXISTS \`task\` (
          \`id\` text NOT NULL,
          \`session_id\` text NOT NULL,
          \`parent_task_id\` text,
          \`status\` text NOT NULL,
          \`summary\` text NOT NULL,
          \`owner\` text,
          \`created_at\` integer NOT NULL,
          \`last_event_at\` integer NOT NULL,
          \`ended_at\` integer,
          \`cleanup_after\` integer,
          PRIMARY KEY (\`session_id\`, \`id\`),
          FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE INDEX IF NOT EXISTS \`task_session_idx\`
        ON \`task\` (\`session_id\`);
      `)
      yield* tx.run(`
        CREATE INDEX IF NOT EXISTS \`task_parent_idx\`
        ON \`task\` (\`session_id\`, \`parent_task_id\`);
      `)
      yield* tx.run(`
        CREATE INDEX IF NOT EXISTS \`task_status_idx\`
        ON \`task\` (\`status\`);
      `)
      yield* tx.run(`
        CREATE TABLE IF NOT EXISTS \`task_event\` (
          \`id\` integer PRIMARY KEY AUTOINCREMENT,
          \`session_id\` text NOT NULL,
          \`task_id\` text NOT NULL,
          \`at\` integer NOT NULL,
          \`kind\` text NOT NULL,
          \`summary\` text,
          FOREIGN KEY (\`session_id\`, \`task_id\`) REFERENCES \`task\`(\`session_id\`, \`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE INDEX IF NOT EXISTS \`task_event_task_idx\`
        ON \`task_event\` (\`session_id\`, \`task_id\`, \`at\`);
      `)
    })
  },
} satisfies DatabaseMigration.Migration
