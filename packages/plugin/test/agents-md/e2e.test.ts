import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { runInitDeep } from "../../src/agents-md/index.js"

let tmp: string

async function write(rel: string, body: string): Promise<void> {
  const abs = path.join(tmp, rel)
  await fs.mkdir(path.dirname(abs), { recursive: true })
  await fs.writeFile(abs, body, "utf8")
}

async function read(rel: string): Promise<string> {
  return fs.readFile(path.join(tmp, rel), "utf8")
}

beforeAll(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "init-deep-e2e-"))
  // Synthetic project: TS root + a hot src/ + a tiny isolated python tool
  await write("package.json", JSON.stringify({ name: "fixture", description: "fixture project" }))
  await write("src/index.ts", "export const hello = 1\n".repeat(50))
  await write("src/util.ts", "export const u = 2\n".repeat(50))
  await write("src/api/client.ts", "export const c = 3\n".repeat(40))
  await write("src/api/types.ts", "export type T = number\n".repeat(40))
  await write("src/api/server.ts", "export const s = 4\n".repeat(40))
  await write("src/api/router.ts", "export const r = 5\n".repeat(40))
  await write("scripts/build.ts", "// build\n".repeat(10))
  await write("docs/intro.md", "intro")
  await write(".gitignore", "node_modules\n.cache\n")
})

afterAll(async () => {
  await fs.rm(tmp, { recursive: true, force: true })
})

describe("runInitDeep() — e2e on synthetic tree", () => {
  test("dryRun produces a non-empty plan without writing files", async () => {
    const result = await runInitDeep({ cwd: tmp, dryRun: true })
    expect(result.plan).toBeDefined()
    expect(result.plan!.length).toBeGreaterThan(0)
    expect(result.generated.length).toBe(0)
    // root must always be in the plan
    expect(result.plan!.find((p) => p.path === tmp)).toBeDefined()
    // no AGENTS.md should have been written
    expect(await fileExists(path.join(tmp, "AGENTS.md"))).toBe(false)
  })

  test("non-dry run writes AGENTS.md at the repo root and at hot directories", async () => {
    const result = await runInitDeep({ cwd: tmp })
    expect(result.generated.length).toBeGreaterThan(0)
    const root = await read("AGENTS.md")
    expect(root).toContain("# ")
    expect(root).toContain("## Overview")
    expect(root).toContain("## Project Context")
    expect(root).toContain("## Build & Test")
    expect(root).toContain("## Where to find things")
    // src/api had 4 source files → certainly above the hard threshold
    const apiPath = path.join(tmp, "src/api/AGENTS.md")
    const apiExists = await fileExists(apiPath)
    expect(apiExists).toBe(true)
  })

  test("re-running is idempotent (no diff in output)", async () => {
    const before = await read("AGENTS.md")
    await runInitDeep({ cwd: tmp })
    const after = await read("AGENTS.md")
    expect(after).toBe(before)
  })

  test("hand-written content in an existing AGENTS.md is preserved on re-run", async () => {
    await write("AGENTS.md", [await read("AGENTS.md"), "", "## House Rules", "", "respect the kitchen"].join("\n"))
    await runInitDeep({ cwd: tmp })
    const after = await read("AGENTS.md")
    expect(after).toContain("respect the kitchen")
  })

  test("approxTokensAdded reflects emitted content", async () => {
    const result = await runInitDeep({ cwd: tmp })
    expect(result.approxTokensAdded).toBeGreaterThan(0)
  })

  test("createNew lowers the threshold and emits more files", async () => {
    // Reset by removing all generated AGENTS.md, then compare the two modes.
    const all = await collectAgentsMd(tmp)
    for (const f of all) await fs.unlink(f)
    const normal = await runInitDeep({ cwd: tmp })
    for (const f of normal.generated) await fs.unlink(f)
    const aggressive = await runInitDeep({ cwd: tmp, createNew: true })
    expect(aggressive.generated.length).toBeGreaterThanOrEqual(normal.generated.length)
  })
})

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p)
    return true
  } catch {
    return false
  }
}

async function collectAgentsMd(root: string): Promise<string[]> {
  const out: string[] = []
  async function walk(dir: string): Promise<void> {
    const entries = await fs.readdir(dir, { withFileTypes: true })
    for (const e of entries) {
      const abs = path.join(dir, e.name)
      if (e.isDirectory()) {
        if (e.name === "node_modules" || e.name.startsWith(".")) continue
        await walk(abs)
      } else if (e.isFile() && e.name === "AGENTS.md") {
        out.push(abs)
      }
    }
  }
  await walk(root)
  return out
}
