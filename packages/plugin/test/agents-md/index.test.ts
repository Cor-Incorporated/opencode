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

beforeAll(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "init-deep-symlink-"))
  await write("package.json", JSON.stringify({ name: "fixture", description: "symlink fixture" }))
  // Enough source files to trigger generation at the root (which is always
  // emitted) and avoid any degenerate empty-tree edge cases.
  for (let i = 0; i < 4; i++) {
    await write(`src/mod${i}.ts`, "export const x = 1\n".repeat(20))
  }
  await write(".gitignore", "node_modules\n")
})

afterAll(async () => {
  await fs.rm(tmp, { recursive: true, force: true })
})

describe("runInitDeep() — path safety", () => {
  // Regression for the new path-safety finding — persist() must refuse to
  // write through an existing AGENTS.md symlink. Following the link could
  // silently overwrite a foreign file (potentially outside the project tree)
  // and would also break the idempotency contract.
  test("symlink AGENTS.md is not followed; original target is untouched", async () => {
    // Place the real file we are protecting *outside* the discovery root so
    // that even relative-path traversal could reach it. The init-deep run is
    // anchored at `tmp`, but the symlink at `tmp/AGENTS.md` resolves out.
    const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), "init-deep-outside-"))
    const outsideFile = path.join(outsideDir, "secret.md")
    const sentinel = "DO NOT OVERWRITE\n"
    await fs.writeFile(outsideFile, sentinel, "utf8")

    const linkPath = path.join(tmp, "AGENTS.md")
    await fs.symlink(outsideFile, linkPath)

    try {
      const result = await runInitDeep({ cwd: tmp })
      // The root AGENTS.md must NOT appear in the written list.
      expect(result.generated).not.toContain(linkPath)
      // It must appear in the skipped list with a clear reason.
      const skipEntry = result.skipped.find((s) => s.path === linkPath)
      expect(skipEntry).toBeDefined()
      expect(skipEntry!.reason).toContain("symlink")
      // The link target must be byte-identical to the sentinel content.
      const after = await fs.readFile(outsideFile, "utf8")
      expect(after).toBe(sentinel)
      // The symlink itself should still be a symlink (not replaced by a
      // regular file).
      const lst = await fs.lstat(linkPath)
      expect(lst.isSymbolicLink()).toBe(true)
    } finally {
      await fs.rm(linkPath, { force: true })
      await fs.rm(outsideDir, { recursive: true, force: true })
    }
  })
})
