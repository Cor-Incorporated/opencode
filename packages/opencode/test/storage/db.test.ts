import { describe, expect, test } from "bun:test"
import path from "path"
import { Effect } from "effect"
import { Global } from "@opencode-ai/core/global"
import { InstallationChannel } from "@opencode-ai/core/installation/version"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Database } from "@/storage/db"
import { configureJournalMode } from "@/storage/journal-mode"
import { it } from "../lib/effect"

describe("Database.getChannelPath", () => {
  it.effect("returns database path for the current channel", () =>
    Effect.gen(function* () {
      const flags = yield* RuntimeFlags.Service
      const expected = ["latest", "beta", "prod"].includes(InstallationChannel)
        ? path.join(Global.Path.data, "opencode.db")
        : path.join(Global.Path.data, `opencode-${InstallationChannel.replace(/[^a-zA-Z0-9._-]/g, "-")}.db`)

      expect(Database.getChannelPath(flags)).toBe(expected)
    }).pipe(Effect.provide(RuntimeFlags.layer())),
  )

  it.effect("uses the shared database path when channel databases are disabled", () =>
    Effect.gen(function* () {
      const flags = yield* RuntimeFlags.Service

      expect(Database.getChannelPath(flags)).toBe(path.join(Global.Path.data, "opencode.db"))
    }).pipe(Effect.provide(RuntimeFlags.layer({ disableChannelDb: true }))),
  )

  it.effect("accepts RuntimeFlags with skipMigrations for database callers", () =>
    Effect.gen(function* () {
      const flags = yield* RuntimeFlags.Service

      expect(flags.skipMigrations).toBe(true)
      expect(Database.getChannelPath(flags)).toBe(Database.getChannelPath({ disableChannelDb: flags.disableChannelDb }))
    }).pipe(Effect.provide(RuntimeFlags.layer({ skipMigrations: true }))),
  )
})

describe("configureJournalMode", () => {
  test("keeps WAL when the pragma succeeds", () => {
    const statements: string[] = []
    const result = configureJournalMode({
      run: (sql) => {
        statements.push(sql)
      },
    })

    expect(result).toBe("WAL")
    expect(statements).toEqual(["PRAGMA journal_mode = WAL"])
  })

  test("falls back to DELETE when WAL fails", () => {
    const statements: string[] = []
    const result = configureJournalMode({
      run: (sql) => {
        statements.push(sql)
        if (sql === "PRAGMA journal_mode = WAL") throw new Error("WAL unavailable")
      },
    })

    expect(result).toBe("DELETE")
    expect(statements).toEqual(["PRAGMA journal_mode = WAL", "PRAGMA journal_mode = DELETE"])
  })

  test("continues with the SQLite default when fallback also fails", () => {
    const statements: string[] = []
    const result = configureJournalMode({
      run: (sql) => {
        statements.push(sql)
        throw new Error(`${sql} unavailable`)
      },
    })

    expect(result).toBe("default")
    expect(statements).toEqual(["PRAGMA journal_mode = WAL", "PRAGMA journal_mode = DELETE"])
  })
})
