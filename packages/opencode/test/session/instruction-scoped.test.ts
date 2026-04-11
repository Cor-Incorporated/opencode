import { afterEach, describe, expect, test } from "bun:test"
import path from "path"
import { ConfigMarkdown } from "../../src/config/markdown"
import { Instruction } from "../../src/session/instruction"
import { Instance } from "../../src/project/instance"
import { MessageID } from "../../src/session/schema"
import { tmpdir } from "../fixture/fixture"

afterEach(async () => {
  await Instance.disposeAll()
})

describe("Path-Scoped Rules", () => {
  describe("frontmatter parsing", () => {
    test("parses globs from frontmatter", async () => {
      await using tmp = await tmpdir({
        init: async (dir) => {
          await Bun.write(
            path.join(dir, "test-rule.md"),
            "---\nglobs: [\"src/**/*.ts\"]\ndescription: Test rule\n---\n# Test Rule\n- Do something",
          )
        },
      })

      const result = await ConfigMarkdown.parse(path.join(tmp.path, "test-rule.md"))
      expect(result.data.globs).toEqual(["src/**/*.ts"])
      expect(result.data.description).toBe("Test rule")
      expect(result.content.trim()).toBe("# Test Rule\n- Do something")
    })

    test("parses single glob string", async () => {
      await using tmp = await tmpdir({
        init: async (dir) => {
          await Bun.write(
            path.join(dir, "test-rule-single.md"),
            "---\nglobs: \"*.tsx\"\n---\n# TSX Rule",
          )
        },
      })

      const result = await ConfigMarkdown.parse(path.join(tmp.path, "test-rule-single.md"))
      expect(result.data.globs).toBe("*.tsx")
    })

    test("rule without globs has no globs field", async () => {
      await using tmp = await tmpdir({
        init: async (dir) => {
          await Bun.write(
            path.join(dir, "test-rule-noglob.md"),
            "# Always Active Rule\n- Apply everywhere",
          )
        },
      })

      const result = await ConfigMarkdown.parse(path.join(tmp.path, "test-rule-noglob.md"))
      expect(result.data.globs).toBeUndefined()
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
      const match = (filepath: string) => globs.some((g) => Glob.match(g, filepath))

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
      await using tmp = await tmpdir({
        init: async (dir) => {
          await Bun.write(
            path.join(dir, "test-strip.md"),
            "---\nglobs: [\"*.ts\"]\n---\n# My Rule\n- Follow this",
          )
        },
      })

      const result = await ConfigMarkdown.parse(path.join(tmp.path, "test-strip.md"))
      expect(result.content.trim()).toBe("# My Rule\n- Follow this")
    })
  })

  describe("Instruction.resolve with glob-scoped rules", () => {
    test("injects glob-scoped rule only when target matches", async () => {
      await using tmp = await tmpdir({
        git: true,
        init: async (dir) => {
          const rulesDir = path.join(dir, ".opencode", "rules")
          await Bun.write(
            path.join(rulesDir, "ts-style.md"),
            "---\nglobs:\n  - \"src/**/*.ts\"\n---\nUse strict mode",
          )
          await Bun.write(path.join(dir, "src", "app.ts"), "const x = 1")
          await Bun.write(path.join(dir, "readme.md"), "# Docs")
        },
      })

      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          // Matching file: should include the glob-scoped rule
          const match = await Instruction.resolve(
            [],
            path.join(tmp.path, "src", "app.ts"),
            MessageID.make("msg-glob-match"),
          )
          const tsRule = match.find((r) => r.content.includes("Use strict mode"))
          expect(tsRule).toBeDefined()

          // Non-matching file: should NOT include the glob-scoped rule
          const noMatch = await Instruction.resolve(
            [],
            path.join(tmp.path, "readme.md"),
            MessageID.make("msg-glob-nomatch"),
          )
          const noRule = noMatch.find((r) => r.content.includes("Use strict mode"))
          expect(noRule).toBeUndefined()
        },
      })
    })
  })
})
