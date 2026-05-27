import * as Log from "@opencode-ai/core/util/log"

const log = Log.create({ service: "storage" })

export type JournalModeDatabase = {
  run: (sql: string) => unknown
}

export function configureJournalMode(db: JournalModeDatabase) {
  try {
    db.run("PRAGMA journal_mode = WAL")
    return "WAL"
  } catch (error) {
    log.warn("failed to enable WAL journal mode, falling back to DELETE", { error })
  }

  try {
    db.run("PRAGMA journal_mode = DELETE")
    return "DELETE"
  } catch (error) {
    log.warn("failed to enable DELETE journal mode fallback, continuing with SQLite default", { error })
    return "default"
  }
}
