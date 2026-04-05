import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core"
import { Timestamps } from "../storage/schema.sql"

export const MemoryTable = sqliteTable(
  "memory",
  {
    id: text().primaryKey(),
    project_path: text().notNull(),
    topic: text().notNull(),
    type: text().notNull(),
    content: text().notNull(),
    session_id: text(),
    access_count: integer().default(0),
    ...Timestamps,
  },
  (table) => [
    index("memory_project_path_idx").on(table.project_path),
    index("memory_type_idx").on(table.type),
  ],
)
