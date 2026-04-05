import { describe, test, expect } from "bun:test"
import path from "path"
import fs from "fs/promises"
import { Instance } from "../../src/project/instance"
import { MemoryFile } from "../../src/memory/file"
import { tmpdir } from "../fixture/fixture"

describe("memory.file", () => {
  test("writeEntry and readEntry round-trip", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const entry = {
          filename: "test-entry.md",
          frontmatter: { topic: "test topic", type: "general" as const },
          content: "Some test content here.",
        }
        await MemoryFile.writeEntry(entry)
        const read = await MemoryFile.readEntry("test-entry.md")
        expect(read).toBeDefined()
        expect(read!.filename).toBe("test-entry.md")
        expect(read!.frontmatter.topic).toBe("test topic")
        expect(read!.frontmatter.type).toBe("general")
        expect(read!.content).toBe("Some test content here.")
      },
    })
  })

  test("readEntry returns undefined for non-existent file", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const read = await MemoryFile.readEntry("does-not-exist.md")
        expect(read).toBeUndefined()
      },
    })
  })

  test("writeIndex and readIndex round-trip", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const content = "# Memory Index\n- [Entry 1](entry1.md) — first entry\n- [Entry 2](entry2.md) — second entry"
        await MemoryFile.writeIndex(content)
        const read = await MemoryFile.readIndex()
        expect(read).toBe(content)
      },
    })
  })

  test("readIndex returns undefined when file does not exist", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const read = await MemoryFile.readIndex()
        expect(read).toBeUndefined()
      },
    })
  })

  test("readIndex truncates at maxLines", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const lines = Array.from({ length: 300 }, (_, i) => `Line ${i}`)
        await MemoryFile.writeIndex(lines.join("\n"))
        const read = await MemoryFile.readIndex(10)
        expect(read).toBeDefined()
        expect(read!.split("\n").length).toBe(10)
        expect(read!.startsWith("Line 0")).toBe(true)
      },
    })
  })

  test("path traversal is rejected", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await MemoryFile.writeIndex("# init")

        expect(() => MemoryFile.readEntry("../../etc/passwd")).toThrow("path traversal detected")
        expect(() =>
          MemoryFile.writeEntry({
            filename: "../../../etc/evil.md",
            frontmatter: { topic: "evil", type: "general" },
            content: "bad",
          }),
        ).toThrow("path traversal detected")
      },
    })
  })

  test("removeEntry deletes file", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const entry = {
          filename: "removable.md",
          frontmatter: { topic: "removable", type: "general" as const },
          content: "to be removed",
        }
        await MemoryFile.writeEntry(entry)
        const before = await MemoryFile.readEntry("removable.md")
        expect(before).toBeDefined()

        await MemoryFile.removeEntry("removable.md")
        const after = await MemoryFile.readEntry("removable.md")
        expect(after).toBeUndefined()
      },
    })
  })

  test("listEntries returns all markdown entries", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await MemoryFile.writeEntry({
          filename: "entry-a.md",
          frontmatter: { topic: "A", type: "general" },
          content: "content a",
        })
        await MemoryFile.writeEntry({
          filename: "entry-b.md",
          frontmatter: { topic: "B", type: "preference" },
          content: "content b",
        })
        await MemoryFile.writeIndex("# Index")

        const entries = await MemoryFile.listEntries()
        expect(entries.length).toBe(2)
        const topics = entries.map((e) => e.frontmatter.topic).sort()
        expect(topics).toEqual(["A", "B"])
      },
    })
  })

  test("writeEntry creates directory structure", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const dir = MemoryFile.getMemoryDir()
        const existsBefore = await fs
          .stat(dir)
          .then(() => true)
          .catch(() => false)
        expect(existsBefore).toBe(false)

        await MemoryFile.writeEntry({
          filename: "first.md",
          frontmatter: { topic: "first", type: "general" },
          content: "first entry",
        })

        const existsAfter = await fs
          .stat(dir)
          .then(() => true)
          .catch(() => false)
        expect(existsAfter).toBe(true)
      },
    })
  })

  test("readEntry returns undefined for file without valid frontmatter", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const dir = MemoryFile.getMemoryDir()
        await fs.mkdir(dir, { recursive: true })
        await Bun.write(path.join(dir, "bad.md"), "no frontmatter here")
        const read = await MemoryFile.readEntry("bad.md")
        expect(read).toBeUndefined()
      },
    })
  })
})
