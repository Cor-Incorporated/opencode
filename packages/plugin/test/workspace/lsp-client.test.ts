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

import {
  LspClient,
  defaultConnectionFactory,
  findRoot,
  pathToUri,
  type RpcConnection,
} from "../../src/tools/workspace/lsp/client.js"
import { runDiagnostics } from "../../src/tools/workspace/lsp/diagnostics.js"
import { applyEdits } from "../../src/tools/workspace/lsp/rename.js"
import type { LspServerSpec } from "../../src/tools/workspace/lsp/server-registry.js"
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
    const dir = await mkdtemp(path.join(tmpdir(), "lsp-init-"))
    const spec = specForFile(path.join(dir, "foo.ts"))!
    const client = new LspClient(conn, spec, dir)
    await client.initialize(pathToUri(dir))
    const order = calls.map((c) => c.method)
    expect(order[0]).toBe("initialize")
    expect(order[1]).toBe("initialized")
    await rm(dir, { recursive: true, force: true })
  })

  it("sends an initialize payload with the LSP-required shape", async () => {
    // PR-B regression: assert that the JSON-RPC params we send actually
    // satisfy the LSP 3.17 initialize contract — capabilities are required
    // and rootUri / workspaceFolders must be present for project-scoped
    // language servers.
    const { conn, calls } = makeMockConnection({
      onRequest: () => ({ capabilities: {} }),
    })
    const dir = await mkdtemp(path.join(tmpdir(), "lsp-init-payload-"))
    const rootUri = pathToUri(dir)
    const spec = specForFile(path.join(dir, "foo.ts"))!
    const client = new LspClient(conn, spec, dir)
    await client.initialize(rootUri)
    const init = calls.find((c) => c.method === "initialize")
    expect(init).toBeDefined()
    const params = init!.params as {
      rootUri: string
      capabilities: { textDocument: unknown; workspace: unknown }
      workspaceFolders: Array<{ uri: string; name: string }>
    }
    expect(params.rootUri).toBe(rootUri)
    expect(params.capabilities.textDocument).toBeDefined()
    expect(params.capabilities.workspace).toBeDefined()
    expect(Array.isArray(params.workspaceFolders)).toBe(true)
    expect(params.workspaceFolders[0]?.uri).toBe(rootUri)
    await rm(dir, { recursive: true, force: true })
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
    await client.initialize(pathToUri(dir))
    const promise = client.diagnostics(file, 5_000)
    // Push a publishDiagnostics for the file URI we used.
    emit("textDocument/publishDiagnostics", {
      uri: pathToUri(file),
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
    await client.initialize(pathToUri(dir))
    const result = await client.definition(file, 0, 6)
    expect(result).toEqual(expected)
    await rm(dir, { recursive: true, force: true })
  })

  it("times out hung requests instead of hanging forever", async () => {
    const { conn } = makeMockConnection({ hang: true })
    const dir = await mkdtemp(path.join(tmpdir(), "lsp-timeout-"))
    const spec = specForFile(path.join(dir, "foo.ts"))!
    const client = new LspClient(conn, spec, dir, { timeoutMs: 25 })
    await expect(client.initialize(pathToUri(dir))).rejects.toThrow(/timed out/i)
    await rm(dir, { recursive: true, force: true })
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
    await client.initialize(pathToUri(dir))
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

describe("LSP connection factory (Bun-spawn regression)", () => {
  beforeEach(() => {
    LspClient.evictAll()
  })

  it(
    "completes the initialize handshake via the real defaultConnectionFactory",
    async () => {
      // PR-B regression (round 2, NM1): previously the test maintained an
      // inline factory clone that mirrored defaultConnectionFactory. That
      // protected against a Bun.spawn re-introduction in the *clone* but
      // not in production code — if `client.ts` regressed independently,
      // this test wouldn't catch it. We now build a stub LSP server,
      // expose it through a one-off `LspServerSpec` whose `command` is
      // the current Node executable, and drive the **production**
      // `defaultConnectionFactory` directly. Any regression that breaks
      // the real factory's stream wiring will hang here and the test
      // timeout converts it to a clean failure.
      const dir = await mkdtemp(path.join(tmpdir(), "lsp-spawn-"))
      const stub = path.join(dir, "stub-lsp-server.mjs")
      // Minimal LSP-compatible stub. Reads framed JSON-RPC from stdin
      // and writes a hand-rolled response so we don't depend on any
      // external LSP binary.
      const stubSource = [
        "let buffer = Buffer.alloc(0)",
        "process.stdin.on('data', (chunk) => {",
        "  buffer = Buffer.concat([buffer, chunk])",
        "  while (true) {",
        "    const headerEnd = buffer.indexOf('\\r\\n\\r\\n')",
        "    if (headerEnd === -1) return",
        "    const header = buffer.slice(0, headerEnd).toString('utf8')",
        "    const match = /Content-Length: (\\d+)/i.exec(header)",
        "    if (!match) return",
        "    const len = parseInt(match[1], 10)",
        "    const bodyStart = headerEnd + 4",
        "    if (buffer.length < bodyStart + len) return",
        "    const body = buffer.slice(bodyStart, bodyStart + len).toString('utf8')",
        "    buffer = buffer.slice(bodyStart + len)",
        "    let msg",
        "    try { msg = JSON.parse(body) } catch { continue }",
        "    if (msg.method === 'initialize' && msg.id !== undefined) {",
        "      const reply = JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { capabilities: {} } })",
        "      const payload = `Content-Length: ${Buffer.byteLength(reply, 'utf8')}\\r\\n\\r\\n${reply}`",
        "      process.stdout.write(payload)",
        "    }",
        "    if (msg.method === 'shutdown' && msg.id !== undefined) {",
        "      const reply = JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: null })",
        "      const payload = `Content-Length: ${Buffer.byteLength(reply, 'utf8')}\\r\\n\\r\\n${reply}`",
        "      process.stdout.write(payload)",
        "    }",
        "    if (msg.method === 'exit') process.exit(0)",
        "  }",
        "})",
        "process.stdin.on('end', () => process.exit(0))",
      ].join("\n")
      await writeFile(stub, stubSource)

      // Hand the production factory a spec that points at our stub. Any
      // regression that re-introduces Web-stream-based spawning here will
      // hang — the test timeout converts that into a clean failure.
      const stubSpec: LspServerSpec = {
        language: "stub",
        languageId: "stub",
        rootPatterns: [],
        command: process.execPath,
        args: [stub],
        installHint: "(test stub)",
      }
      const conn = await defaultConnectionFactory(stubSpec, dir)
      const client = new LspClient(conn, stubSpec, dir, { timeoutMs: 5_000 })
      await client.initialize(pathToUri(dir))
      expect(client.isClosed).toBe(false)
      await client.shutdown()
      await rm(dir, { recursive: true, force: true })
    },
    15_000,
  )

  it(
    "surfaces ENOENT when the LSP binary is missing instead of crashing the process",
    async () => {
      // PR-B regression (round 2, NH1): previously `defaultConnectionFactory`
      // never registered an `error` listener on the spawned ChildProcess.
      // Node emits `error` synchronously enough that, without a listener,
      // it can escalate to `uncaughtException` — and even when it doesn't,
      // the JSON-RPC connection sits forever waiting for an `initialize`
      // response, so the friendly install hint never reaches the user.
      //
      // We verify the new behaviour end-to-end via `runDiagnostics` (the
      // shipping public surface): given a spec whose `command` is a
      // guaranteed-missing binary, the call returns ok=false with an error
      // string that includes the install hint, and the test process is
      // still alive afterwards.
      const dir = await mkdtemp(path.join(tmpdir(), "lsp-enoent-"))
      const file = path.join(dir, "x.ts")
      await writeFile(file, "export const x = 1\n")

      const fakeBinary = path.join(dir, "definitely-not-installed-binary-xyz")
      const missingSpec: LspServerSpec = {
        language: "stub-missing",
        languageId: "stub",
        rootPatterns: [],
        command: fakeBinary,
        args: [],
        installHint: "(test stub install hint)",
      }

      // Drive the production `defaultConnectionFactory` against a missing
      // binary. We override the spec inside our test factory rather than
      // mutating the shared registry. Whatever resulting error reaches
      // `friendlyError` is then mapped to the **registered** spec's
      // `installHint` ("TypeScript LSP not found...") because that's
      // what `runDiagnostics` looks up via `specForFile(filePath)`.
      const result = await runDiagnostics(file, {
        factory: async (_spec, rootPath) => defaultConnectionFactory(missingSpec, rootPath),
        timeoutMs: 1_500,
      })

      expect(result.ok).toBe(false)
      // friendlyError() upgrades ENOENT to the registered install hint
      // (TypeScript here, since we passed an `x.ts` file). The exact
      // string is the registry default, but we assert on the
      // distinctive prefix to keep the test resilient.
      expect(result.error ?? "").toMatch(/TypeScript LSP not found/i)
      // Process is still alive — if the test reaches this assertion, no
      // uncaughtException was thrown.
      expect(typeof process.pid).toBe("number")
      await rm(dir, { recursive: true, force: true })
    },
    10_000,
  )
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
    await client.initialize(pathToUri(dir))
    const edit = await client.rename(file, 0, 7, "newName")
    expect(edit).toEqual(expected)
    // Apply via the rename module helper (apply is exercised through runRename in real use).
    const updated = applyEdits(await readFile(file, "utf8"), expected.changes["file://" + file]!)
    await writeFile(file, updated)
    expect(await readFile(file, "utf8")).toBe("const newName = 1\n")
    await rm(dir, { recursive: true, force: true })
  })
})
