import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { Effect } from "effect"

import { ANCHOR_CONTENT_SEPARATOR, formatAnchor } from "../anchor.js"
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

  // Regression: PR-A review HIGH — overlapping same-line edits silently
  // corrupted the file because both anchors validated against the original
  // file. The exact case: replace [2..3] + delete [3..4] both touch line 3,
  // and the reverse-line apply ran the delete first (shrinking the buffer)
  // so the replace clobbered the wrong lines. We must reject the batch.
  test("rejects overlapping replace+delete on the same line and leaves file untouched", async () => {
    const lines = ["one", "two", "three", "four", "five"]
    const path = await writeFile("a.txt", lines.join("\n") + "\n")
    const before = await readFile(path)

    const result = await executeHashlineEdits({
      filePath: path,
      edits: [
        {
          op: "replace",
          pos: anchor(2, "two"),
          end: anchor(3, "three"),
          lines: ["X"],
        },
        {
          op: "delete",
          pos: anchor(3, "three"),
          end: anchor(4, "four"),
        },
      ],
    })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toContain("overlap")
      expect(result.error).toContain("disjoint")
    }
    // File must be entirely untouched.
    expect(await readFile(path)).toBe(before)
  })

  test("rejects two replaces that share even a single line", async () => {
    const lines = ["a", "b", "c", "d"]
    const path = await writeFile("a.txt", lines.join("\n") + "\n")
    const before = await readFile(path)

    const result = await executeHashlineEdits({
      filePath: path,
      edits: [
        { op: "replace", pos: anchor(1, "a"), end: anchor(2, "b"), lines: ["A"] },
        { op: "replace", pos: anchor(2, "b"), end: anchor(3, "c"), lines: ["B"] },
      ],
    })

    expect(result.ok).toBe(false)
    expect(await readFile(path)).toBe(before)
  })

  test("rejects two appends at the same line (ambiguous order)", async () => {
    const path = await writeFile("a.txt", "a\nb\n")
    const before = await readFile(path)

    const result = await executeHashlineEdits({
      filePath: path,
      edits: [
        { op: "append", pos: anchor(1, "a"), lines: ["x"] },
        { op: "append", pos: anchor(1, "a"), lines: ["y"] },
      ],
    })

    expect(result.ok).toBe(false)
    expect(await readFile(path)).toBe(before)
  })

  test("allows non-overlapping edits at adjacent lines", async () => {
    const path = await writeFile("a.txt", "a\nb\nc\nd\n")
    const result = await executeHashlineEdits({
      filePath: path,
      edits: [
        { op: "replace", pos: anchor(1, "a"), lines: ["A"] },
        { op: "replace", pos: anchor(2, "b"), lines: ["B"] },
        { op: "delete", pos: anchor(3, "c") },
        { op: "append", pos: anchor(4, "d"), lines: ["E"] },
      ],
    })
    expect(result.ok).toBe(true)
    expect(await readFile(path)).toBe("A\nB\nd\nE\n")
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

  // Regression: PR-A review CRITICAL — silent data loss when the rename
  // target already exists. The tool must refuse, leaving BOTH files intact.
  test("refuses to overwrite an existing file at the rename target", async () => {
    const srcPath = await writeFile("src.txt", "one\ntwo\n")
    const dstPath = await writeFile("dst.txt", "EXISTING DESTINATION CONTENT\n")
    const dstBefore = await readFile(dstPath)
    const srcBefore = await readFile(srcPath)

    const result = await executeHashlineEdits({
      filePath: srcPath,
      rename: dstPath,
      edits: [{ op: "replace", pos: anchor(1, "one"), lines: ["ONE"] }],
    })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toContain("target file already exists")
      expect(result.error).toContain(dstPath)
    }
    // Both files must be untouched.
    expect(await readFile(dstPath)).toBe(dstBefore)
    expect(await readFile(srcPath)).toBe(srcBefore)
  })

  test("rename to the same path as filePath is allowed (no-op move)", async () => {
    const path = await writeFile("a.txt", "one\ntwo\n")
    const result = await executeHashlineEdits({
      filePath: path,
      rename: path,
      edits: [{ op: "replace", pos: anchor(1, "one"), lines: ["ONE"] }],
    })
    expect(result.ok).toBe(true)
    expect(await readFile(path)).toBe("ONE\ntwo\n")
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

  // Regression: PR-A review MEDIUM — pre-existing zero-byte file used to
  // reject the same line-1 edit a createIfMissing flow accepted, because
  // the synthetic empty-line buffer was only constructed when the file
  // was newly created. Now both code paths share the synthesis.
  test("accepts a line-1 replace against a pre-existing zero-byte file", async () => {
    const path = await writeFile("empty.txt", "")
    const result = await executeHashlineEdits({
      filePath: path,
      edits: [{ op: "replace", pos: `1#${hashLine("")}`, lines: ["hello", "world"] }],
    })
    expect(result.ok).toBe(true)
    // Pre-existing file had no trailing newline, so the result also has none.
    // The fix only restores parity with the createIfMissing flow at the
    // VALIDATION layer — line-1 edit no longer wrongly rejected.
    expect(await readFile(path)).toBe("hello\nworld")
  })
})

describe("executeHashlineEdits — programmer errors are returned as values", () => {
  test("returns ok:false when filePath is missing (no throw)", async () => {
    // @ts-expect-error — testing runtime guard
    const result = await executeHashlineEdits({ edits: [] })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain("filePath is required")
  })

  test("returns ok:false when edits is not an array (no throw)", async () => {
    // @ts-expect-error — testing runtime guard
    const result = await executeHashlineEdits({ filePath: "/tmp/x", edits: "nope" })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain("edits must be an array")
  })

  test("returns ok:false when args is null", async () => {
    // @ts-expect-error — testing runtime guard
    const result = await executeHashlineEdits(null)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain("args must be an object")
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
  test("returns lines annotated with LINE#ID<RS>content", async () => {
    const path = await writeFile("a.txt", "alpha\nbeta\ngamma\n")
    const annotated = await readWithAnchors(path)
    expect(annotated).not.toBeNull()
    expect(annotated).toEqual([
      `${anchor(1, "alpha")}${ANCHOR_CONTENT_SEPARATOR}alpha`,
      `${anchor(2, "beta")}${ANCHOR_CONTENT_SEPARATOR}beta`,
      `${anchor(3, "gamma")}${ANCHOR_CONTENT_SEPARATOR}gamma`,
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
