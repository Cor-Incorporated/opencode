import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { Effect } from "effect"

import { formatAnchor } from "../anchor.js"
import { executeHashlineEdits } from "../edit.js"
import { hashLine } from "../hash.js"
import { createHashlineTool, readWithAnchors } from "../index.js"

let workDir: string

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "hashline-edit-"))
})

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true })
})

async function writeFile(name: string, contents: string): Promise<string> {
  const path = join(workDir, name)
  await Bun.write(path, contents)
  return path
}

async function readFile(path: string): Promise<string> {
  return await Bun.file(path).text()
}

function anchor(line: number, content: string): string {
  return formatAnchor(line, content)
}

describe("executeHashlineEdits — single-line replace", () => {
  test("succeeds with a valid anchor", async () => {
    const lines = ["one", "two", "three"]
    const path = await writeFile("a.txt", lines.join("\n") + "\n")

    const result = await executeHashlineEdits({
      filePath: path,
      edits: [{ op: "replace", pos: anchor(2, "two"), lines: ["TWO"] }],
    })

    expect(result.ok).toBe(true)
    expect(await readFile(path)).toBe("one\nTWO\nthree\n")
  })

  test("rejects a stale anchor and leaves the file unchanged", async () => {
    const lines = ["one", "two", "three"]
    const path = await writeFile("a.txt", lines.join("\n") + "\n")

    // Anchor with line 2 but the wrong hash (hash of "different content").
    const staleAnchor = `2#${hashLine("different content")}`
    const result = await executeHashlineEdits({
      filePath: path,
      edits: [{ op: "replace", pos: staleAnchor, lines: ["TWO"] }],
    })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toContain("Stale anchor")
      expect(result.error).toContain("Re-read the file")
    }
    // File untouched.
    expect(await readFile(path)).toBe("one\ntwo\nthree\n")
  })

  test("rejects a malformed anchor", async () => {
    const path = await writeFile("a.txt", "x\n")
    const result = await executeHashlineEdits({
      filePath: path,
      edits: [{ op: "replace", pos: "not-an-anchor", lines: ["X"] }],
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain("Malformed anchor")
  })

  test("rejects an out-of-range line", async () => {
    const path = await writeFile("a.txt", "x\n")
    const phantom = anchor(99, "x")
    const result = await executeHashlineEdits({
      filePath: path,
      edits: [{ op: "replace", pos: phantom, lines: ["Y"] }],
    })
    expect(result.ok).toBe(false)
  })
})

describe("executeHashlineEdits — multi-line range replace", () => {
  test("replaces an inclusive range with new lines", async () => {
    const lines = ["one", "two", "three", "four", "five"]
    const path = await writeFile("a.txt", lines.join("\n") + "\n")

    const result = await executeHashlineEdits({
      filePath: path,
      edits: [
        {
          op: "replace",
          pos: anchor(2, "two"),
          end: anchor(4, "four"),
          lines: ["X", "Y"],
        },
      ],
    })

    expect(result.ok).toBe(true)
    expect(await readFile(path)).toBe("one\nX\nY\nfive\n")
  })

  test("rejects when end < start", async () => {
    const lines = ["one", "two", "three"]
    const path = await writeFile("a.txt", lines.join("\n") + "\n")
    const result = await executeHashlineEdits({
      filePath: path,
      edits: [
        {
          op: "replace",
          pos: anchor(3, "three"),
          end: anchor(1, "one"),
          lines: ["X"],
        },
      ],
    })
    expect(result.ok).toBe(false)
  })
})

describe("executeHashlineEdits — append/prepend/delete", () => {
  test("append inserts after pos", async () => {
    const lines = ["one", "two", "three"]
    const path = await writeFile("a.txt", lines.join("\n") + "\n")
    const result = await executeHashlineEdits({
      filePath: path,
      edits: [{ op: "append", pos: anchor(2, "two"), lines: ["after-two-1", "after-two-2"] }],
    })
    expect(result.ok).toBe(true)
    expect(await readFile(path)).toBe("one\ntwo\nafter-two-1\nafter-two-2\nthree\n")
  })

  test("prepend inserts before pos", async () => {
    const lines = ["one", "two", "three"]
    const path = await writeFile("a.txt", lines.join("\n") + "\n")
    const result = await executeHashlineEdits({
      filePath: path,
      edits: [{ op: "prepend", pos: anchor(2, "two"), lines: ["before-two"] }],
    })
    expect(result.ok).toBe(true)
    expect(await readFile(path)).toBe("one\nbefore-two\ntwo\nthree\n")
  })

  test("delete removes the inclusive range", async () => {
    const lines = ["one", "two", "three", "four"]
    const path = await writeFile("a.txt", lines.join("\n") + "\n")
    const result = await executeHashlineEdits({
      filePath: path,
      edits: [{ op: "delete", pos: anchor(2, "two"), end: anchor(3, "three") }],
    })
    expect(result.ok).toBe(true)
    expect(await readFile(path)).toBe("one\nfour\n")
  })

  test("delete with no end removes a single line", async () => {
    const lines = ["one", "two", "three"]
    const path = await writeFile("a.txt", lines.join("\n") + "\n")
    const result = await executeHashlineEdits({
      filePath: path,
      edits: [{ op: "delete", pos: anchor(2, "two") }],
    })
    expect(result.ok).toBe(true)
    expect(await readFile(path)).toBe("one\nthree\n")
  })
})

describe("executeHashlineEdits — multi-edit batches and atomicity", () => {
  test("multiple edits all reference the original line numbers", async () => {
    const lines = ["one", "two", "three", "four", "five"]
    const path = await writeFile("a.txt", lines.join("\n") + "\n")

    // Replace line 5 with "FIVE", insert before line 1, delete line 3.
    // Anchors all use the ORIGINAL file content.
    const result = await executeHashlineEdits({
      filePath: path,
      edits: [
        { op: "replace", pos: anchor(5, "five"), lines: ["FIVE"] },
        { op: "prepend", pos: anchor(1, "one"), lines: ["ZERO"] },
        { op: "delete", pos: anchor(3, "three") },
      ],
    })

    expect(result.ok).toBe(true)
    expect(await readFile(path)).toBe("ZERO\none\ntwo\nfour\nFIVE\n")
  })

  test("atomicity: if any anchor is stale, NO edits apply", async () => {
    const lines = ["one", "two", "three"]
    const path = await writeFile("a.txt", lines.join("\n") + "\n")
    const before = await readFile(path)

    const staleAnchor = `2#${hashLine("nope")}`
    const result = await executeHashlineEdits({
      filePath: path,
      edits: [
        { op: "replace", pos: anchor(1, "one"), lines: ["ONE"] }, // valid
        { op: "replace", pos: staleAnchor, lines: ["TWO"] }, // invalid
        { op: "replace", pos: anchor(3, "three"), lines: ["THREE"] }, // valid
      ],
    })

    expect(result.ok).toBe(false)
    expect(await readFile(path)).toBe(before)
  })
})

describe("executeHashlineEdits — rename", () => {
  test("renames the file and applies edits to the new path", async () => {
    const path = await writeFile("a.txt", "one\ntwo\n")
    const newPath = join(workDir, "renamed.txt")

    const result = await executeHashlineEdits({
      filePath: path,
      rename: newPath,
      edits: [{ op: "replace", pos: anchor(1, "one"), lines: ["ONE"] }],
    })

    expect(result.ok).toBe(true)
    expect(await Bun.file(path).exists()).toBe(false)
    expect(await readFile(newPath)).toBe("ONE\ntwo\n")
  })

  test("rejects empty rename string", async () => {
    const path = await writeFile("a.txt", "one\n")
    const result = await executeHashlineEdits({
      filePath: path,
      rename: "",
      edits: [],
    })
    expect(result.ok).toBe(false)
  })
})

describe("executeHashlineEdits — createIfMissing", () => {
  test("creates an empty file when edits is empty", async () => {
    const path = join(workDir, "new.txt")
    const result = await executeHashlineEdits({
      filePath: path,
      edits: [],
      createIfMissing: true,
    })
    expect(result.ok).toBe(true)
    expect(await Bun.file(path).exists()).toBe(true)
  })

  test("creates a file via single replace from the empty-line anchor", async () => {
    const path = join(workDir, "new.txt")
    const emptyAnchor = `1#${hashLine("")}`
    const result = await executeHashlineEdits({
      filePath: path,
      edits: [{ op: "replace", pos: emptyAnchor, lines: ["hello", "world"] }],
      createIfMissing: true,
    })
    expect(result.ok).toBe(true)
    expect(await readFile(path)).toBe("hello\nworld\n")
  })

  test("rejects non-existent file without createIfMissing", async () => {
    const path = join(workDir, "missing.txt")
    const result = await executeHashlineEdits({
      filePath: path,
      edits: [{ op: "replace", pos: `1#${hashLine("")}`, lines: ["x"] }],
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain("does not exist")
  })

  test("rejects createIfMissing with wrong anchor or multi-edit", async () => {
    const path = join(workDir, "missing.txt")
    const result = await executeHashlineEdits({
      filePath: path,
      edits: [{ op: "replace", pos: `2#${hashLine("")}`, lines: ["x"] }],
      createIfMissing: true,
    })
    expect(result.ok).toBe(false)
  })
})

describe("executeHashlineEdits — programmer errors", () => {
  test("throws when filePath is missing", async () => {
    await expect(
      // @ts-expect-error — testing runtime guard
      executeHashlineEdits({ edits: [] }),
    ).rejects.toThrow()
  })

  test("throws when edits is not an array", async () => {
    await expect(
      // @ts-expect-error — testing runtime guard
      executeHashlineEdits({ filePath: "/tmp/x", edits: "nope" }),
    ).rejects.toThrow()
  })
})

describe("createHashlineTool", () => {
  function makeContext(directory: string) {
    return {
      sessionID: "test-session",
      messageID: "test-message",
      agent: "test-agent",
      directory,
      worktree: directory,
      abort: new AbortController().signal,
      metadata: () => undefined,
      ask: () => Effect.void,
    }
  }

  test("returns a tool definition with the expected metadata", () => {
    const def = createHashlineTool()
    expect(typeof def.description).toBe("string")
    expect(def.description.length).toBeGreaterThan(20)
    expect(typeof def.execute).toBe("function")
    expect(typeof def.args).toBe("object")
    expect(def.args).toHaveProperty("filePath")
    expect(def.args).toHaveProperty("edits")
  })

  test("execute() returns the success summary on a valid edit", async () => {
    const def = createHashlineTool()
    const path = await writeFile("ok.txt", "alpha\nbeta\n")
    const result = (await def.execute(
      {
        filePath: path,
        edits: [{ op: "replace", pos: anchor(1, "alpha"), lines: ["ALPHA"] }],
      },
      makeContext(workDir),
    )) as { output: string }
    expect(result.output).toContain("hashline_edit edited")
    expect(await readFile(path)).toBe("ALPHA\nbeta\n")
  })

  test("execute() returns the error string on a stale anchor", async () => {
    const def = createHashlineTool()
    const path = await writeFile("stale.txt", "alpha\nbeta\n")
    const result = (await def.execute(
      {
        filePath: path,
        edits: [{ op: "replace", pos: `1#${hashLine("nope")}`, lines: ["X"] }],
      },
      makeContext(workDir),
    )) as { output: string }
    expect(result.output).toContain("Stale anchor")
  })
})

describe("readWithAnchors", () => {
  test("returns lines annotated with LINE#ID|content", async () => {
    const path = await writeFile("a.txt", "alpha\nbeta\ngamma\n")
    const annotated = await readWithAnchors(path)
    expect(annotated).not.toBeNull()
    expect(annotated).toEqual([
      `${anchor(1, "alpha")}|alpha`,
      `${anchor(2, "beta")}|beta`,
      `${anchor(3, "gamma")}|gamma`,
    ])
  })

  test("returns null for missing files", async () => {
    const result = await readWithAnchors(join(workDir, "ghost.txt"))
    expect(result).toBeNull()
  })

  test("returns empty array for empty files", async () => {
    const path = await writeFile("empty.txt", "")
    const result = await readWithAnchors(path)
    expect(result).toEqual([])
  })
})
