import { afterEach, describe, test, expect } from "bun:test"
import path from "path"
import fs from "fs"
import { Instance } from "../../src/project/instance"
import { Database, eq } from "../../src/storage/db"
import { MemoryTable } from "../../src/memory/memory.sql"
import { MemoryDream } from "../../src/memory/dream"
import { Log } from "../../src/util/log"
import { tmpdir } from "../fixture/fixture"

Log.init({ print: false })

afterEach(async () => {
  await Instance.disposeAll()
})

type DbClient = Parameters<typeof Database.use>[0] extends (trx: infer D) => any ? D : never

function seed(d: DbClient, input: {
  id: string
  projectPath: string
  topic: string
  type: string
  content: string
  accessCount?: number
  relevanceScore?: number
  scope?: string
}) {
  const now = Date.now()
  d.insert(MemoryTable).values({
    id: input.id,
    project_path: input.projectPath,
    topic: input.topic,
    type: input.type,
    content: input.content,
    description: null,
    agent: null,
    session_id: null,
    access_count: input.accessCount ?? 0,
    scope: input.scope ?? "project",
    relevance_score: input.relevanceScore ?? 1.0,
    time_last_verified: null,
    promoted_from: null,
    time_created: now,
    time_updated: now,
  }).run()
}

describe("MemoryDream", () => {
  test("shouldRun returns false when no meta file", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const result = await MemoryDream.shouldRun(tmp.path)
        expect(result).toBe(false)
      },
    })
  })

  test("shouldRun returns false when conditions not met", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        // Create meta with recent dream and few sessions
        const metaDir = path.join(tmp.path, ".opencode", "memory")
        fs.mkdirSync(metaDir, { recursive: true })
        fs.writeFileSync(path.join(metaDir, ".dream-meta.json"), JSON.stringify({
          lastDreamTime: Date.now(),
          sessionsSinceLast: 2,
        }))

        const result = await MemoryDream.shouldRun(tmp.path)
        expect(result).toBe(false)
      },
    })
  })

  test("shouldRun returns true when 24h+ and 5+ sessions", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const metaDir = path.join(tmp.path, ".opencode", "memory")
        fs.mkdirSync(metaDir, { recursive: true })
        fs.writeFileSync(path.join(metaDir, ".dream-meta.json"), JSON.stringify({
          lastDreamTime: Date.now() - 25 * 60 * 60 * 1000, // 25 hours ago
          sessionsSinceLast: 6,
        }))

        const result = await MemoryDream.shouldRun(tmp.path)
        expect(result).toBe(true)
      },
    })
  })

  test("trackSession increments counter", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await MemoryDream.trackSession(tmp.path)
        await MemoryDream.trackSession(tmp.path)

        const metaPath = path.join(tmp.path, ".opencode", "memory", ".dream-meta.json")
        const meta = JSON.parse(fs.readFileSync(metaPath, "utf-8"))
        expect(meta.sessionsSinceLast).toBe(2)
      },
    })
  })

  test("run consolidates duplicate entries", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const ts = Date.now()
        Database.use((d) => {
          seed(d, { id: `dup1-${ts}`, projectPath: tmp.path, topic: "frequently used command: npm test", type: "project", content: "npm test used 5 times", accessCount: 5 })
          seed(d, { id: `dup2-${ts}`, projectPath: tmp.path, topic: "frequently used command: npm test", type: "project", content: "npm test used 3 times", accessCount: 3 })
        })

        const result = await MemoryDream.run(tmp.path)
        expect(result.consolidated).toBeGreaterThan(0)

        // Verify only one entry remains
        const remaining = Database.use((d) =>
          d.select().from(MemoryTable)
            .where(eq(MemoryTable.project_path, tmp.path))
            .all()
        )
        expect(remaining.length).toBe(1)
        expect(remaining[0].access_count).toBe(5) // kept the higher access count one
      },
    })
  })

  test("run prunes very low relevance entries", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const ts = Date.now()
        Database.use((d) => {
          seed(d, { id: `stale-${ts}`, projectPath: tmp.path, topic: "old memory", type: "project", content: "stale content", relevanceScore: 0.05 })
          seed(d, { id: `fresh-${ts}`, projectPath: tmp.path, topic: "fresh memory", type: "project", content: "fresh content", relevanceScore: 0.9 })
        })

        const result = await MemoryDream.run(tmp.path)
        expect(result.pruned).toBe(1)
      },
    })
  })

  test("run returns zero counts for empty DB", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const result = await MemoryDream.run(tmp.path)
        expect(result.consolidated).toBe(0)
        expect(result.pruned).toBe(0)
        expect(result.promoted).toBe(0)
      },
    })
  })

  test("run updates dream meta after completion", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const ts = Date.now()
        Database.use((d) => {
          seed(d, { id: `meta-${ts}`, projectPath: tmp.path, topic: "test entry", type: "project", content: "test" })
        })

        await MemoryDream.run(tmp.path)

        const metaPath = path.join(tmp.path, ".opencode", "memory", ".dream-meta.json")
        expect(fs.existsSync(metaPath)).toBe(true)
        const meta = JSON.parse(fs.readFileSync(metaPath, "utf-8"))
        expect(meta.sessionsSinceLast).toBe(0) // reset after dream
        expect(meta.lastDreamTime).toBeGreaterThan(ts - 1000)
      },
    })
  })
})
