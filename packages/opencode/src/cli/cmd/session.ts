import type { Argv } from "yargs"
import { Database } from "bun:sqlite"
import { Effect } from "effect"
import { cmd } from "./cmd"
import { effectCmd, fail } from "../effect-cmd"
import { Session } from "@/session/session"
import { SessionID } from "../../session/schema"
import { UI } from "../ui"
import { Locale } from "@/util/locale"
import { Flag } from "@opencode-ai/core/flag/flag"
import { Global } from "@opencode-ai/core/global"
import { Filesystem } from "@/util/filesystem"
import { Process } from "@/util/process"
import { NotFoundError } from "@/storage/storage"
import { EOL } from "os"
import path from "path"
import { which } from "@opencode-ai/core/util/which"
import { readdirSync } from "fs"

function pagerCmd(): string[] {
  const lessOptions = ["-R", "-S"]
  if (process.platform !== "win32") {
    return ["less", ...lessOptions]
  }

  // user could have less installed via other options
  const lessOnPath = which("less")
  if (lessOnPath) {
    if (Filesystem.stat(lessOnPath)?.size) return [lessOnPath, ...lessOptions]
  }

  if (Flag.OPENCODE_GIT_BASH_PATH) {
    const less = path.join(Flag.OPENCODE_GIT_BASH_PATH, "..", "..", "usr", "bin", "less.exe")
    if (Filesystem.stat(less)?.size) return [less, ...lessOptions]
  }

  const git = which("git")
  if (git) {
    const less = path.join(git, "..", "..", "usr", "bin", "less.exe")
    if (Filesystem.stat(less)?.size) return [less, ...lessOptions]
  }

  // Fall back to Windows built-in more (via cmd.exe)
  return ["cmd", "/c", "more"]
}

export const SessionCommand = cmd({
  command: "session",
  describe: "manage sessions",
  builder: (yargs: Argv) =>
    yargs.command(SessionListCommand).command(SessionLocateCommand).command(SessionDeleteCommand).demandCommand(),
  async handler() {},
})

export const SessionDeleteCommand = effectCmd({
  command: "delete <sessionID>",
  describe: "delete a session",
  builder: (yargs) =>
    yargs.positional("sessionID", {
      describe: "session ID to delete",
      type: "string",
      demandOption: true,
    }),
  handler: Effect.fn("Cli.session.delete")(function* (args) {
    const svc = yield* Session.Service
    const sessionID = SessionID.make(args.sessionID)
    yield* svc
      .remove(sessionID)
      .pipe(Effect.catchIf(NotFoundError.isInstance, () => fail(`Session not found: ${args.sessionID}`)))
    UI.println(UI.Style.TEXT_SUCCESS_BOLD + `Session ${args.sessionID} deleted` + UI.Style.TEXT_NORMAL)
  }),
})

export const SessionListCommand = effectCmd({
  command: "list",
  describe: "list sessions",
  builder: (yargs) =>
    yargs
      .option("max-count", {
        alias: "n",
        describe: "limit to N most recent sessions",
        type: "number",
      })
      .option("format", {
        describe: "output format",
        type: "string",
        choices: ["table", "json"],
        default: "table",
      }),
  handler: Effect.fn("Cli.session.list")(function* (args) {
    const sessions = yield* Session.Service.use((svc) => svc.list({ roots: true, limit: args.maxCount }))

    if (sessions.length === 0) return

    const output = args.format === "json" ? formatSessionJSON(sessions) : formatSessionTable(sessions)

    const shouldPaginate = process.stdout.isTTY && !args.maxCount && args.format === "table"

    if (shouldPaginate) {
      yield* Effect.promise(async () => {
        const proc = Process.spawn(pagerCmd(), {
          stdin: "pipe",
          stdout: "inherit",
          stderr: "inherit",
        })

        if (!proc.stdin) {
          console.log(output)
          return
        }

        proc.stdin.write(output)
        proc.stdin.end()
        await proc.exited
      })
    } else {
      console.log(output)
    }
  }),
})

type LocatedSession = {
  database: string
  id: string
  title: string
  directory: string
  version: string
  updated: number
  created: number
  legacyMessages: number
  messages: number
}

export const SessionLocateCommand = cmd({
  command: "locate <sessionID>",
  describe: "locate the database containing a session",
  builder: (yargs: Argv) =>
    yargs
      .positional("sessionID", {
        describe: "session ID to locate",
        type: "string",
        demandOption: true,
      })
      .option("format", {
        describe: "output format",
        type: "string",
        choices: ["table", "json"],
        default: "table",
      }),
  async handler(args) {
    const sessionID = SessionID.make(args.sessionID)
    const sessions = locateSession(sessionID)
    if (sessions.length === 0) {
      console.error(`Session not found in ${Global.Path.data}/opencode*.db: ${sessionID}`)
      process.exitCode = 1
      return
    }

    const output = args.format === "json" ? formatLocateJSON(sessions) : formatLocateTable(sessions)
    console.log(output)
  },
})

function formatSessionTable(sessions: Session.Info[]): string {
  const lines: string[] = []

  const maxIdWidth = Math.max(20, ...sessions.map((s) => s.id.length))
  const maxTitleWidth = Math.max(25, ...sessions.map((s) => s.title.length))

  const header = `Session ID${" ".repeat(maxIdWidth - 10)}  Title${" ".repeat(maxTitleWidth - 5)}  Updated`
  lines.push(header)
  lines.push("─".repeat(header.length))
  for (const session of sessions) {
    const truncatedTitle = Locale.truncate(session.title, maxTitleWidth)
    const timeStr = Locale.todayTimeOrDateTime(session.time.updated)
    const line = `${session.id.padEnd(maxIdWidth)}  ${truncatedTitle.padEnd(maxTitleWidth)}  ${timeStr}`
    lines.push(line)
  }

  return lines.join(EOL)
}

function formatSessionJSON(sessions: Session.Info[]): string {
  const jsonData = sessions.map((session) => ({
    id: session.id,
    title: session.title,
    updated: session.time.updated,
    created: session.time.created,
    projectId: session.projectID,
    directory: session.directory,
  }))
  return JSON.stringify(jsonData, null, 2)
}

function locateSession(sessionID: SessionID): LocatedSession[] {
  return readdirSync(Global.Path.data)
    .filter((file) => /^opencode.*\.db$/.test(file))
    .flatMap((file) => locateSessionInDatabase(path.join(Global.Path.data, file), sessionID))
}

function locateSessionInDatabase(filename: string, sessionID: SessionID): LocatedSession[] {
  try {
    const db = new Database(filename, { readonly: true, strict: true })
    try {
      if (!hasTable(db, "session")) return []
      const row = db
        .query<
          {
            id: string
            title: string
            directory: string
            version: string
            time_created: number
            time_updated: number
          },
          [string]
        >("select id, title, directory, version, time_created, time_updated from session where id = ?")
        .get(sessionID)
      if (!row) return []

      return [
        {
          database: filename,
          id: row.id,
          title: row.title,
          directory: row.directory,
          version: row.version,
          updated: row.time_updated,
          created: row.time_created,
          legacyMessages: countSessionRows(db, "message", sessionID),
          messages: countSessionRows(db, "session_message", sessionID),
        },
      ]
    } finally {
      db.close()
    }
  } catch {
    return []
  }
}

function hasTable(db: Database, name: string) {
  return Boolean(
    db.query<{ name: string }, [string]>("select name from sqlite_master where type = 'table' and name = ?").get(name),
  )
}

function countSessionRows(db: Database, table: "message" | "session_message", sessionID: SessionID) {
  if (!hasTable(db, table)) return 0
  return db
    .query<{ count: number }, [string]>(`select count(*) as count from ${table} where session_id = ?`)
    .get(sessionID)!.count
}

function formatLocateTable(sessions: LocatedSession[]) {
  const lines = ["Database\tMessages\tUpdated\tTitle\tDirectory"]
  for (const session of sessions) {
    lines.push(
      [
        session.database,
        `${session.messages}/${session.legacyMessages}`,
        new Date(session.updated).toISOString(),
        session.title,
        session.directory,
      ].join("\t"),
    )
  }
  return lines.join(EOL)
}

function formatLocateJSON(sessions: LocatedSession[]) {
  return JSON.stringify(sessions, null, 2)
}
