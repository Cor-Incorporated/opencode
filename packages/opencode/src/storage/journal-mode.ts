export type JournalModeDatabase = {
  run: (sql: string) => unknown
}

export function configureJournalMode(db: JournalModeDatabase) {
  try {
    db.run("PRAGMA journal_mode = WAL")
    return "WAL"
  } catch (error) {
    warn("failed to enable WAL journal mode, falling back to DELETE", error)
  }

  try {
    db.run("PRAGMA journal_mode = DELETE")
    return "DELETE"
  } catch (error) {
    warn("failed to enable DELETE journal mode fallback, continuing with SQLite default", error)
    return "default"
  }
}

function warn(message: string, error: unknown) {
  console.warn("[storage]", message, error)
}
