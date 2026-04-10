import { afterEach, describe, test, expect } from "bun:test"
import path from "path"
import fs from "fs"
import { Instance } from "../../src/project/instance"
import { Database } from "../../src/storage/db"
import { MemoryTable } from "../../src/memory/memory.sql"
import { MemoryInjector } from "../../src/memory/injector"
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
  description?: string
  agent?: string
  accessCount?: number
  scope?: string
  relevanceScore?: number
  timeUpdated?: number
}) {
  const now = Date.now()
  d.insert(MemoryTable).values({
    id: input.id,
    project_path: input.projectPath,
    topic: input.topic,
    type: input.type,
    content: input.content,
    description: input.description ?? null,
    agent: input.agent ?? null,
    session_id: null,
    access_count: input.accessCount ?? 1,
    scope: input.scope ?? "project",
    relevance_score: input.relevanceScore ?? 1.0,
    time_last_verified: null,
    promoted_from: null,
    time_created: now,
    time_updated: input.timeUpdated ?? now,
  }).run()
}

describe("MemoryInjector.load", () => {
  test("returns undefined when DB is empty and no MEMORY.md", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const result = await MemoryInjector.load()
        expect(result).toBeUndefined()
      },
    })
  })

  test("returns memory header and entries when DB has data", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        Database.use((d) => {
          seed(d, {
            id: "mem-1",
            projectPath: tmp.path,
            topic: "test-entry",
            type: "project",
            content: "This is a test memory entry",
            accessCount: 2,
          })
        })

        const result = await MemoryInjector.load()
        expect(result).toBeDefined()
        expect(result).toContain("# Memory")
        expect(result).toContain("## Project Knowledge")
        expect(result).toContain("test-entry")
      },
    })
  })

  test("groups entries by type into correct sections", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        Database.use((d) => {
          seed(d, { id: "m1", projectPath: tmp.path, topic: "proj-note", type: "project", content: "Project info" })
          seed(d, { id: "m2", projectPath: tmp.path, topic: "user-pref", type: "user", content: "User preference" })
          seed(d, { id: "m3", projectPath: tmp.path, topic: "fb-pattern", type: "feedback", content: "Feedback pattern" })
          seed(d, { id: "m4", projectPath: tmp.path, topic: "ref-link", type: "reference", content: "Reference link" })
        })

        const result = await MemoryInjector.load()
        expect(result).toBeDefined()
        expect(result).toContain("## Project Knowledge")
        expect(result).toContain("## User Preferences")
        expect(result).toContain("## Feedback & Patterns")
        expect(result).toContain("## Reference")
      },
    })
  })

  test("includes agent entries in output when agent is specified", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        Database.use((d) => {
          seed(d, { id: "g1", projectPath: tmp.path, topic: "general-note", type: "project", content: "General info" })
          seed(d, { id: "a1", projectPath: tmp.path, topic: "agent-note", type: "project", content: "Agent-specific info", agent: "code-reviewer" })
        })

        const result = await MemoryInjector.load("code-reviewer")
        expect(result).toBeDefined()
        // Agent entries are included in the output (may be in general or agent-specific section)
        expect(result).toContain("agent-note")
        expect(result).toContain("general-note")
      },
    })
  })

  test("deduplicates agent entries that appear in general entries", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        Database.use((d) => {
          seed(d, { id: "shared-1", projectPath: tmp.path, topic: "shared-entry", type: "project", content: "Shared content", agent: "planner" })
        })

        const result = await MemoryInjector.load("planner")
        expect(result).toBeDefined()
        const matches = (result!.match(/shared-entry/g) || []).length
        expect(matches).toBe(1)
      },
    })
  })

  test("sorts entries by relevance weight (highest first)", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const now = Date.now()
        Database.use((d) => {
          seed(d, { id: "low", projectPath: tmp.path, topic: "low-relevance", type: "project", content: "Low score", relevanceScore: 0.2, accessCount: 1, timeUpdated: now })
          seed(d, { id: "high", projectPath: tmp.path, topic: "high-relevance", type: "project", content: "High score", relevanceScore: 1.0, accessCount: 10, timeUpdated: now })
        })

        const result = await MemoryInjector.load()
        expect(result).toBeDefined()
        const highIdx = result!.indexOf("high-relevance")
        const lowIdx = result!.indexOf("low-relevance")
        expect(highIdx).toBeLessThan(lowIdx)
      },
    })
  })

  test("respects token budget and truncates entries", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        Database.use((d) => {
          for (let i = 0; i < 50; i++) {
            seed(d, {
              id: `bulk-${i}`,
              projectPath: tmp.path,
              topic: `entry-${i}`,
              type: "project",
              content: "A".repeat(500),
            })
          }
        })

        const result = await MemoryInjector.load()
        expect(result).toBeDefined()
        const entryCount = (result!.match(/entry-\d+/g) || []).length
        expect(entryCount).toBeLessThan(50)
        expect(entryCount).toBeGreaterThan(0)
      },
    })
  })

  test("falls back to MEMORY.md when DB has no entries", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const memDir = path.join(tmp.path, ".opencode", "memory")
        fs.mkdirSync(memDir, { recursive: true })
        fs.writeFileSync(path.join(memDir, "MEMORY.md"), "- [Test Memory](test.md) -- a test memory entry\n")

        const result = await MemoryInjector.load()
        expect(result).toBeDefined()
        expect(result).toContain("# Memory")
        expect(result).toContain("Test Memory")
      },
    })
  })

  test("includes description in entry output when present", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        Database.use((d) => {
          seed(d, {
            id: "desc-1",
            projectPath: tmp.path,
            topic: "described-entry",
            type: "user",
            content: "Content here",
            description: "This is the description",
          })
        })

        const result = await MemoryInjector.load()
        expect(result).toBeDefined()
        expect(result).toContain("This is the description")
      },
    })
  })
})
