import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { discover } from "../../src/agents-md/discovery.js"

let tmp: string

async function write(rel: string, body: string): Promise<void> {
  const abs = path.join(tmp, rel)
  await fs.mkdir(path.dirname(abs), { recursive: true })
  await fs.writeFile(abs, body, "utf8")
}

beforeAll(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "init-deep-discovery-"))
  // Real source directories.
  await write("src/index.ts", "export const a = 1\n")
  await write("src/util.ts", "export const b = 2\n")
  // gitignored buckets that should be invisible to discovery.
  await write("artifacts/build1/output.ts", "// generated\n")
  await write("artifacts/build2/output.ts", "// generated\n")
  await write("artifacts/build3/output.ts", "// generated\n")
  await write("logs/run1.log", "log\n")
  await write("logs/run2.log", "log\n")
  await write(".gitignore", ["artifacts", "logs"].join("\n") + "\n")
})

afterAll(async () => {
  await fs.rm(tmp, { recursive: true, force: true })
})

describe("discover()", () => {
  // Regression for HIGH H2 — collectStats used to ignore .gitignore when
  // counting `subdirCount`, so a directory whose only children were ignored
  // (e.g. `artifacts/`) still reported a subdirCount that inflated its score
  // and triggered spurious AGENTS.md generation. discover() must apply the
  // same filter chain (excluded list + dot-prefix + .gitignore) to subdir
  // counting that it applies to recursion.
  test("H2: gitignored subdirectories are excluded from subdirCount", async () => {
    const stats = await discover({ cwd: tmp, maxDepth: 3 })
    const root = stats.find((s) => s.relPath === ".")!
    // `artifacts/` and `logs/` are gitignored, so they must NOT count toward
    // the root's subdirCount. Only `src/` should be visible.
    expect(root.subdirCount).toBe(1)
    // And discover() should not return DirStats for the ignored subdirs.
    expect(stats.find((s) => s.relPath === "artifacts")).toBeUndefined()
    expect(stats.find((s) => s.relPath === "logs")).toBeUndefined()
    expect(stats.find((s) => s.relPath === "src")).toBeDefined()
  })
})
