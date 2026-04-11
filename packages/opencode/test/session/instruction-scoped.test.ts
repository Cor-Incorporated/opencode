import { describe, expect, test } from "bun:test"
import { ConfigMarkdown } from "../../src/config/markdown"

describe("Path-Scoped Rules", () => {
  describe("frontmatter parsing", () => {
    test("parses globs from frontmatter", async () => {
      const tmpDir = await import("node:os").then(os => os.tmpdir())
      const tmpFile = `${tmpDir}/test-rule-${Date.now()}.md`
      const content = `---\nglobs: ["src/**/*.ts"]\ndescription: Test rule\n---\n# Test Rule\n- Do something`
      await Bun.write(tmpFile, content)

      const result = await ConfigMarkdown.parse(tmpFile)
      expect(result.data.globs).toEqual(["src/**/*.ts"])
      expect(result.data.description).toBe("Test rule")
      expect(result.content.trim()).toBe("# Test Rule\n- Do something")

      await import("node:fs/promises").then(fs => fs.unlink(tmpFile))
    })

    test("parses single glob string", async () => {
      const tmpDir = await import("node:os").then(os => os.tmpdir())
      const tmpFile = `${tmpDir}/test-rule-single-${Date.now()}.md`
      const content = `---\nglobs: "*.tsx"\n---\n# TSX Rule`
      await Bun.write(tmpFile, content)

      const result = await ConfigMarkdown.parse(tmpFile)
      expect(result.data.globs).toBe("*.tsx")

      await import("node:fs/promises").then(fs => fs.unlink(tmpFile))
    })

    test("rule without globs has no globs field", async () => {
      const tmpDir = await import("node:os").then(os => os.tmpdir())
      const tmpFile = `${tmpDir}/test-rule-noglob-${Date.now()}.md`
      const content = `# Always Active Rule\n- Apply everywhere`
      await Bun.write(tmpFile, content)

      const result = await ConfigMarkdown.parse(tmpFile)
      expect(result.data.globs).toBeUndefined()

      await import("node:fs/promises").then(fs => fs.unlink(tmpFile))
    })
  })

  describe("glob matching", () => {
    test("matches file against glob pattern", async () => {
      const { Glob } = await import("../../src/util/glob")
      expect(Glob.match("src/**/*.ts", "src/memory/store.ts")).toBe(true)
      expect(Glob.match("src/**/*.ts", "test/memory/store.test.ts")).toBe(false)
    })

    test("matches with multiple patterns", async () => {
      const { Glob } = await import("../../src/util/glob")
      const globs = ["packages/frontend/**/*.tsx", "packages/frontend/**/*.ts"]
      const match = (filepath: string) => globs.some(g => Glob.match(g, filepath))

      expect(match("packages/frontend/App.tsx")).toBe(true)
      expect(match("packages/frontend/utils/helper.ts")).toBe(true)
      expect(match("packages/backend/server.ts")).toBe(false)
    })

    test("handles dot files", async () => {
      const { Glob } = await import("../../src/util/glob")
      expect(Glob.match("**/*.ts", ".hidden/config.ts")).toBe(true)
    })
  })

  describe("frontmatter stripping", () => {
    test("content excludes frontmatter", async () => {
      const tmpDir = await import("node:os").then(os => os.tmpdir())
      const tmpFile = `${tmpDir}/test-strip-${Date.now()}.md`
      const content = `---\nglobs: ["*.ts"]\n---\n# My Rule\n- Follow this`
      await Bun.write(tmpFile, content)

      const result = await ConfigMarkdown.parse(tmpFile)
      expect(result.content.trim()).toBe("# My Rule\n- Follow this")
      expect(result.content).not.toContain("---")
      expect(result.content).not.toContain("globs")

      await import("node:fs/promises").then(fs => fs.unlink(tmpFile))
    })
  })
})
