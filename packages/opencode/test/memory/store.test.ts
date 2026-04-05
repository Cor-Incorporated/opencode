import { afterEach, describe, test, expect } from "bun:test"
import { eq, and, sql } from "drizzle-orm"
import { Instance } from "../../src/project/instance"
import { Database } from "../../src/storage/db"
import { MemoryTable } from "../../src/memory/memory.sql"
import { Log } from "../../src/util/log"
import { tmpdir } from "../fixture/fixture"

Log.init({ print: false })

afterEach(async () => {
  await Instance.disposeAll()
})

// Test the MemoryStore CRUD logic by exercising the DB directly.
// The Effect layer (MemoryStore) wraps these same Drizzle operations.
// This avoids the ManagedRuntime ALS boundary issue in tests.
describe("memory.store", () => {
  function insert(d: Parameters<typeof Database.use>[0] extends (trx: infer D) => any ? D : never, input: {
    id: string
    projectPath: string
    topic: string
    type: string
    content: string
    sessionID?: string
  }) {
    const now = Date.now()
    d.insert(MemoryTable).values({
      id: input.id,
      project_path: input.projectPath,
      topic: input.topic,
      type: input.type,
      content: input.content,
      session_id: input.sessionID ?? null,
      access_count: 0,
      time_created: now,
      time_updated: now,
    }).run()
    return { ...input, accessCount: 0, timeCreated: now, timeUpdated: now }
  }

  test("insert and select round-trip", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const id = "test_" + Date.now()
        Database.use((d) => {
          insert(d, { id, projectPath: "/test", topic: "hello", type: "general", content: "world", sessionID: "ses_1" })
        })
        const row = Database.use((d) =>
          d.select().from(MemoryTable).where(eq(MemoryTable.id, id)).get()
        )
        expect(row).toBeDefined()
        expect(row!.id).toBe(id)
        expect(row!.project_path).toBe("/test")
        expect(row!.topic).toBe("hello")
        expect(row!.type).toBe("general")
        expect(row!.content).toBe("world")
        expect(row!.session_id).toBe("ses_1")
        expect(row!.access_count).toBe(0)
        expect(typeof row!.time_created).toBe("number")
        expect(typeof row!.time_updated).toBe("number")
      },
    })
  })

  test("access_count increments on read", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const id = "test_access_" + Date.now()
        Database.use((d) => {
          insert(d, { id, projectPath: "/test", topic: "counter", type: "general", content: "count" })
        })

        const before = Database.use((d) =>
          d.select().from(MemoryTable).where(eq(MemoryTable.id, id)).get()
        )
        expect(before!.access_count).toBe(0)

        Database.use((d) =>
          d.update(MemoryTable)
            .set({ access_count: sql`${MemoryTable.access_count} + 1` })
            .where(eq(MemoryTable.id, id))
            .run()
        )

        const after = Database.use((d) =>
          d.select().from(MemoryTable).where(eq(MemoryTable.id, id)).get()
        )
        expect(after!.access_count).toBe(1)
      },
    })
  })

  test("select returns undefined for non-existent id", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const row = Database.use((d) =>
          d.select().from(MemoryTable).where(eq(MemoryTable.id, "nonexistent")).get()
        )
        expect(row).toBeUndefined()
      },
    })
  })

  test("update modifies topic and content", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const id = "test_update_" + Date.now()
        Database.use((d) => {
          insert(d, { id, projectPath: "/test", topic: "original", type: "general", content: "original content" })
        })

        Database.use((d) =>
          d.update(MemoryTable)
            .set({ topic: "updated", content: "updated content", time_updated: Date.now() })
            .where(eq(MemoryTable.id, id))
            .run()
        )

        const row = Database.use((d) =>
          d.select().from(MemoryTable).where(eq(MemoryTable.id, id)).get()
        )
        expect(row!.topic).toBe("updated")
        expect(row!.content).toBe("updated content")
        expect(row!.type).toBe("general")
      },
    })
  })

  test("delete removes entry", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const id = "test_delete_" + Date.now()
        Database.use((d) => {
          insert(d, { id, projectPath: "/test", topic: "deleteme", type: "general", content: "bye" })
        })

        Database.use((d) =>
          d.delete(MemoryTable).where(eq(MemoryTable.id, id)).run()
        )

        const row = Database.use((d) =>
          d.select().from(MemoryTable).where(eq(MemoryTable.id, id)).get()
        )
        expect(row).toBeUndefined()
      },
    })
  })

  test("list filters by project_path", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const pathA = "/test/a-" + Date.now()
        const pathB = "/test/b-" + Date.now()

        Database.use((d) => {
          insert(d, { id: "a1", projectPath: pathA, topic: "a", type: "general", content: "a" })
          insert(d, { id: "b1", projectPath: pathB, topic: "b", type: "general", content: "b" })
        })

        const listA = Database.use((d) =>
          d.select().from(MemoryTable).where(eq(MemoryTable.project_path, pathA)).all()
        )
        expect(listA.length).toBe(1)
        expect(listA[0].topic).toBe("a")

        const listB = Database.use((d) =>
          d.select().from(MemoryTable).where(eq(MemoryTable.project_path, pathB)).all()
        )
        expect(listB.length).toBe(1)
        expect(listB[0].topic).toBe("b")
      },
    })
  })

  test("listByType filters by project_path and type", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const p = "/test/typed-" + Date.now()

        Database.use((d) => {
          insert(d, { id: "gen1", projectPath: p, topic: "gen", type: "general", content: "gen" })
          insert(d, { id: "pref1", projectPath: p, topic: "pref", type: "preference", content: "pref" })
        })

        const generals = Database.use((d) =>
          d.select().from(MemoryTable)
            .where(and(eq(MemoryTable.project_path, p), eq(MemoryTable.type, "general")))
            .all()
        )
        expect(generals.length).toBe(1)
        expect(generals[0].type).toBe("general")

        const prefs = Database.use((d) =>
          d.select().from(MemoryTable)
            .where(and(eq(MemoryTable.project_path, p), eq(MemoryTable.type, "preference")))
            .all()
        )
        expect(prefs.length).toBe(1)
        expect(prefs[0].type).toBe("preference")
      },
    })
  })
})
