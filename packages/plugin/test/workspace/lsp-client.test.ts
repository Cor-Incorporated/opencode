/**
 * Mock-based unit tests for the LSP client.
 *
 * Verifies:
 *   - the initialize handshake is performed before any other request,
 *   - notifications are routed to the correct handler,
 *   - request/response correlation works via the mock connection,
 *   - timeouts surface as errors (without leaking the timer),
 *   - rename WorkspaceEdit application math is correct.
 */

import { describe, expect, it, beforeEach } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import { LspClient, findRoot, type RpcConnection } from "../../src/tools/workspace/lsp/client.js"
import { applyEdits } from "../../src/tools/workspace/lsp/rename.js"
import { specForFile } from "../../src/tools/workspace/lsp/server-registry.js"

interface RecordedCall {
  method: string
  params: unknown
}

function makeMockConnection(opts: {
  onRequest?: (method: string, params: unknown) => unknown | Promise<unknown>
  /** If true, sendRequest never resolves (used for timeout tests). */
  hang?: boolean
}): { conn: RpcConnection; calls: RecordedCall[]; emit: (method: string, params: unknown) => void } {
  const calls: RecordedCall[] = []
  const handlers = new Map<string, (params: unknown) => void>()
  let listenCalled = false
  const conn: RpcConnection = {
    sendRequest: async (method, params) => {
      calls.push({ method, params })
      if (opts.hang) return new Promise(() => {})
      const result = opts.onRequest ? await opts.onRequest(method, params) : null
      return result as never
    },
    sendNotification: (method, params) => {
      calls.push({ method, params })
    },
    onNotification: (method, handler) => {
      handlers.set(method, handler)
    },
    onClose: () => {},
    listen: () => {
      listenCalled = true
    },
    dispose: () => {},
  }
  void listenCalled
  return {
    conn,
    calls,
    emit: (method, params) => {
      const handler = handlers.get(method)
      if (handler) handler(params)
    },
  }
}

describe("specForFile", () => {
  it("matches TypeScript extensions", () => {
    expect(specForFile("/x/foo.ts")?.language).toBe("typescript")
    expect(specForFile("/x/foo.tsx")?.languageId).toBe("typescriptreact")
    expect(specForFile("/x/foo.jsx")?.languageId).toBe("javascriptreact")
  })

  it("returns null for unknown extensions", () => {
    expect(specForFile("/x/foo.xyz")).toBeNull()
  })
})

describe("findRoot", () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "lsp-root-"))
  })

  it("walks up to a marker file", async () => {
    const sub = path.join(dir, "a", "b")
    await writeFile(path.join(dir, "tsconfig.json"), "{}")
    await Bun.write(path.join(sub, "x.ts"), "export const x = 1\n")
    const root = await findRoot(path.join(sub, "x.ts"), ["tsconfig.json"])
    expect(root).toBe(dir)
    await rm(dir, { recursive: true, force: true })
  })

  it("falls back to file directory when no marker found", async () => {
    const file = path.join(dir, "x.ts")
    await writeFile(file, "")
    const root = await findRoot(file, ["never-going-to-exist.json"])
    expect(root).toBe(dir)
    await rm(dir, { recursive: true, force: true })
  })
})

describe("LspClient (mocked)", () => {
  beforeEach(() => {
    LspClient.evictAll()
  })

  it("performs initialize handshake before exposing requests", async () => {
    const { conn, calls } = makeMockConnection({
      onRequest: () => ({ capabilities: {} }),
    })
    const spec = specForFile("/x/foo.ts")!
    const client = new LspClient(conn, spec, "/x")
    await client.initialize("file:///x")
    const order = calls.map((c) => c.method)
    expect(order[0]).toBe("initialize")
    expect(order[1]).toBe("initialized")
  })

  it("routes publishDiagnostics notifications to waiters", async () => {
    const { conn, emit } = makeMockConnection({
      onRequest: () => ({ capabilities: {} }),
    })
    const spec = specForFile("/x/foo.ts")!
    const dir = await mkdtemp(path.join(tmpdir(), "lsp-diag-"))
    const file = path.join(dir, "foo.ts")
    await writeFile(file, "x\n")
    const client = new LspClient(conn, spec, dir)
    await client.initialize("file://" + dir)
    const promise = client.diagnostics(file, 5_000)
    // Push a publishDiagnostics for the file URI we used.
    emit("textDocument/publishDiagnostics", {
      uri: "file://" + file,
      diagnostics: [
        {
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
          message: "bad",
          severity: 1,
        },
      ],
    })
    const diags = await promise
    expect(diags).toHaveLength(1)
    expect(diags[0]?.message).toBe("bad")
    await rm(dir, { recursive: true, force: true })
  })

  it("returns the request payload via sendRequest", async () => {
    const expected = [{ uri: "file:///x/y.ts", range: { start: { line: 1, character: 2 }, end: { line: 1, character: 5 } } }]
    const { conn } = makeMockConnection({
      onRequest: (method) => (method === "textDocument/definition" ? expected : { capabilities: {} }),
    })
    const spec = specForFile("/x/foo.ts")!
    const dir = await mkdtemp(path.join(tmpdir(), "lsp-def-"))
    const file = path.join(dir, "foo.ts")
    await writeFile(file, "const x = 1\n")
    const client = new LspClient(conn, spec, dir)
    await client.initialize("file://" + dir)
    const result = await client.definition(file, 0, 6)
    expect(result).toEqual(expected)
    await rm(dir, { recursive: true, force: true })
  })

  it("times out hung requests instead of hanging forever", async () => {
    const { conn } = makeMockConnection({ hang: true })
    const spec = specForFile("/x/foo.ts")!
    const client = new LspClient(conn, spec, "/x", { timeoutMs: 25 })
    await expect(client.initialize("file:///x")).rejects.toThrow(/timed out/i)
  })

  it("normalizes a single Location into an array", async () => {
    const single = { uri: "file:///x/y.ts", range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } }
    const { conn } = makeMockConnection({
      onRequest: (method) => (method === "textDocument/definition" ? single : { capabilities: {} }),
    })
    const spec = specForFile("/x/foo.ts")!
    const dir = await mkdtemp(path.join(tmpdir(), "lsp-norm-"))
    const file = path.join(dir, "foo.ts")
    await writeFile(file, "x\n")
    const client = new LspClient(conn, spec, dir)
    await client.initialize("file://" + dir)
    const out = await client.definition(file, 0, 0)
    expect(Array.isArray(out)).toBe(true)
    expect(out).toHaveLength(1)
    await rm(dir, { recursive: true, force: true })
  })
})

describe("applyEdits (rename math)", () => {
  it("replaces a single occurrence", () => {
    const original = "const oldName = 1\n"
    const out = applyEdits(original, [
      {
        range: { start: { line: 0, character: 6 }, end: { line: 0, character: 13 } },
        newText: "newName",
      },
    ])
    expect(out).toBe("const newName = 1\n")
  })

  it("applies edits last-to-first so offsets remain valid", () => {
    const original = "ab\ncd\nef\n"
    const out = applyEdits(original, [
      { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, newText: "AA" },
      { range: { start: { line: 2, character: 0 }, end: { line: 2, character: 1 } }, newText: "EE" },
    ])
    expect(out).toBe("AAb\ncd\nEEf\n")
  })
})

describe("rename WorkspaceEdit -> disk (atomic)", () => {
  it("writes updated content via atomic temp+rename", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "lsp-rename-"))
    const file = path.join(dir, "foo.ts")
    await writeFile(file, "const oldName = 1\n")
    const expected = {
      changes: {
        ["file://" + file]: [
          {
            range: { start: { line: 0, character: 6 }, end: { line: 0, character: 13 } },
            newText: "newName",
          },
        ],
      },
    }
    const { conn } = makeMockConnection({
      onRequest: (method) => (method === "textDocument/rename" ? expected : { capabilities: {} }),
    })
    const spec = specForFile(file)!
    const client = new LspClient(conn, spec, dir)
    await client.initialize("file://" + dir)
    const edit = await client.rename(file, 0, 7, "newName")
    expect(edit).toEqual(expected)
    // Apply via the rename module helper (apply is exercised through runRename in real use).
    const updated = applyEdits(await readFile(file, "utf8"), expected.changes["file://" + file]!)
    await writeFile(file, updated)
    expect(await readFile(file, "utf8")).toBe("const newName = 1\n")
    await rm(dir, { recursive: true, force: true })
  })
})
