import { describe, expect, test } from "bun:test"
import * as fs from "fs/promises"
import path from "path"
import { Instruction } from "../../src/session/instruction"
import { Instance } from "../../src/project/instance"
import { tmpdir } from "../fixture/fixture"

describe("Instruction.systemPaths symlink containment", () => {
  test("symlink escaping rules directory is excluded", async () => {
    // Create a temp dir with a rules directory containing:
    // - normal.md (regular file, should be included)
    // - evil.md -> /etc/hosts (symlink escape, should be excluded)
    await using homeTmp = await tmpdir({
      init: async (dir) => {
        const rulesDir = path.join(dir, ".opencode", "rules")
        await fs.mkdir(rulesDir, { recursive: true })
        await Bun.write(path.join(rulesDir, "normal.md"), "# Normal Rules")

        // Create a symlink that escapes the rules directory
        try {
          await fs.symlink("/etc/hosts", path.join(rulesDir, "evil.md"))
        } catch {
          // If we can't create symlinks (permission issue), skip this part
        }
      },
    })
    await using projectTmp = await tmpdir()

    const originalHome = process.env.OPENCODE_TEST_HOME
    process.env.OPENCODE_TEST_HOME = homeTmp.path

    try {
      await Instance.provide({
        directory: projectTmp.path,
        fn: async () => {
          const paths = await Instruction.systemPaths()
          const allPaths = Array.from(paths)

          // Normal file should be included
          expect(allPaths.some((p) => p.endsWith("normal.md"))).toBe(true)

          // Symlink escape should be excluded
          expect(allPaths.some((p) => p.endsWith("evil.md"))).toBe(false)
        },
      })
    } finally {
      process.env.OPENCODE_TEST_HOME = originalHome
    }
  })

  test("symlink within rules directory is allowed", async () => {
    // A symlink that points to another file INSIDE the rules dir should be fine
    await using homeTmp = await tmpdir({
      init: async (dir) => {
        const rulesDir = path.join(dir, ".opencode", "rules")
        await fs.mkdir(rulesDir, { recursive: true })
        await Bun.write(path.join(rulesDir, "original.md"), "# Original Rules")

        try {
          await fs.symlink(
            path.join(rulesDir, "original.md"),
            path.join(rulesDir, "alias.md"),
          )
        } catch {
          // If symlinks not supported, test is meaningless
        }
      },
    })
    await using projectTmp = await tmpdir()

    const originalHome = process.env.OPENCODE_TEST_HOME
    process.env.OPENCODE_TEST_HOME = homeTmp.path

    try {
      await Instance.provide({
        directory: projectTmp.path,
        fn: async () => {
          const paths = await Instruction.systemPaths()
          const allPaths = Array.from(paths)

          // Both original and alias should be included (alias resolves within rules dir)
          expect(allPaths.some((p) => p.endsWith("original.md"))).toBe(true)
          expect(allPaths.some((p) => p.endsWith("alias.md"))).toBe(true)
        },
      })
    } finally {
      process.env.OPENCODE_TEST_HOME = originalHome
    }
  })

  test("broken symlink is skipped gracefully", async () => {
    await using homeTmp = await tmpdir({
      init: async (dir) => {
        const rulesDir = path.join(dir, ".opencode", "rules")
        await fs.mkdir(rulesDir, { recursive: true })
        await Bun.write(path.join(rulesDir, "valid.md"), "# Valid Rules")

        try {
          // Symlink to a non-existent target
          await fs.symlink("/nonexistent/path/to/nowhere.md", path.join(rulesDir, "broken.md"))
        } catch {
          // If symlinks not supported, test is meaningless
        }
      },
    })
    await using projectTmp = await tmpdir()

    const originalHome = process.env.OPENCODE_TEST_HOME
    process.env.OPENCODE_TEST_HOME = homeTmp.path

    try {
      await Instance.provide({
        directory: projectTmp.path,
        fn: async () => {
          // Should not throw
          const paths = await Instruction.systemPaths()
          const allPaths = Array.from(paths)

          // Valid file should be included
          expect(allPaths.some((p) => p.endsWith("valid.md"))).toBe(true)

          // Broken symlink should be excluded (realpath fails)
          expect(allPaths.some((p) => p.endsWith("broken.md"))).toBe(false)
        },
      })
    } finally {
      process.env.OPENCODE_TEST_HOME = originalHome
    }
  })

  test("project rules symlink escape is also blocked", async () => {
    await using homeTmp = await tmpdir()
    await using projectTmp = await tmpdir({
      init: async (dir) => {
        const rulesDir = path.join(dir, ".opencode", "rules")
        await fs.mkdir(rulesDir, { recursive: true })
        await Bun.write(path.join(rulesDir, "legit.md"), "# Legit Project Rules")

        try {
          await fs.symlink("/etc/passwd", path.join(rulesDir, "sneaky.md"))
        } catch {
          // If symlinks not supported
        }
      },
    })

    const originalHome = process.env.OPENCODE_TEST_HOME
    process.env.OPENCODE_TEST_HOME = homeTmp.path

    try {
      await Instance.provide({
        directory: projectTmp.path,
        fn: async () => {
          const paths = await Instruction.systemPaths()
          const allPaths = Array.from(paths)

          // Legit file should be included
          expect(allPaths.some((p) => p.endsWith("legit.md"))).toBe(true)

          // Symlink escape should be excluded
          expect(allPaths.some((p) => p.endsWith("sneaky.md"))).toBe(false)
        },
      })
    } finally {
      process.env.OPENCODE_TEST_HOME = originalHome
    }
  })
})
