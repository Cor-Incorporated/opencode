/**
 * Long-lived JSON-RPC client for a single LSP server process.
 *
 * Clean-room implementation against the public Language Server Protocol 3.17
 * specification. Uses `vscode-jsonrpc/node` only for the wire framing.
 */

import { access, readFile, stat } from "node:fs/promises"
import path from "node:path"
import { pathToFileURL, fileURLToPath } from "node:url"

import type { LspServerSpec } from "./server-registry.js"
import { specForFile } from "./server-registry.js"
import type {
  Diagnostic,
  DocumentUri,
  Location,
  PublishDiagnosticsParams,
  WorkspaceEdit,
} from "./types.js"

/** Minimal JSON-RPC connection contract used by the client. */
export interface RpcConnection {
  sendRequest<T>(method: string, params: unknown): Promise<T>
  sendNotification(method: string, params: unknown): void
  onNotification(method: string, handler: (params: unknown) => void): void
  onClose(handler: () => void): void
  listen(): void
  dispose(): void
}

/** Factory used to spawn an LSP server and wrap its stdio into an RPC connection. */
export type ConnectionFactory = (spec: LspServerSpec, rootPath: string) => Promise<RpcConnection>

export interface LspClientOptions {
  /** Override the connection factory (used by tests). */
  factory?: ConnectionFactory
  /** RPC timeout in milliseconds (default 10s). */
  timeoutMs?: number
}

interface ClientCacheEntry {
  client: LspClient
  rootPath: string
}

const DEFAULT_TIMEOUT_MS = 10_000
const cache = new Map<string, ClientCacheEntry>()

/** Convert a filesystem path to an LSP `file://` URI. */
export function pathToUri(filePath: string): DocumentUri {
  return pathToFileURL(filePath).toString()
}

/** Convert an LSP `file://` URI back to a filesystem path. */
export function uriToPath(uri: DocumentUri): string {
  if (!uri.startsWith("file://")) return uri
  return fileURLToPath(uri)
}

/** Maximum number of parent directories `findRoot` will visit before giving up. */
export const FIND_ROOT_MAX_DEPTH = 16

/**
 * Walk parent directories looking for any of the given marker filenames.
 *
 * Bounded to {@link FIND_ROOT_MAX_DEPTH} ascents so a misconfigured file
 * path can never cause an unbounded `await access` loop.
 */
export async function findRoot(filePath: string, markers: string[]): Promise<string> {
  const startDir = path.dirname(path.resolve(filePath))
  let dir = startDir
  const root = path.parse(dir).root
  for (let depth = 0; depth < FIND_ROOT_MAX_DEPTH; depth++) {
    for (const marker of markers) {
      const candidate = path.join(dir, marker)
      try {
        await access(candidate)
        return dir
      } catch {
        // marker not present in this dir — keep walking
      }
    }
    if (dir === root) return startDir
    const parent = path.dirname(dir)
    if (parent === dir) return startDir
    dir = parent
  }
  return startDir
}

/**
 * Long-lived LSP client. Reuse via {@link LspClient.forFile}.
 */
export class LspClient {
  private initialized = false
  private docVersions = new Map<string, number>()
  private diagnosticsByUri = new Map<string, Diagnostic[]>()
  private waiters = new Map<string, Array<(d: Diagnostic[]) => void>>()
  private closed = false
  private readonly timeoutMs: number

  /** Per-URI cleanup callbacks invoked when diagnostics arrive (e.g. clearTimeout). */
  private waiterCleanups = new Map<string, Set<() => void>>()

  constructor(
    private readonly conn: RpcConnection,
    private readonly spec: LspServerSpec,
    private readonly rootPath: string,
    options: LspClientOptions = {},
  ) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.conn.onNotification("textDocument/publishDiagnostics", (params) => {
      const p = params as PublishDiagnosticsParams
      if (!p?.uri) return
      this.diagnosticsByUri.set(p.uri, p.diagnostics ?? [])
      const pending = this.waiters.get(p.uri)
      if (pending) {
        this.waiters.delete(p.uri)
        for (const resolve of pending) resolve(p.diagnostics ?? [])
      }
      const cleanups = this.waiterCleanups.get(p.uri)
      if (cleanups) {
        this.waiterCleanups.delete(p.uri)
        for (const fn of cleanups) {
          try {
            fn()
          } catch {
            // best-effort cleanup
          }
        }
      }
    })
    this.conn.onClose(() => {
      this.closed = true
      this.initialized = false
    })
    this.conn.listen()
  }

  static async forFile(filePath: string, options: LspClientOptions = {}): Promise<LspClient> {
    const spec = specForFile(filePath)
    if (!spec) throw new Error(`No LSP server registered for ${path.extname(filePath) || "(no extension)"}`)
    const rootPath = await findRoot(filePath, spec.rootPatterns)
    const cacheKey = `${rootPath}#${spec.language}`
    const existing = cache.get(cacheKey)
    if (existing && !existing.client.closed) return existing.client
    const factory = options.factory ?? defaultConnectionFactory
    const conn = await factory(spec, rootPath)
    const client = new LspClient(conn, spec, rootPath, options)
    await client.initialize(pathToUri(rootPath))
    cache.set(cacheKey, { client, rootPath })
    return client
  }

  /** Drop a cached client (used by tests / restart logic). */
  static evict(rootPath: string, language: string): void {
    cache.delete(`${rootPath}#${language}`)
  }

  /** Drop every cached client (used by tests). */
  static evictAll(): void {
    cache.clear()
  }

  get isClosed(): boolean {
    return this.closed
  }

  private withTimeout<T>(label: string, p: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`LSP ${label} timed out after ${this.timeoutMs}ms`)), this.timeoutMs)
    })
    return Promise.race([p, timeout]).finally(() => {
      if (timer) clearTimeout(timer)
    }) as Promise<T>
  }

  async initialize(rootUri: DocumentUri): Promise<void> {
    if (this.initialized) return
    await this.withTimeout(
      "initialize",
      this.conn.sendRequest("initialize", {
        processId: typeof process !== "undefined" ? process.pid : null,
        rootUri,
        rootPath: uriToPath(rootUri),
        capabilities: {
          textDocument: {
            synchronization: { dynamicRegistration: false },
            publishDiagnostics: { relatedInformation: true },
            definition: { dynamicRegistration: false },
            references: { dynamicRegistration: false },
            rename: { dynamicRegistration: false, prepareSupport: false },
          },
          workspace: { applyEdit: true, workspaceEdit: { documentChanges: true } },
        },
        workspaceFolders: [{ uri: rootUri, name: path.basename(uriToPath(rootUri)) }],
      }),
    )
    this.conn.sendNotification("initialized", {})
    this.initialized = true
  }

  async didOpen(filePath: string): Promise<void> {
    const uri = pathToUri(filePath)
    const text = await readFile(filePath, "utf8")
    const version = 1
    this.docVersions.set(uri, version)
    this.conn.sendNotification("textDocument/didOpen", {
      textDocument: { uri, languageId: this.spec.languageId, version, text },
    })
  }

  async didChange(filePath: string, content: string): Promise<void> {
    const uri = pathToUri(filePath)
    const next = (this.docVersions.get(uri) ?? 1) + 1
    this.docVersions.set(uri, next)
    this.conn.sendNotification("textDocument/didChange", {
      textDocument: { uri, version: next },
      contentChanges: [{ text: content }],
    })
  }

  /**
   * Pull diagnostics for `filePath`. Opens the file if needed and waits
   * briefly for the first publishDiagnostics push if none have arrived.
   */
  async diagnostics(filePath: string, waitMs = 1500): Promise<Diagnostic[]> {
    const uri = pathToUri(filePath)
    if (!this.docVersions.has(uri)) await this.didOpen(filePath)
    const cached = this.diagnosticsByUri.get(uri)
    if (cached) return cached
    return new Promise<Diagnostic[]>((resolve) => {
      const list = this.waiters.get(uri) ?? []
      list.push(resolve)
      this.waiters.set(uri, list)
      const timer = setTimeout(() => {
        const pending = this.waiters.get(uri)
        if (pending) {
          const remaining = pending.filter((cb) => cb !== resolve)
          if (remaining.length === 0) this.waiters.delete(uri)
          else this.waiters.set(uri, remaining)
        }
        const cleanups = this.waiterCleanups.get(uri)
        if (cleanups) {
          cleanups.delete(cleanup)
          if (cleanups.size === 0) this.waiterCleanups.delete(uri)
        }
        resolve(this.diagnosticsByUri.get(uri) ?? [])
      }, waitMs)
      const cleanup = (): void => {
        clearTimeout(timer)
      }
      const set = this.waiterCleanups.get(uri) ?? new Set<() => void>()
      set.add(cleanup)
      this.waiterCleanups.set(uri, set)
    })
  }

  async definition(filePath: string, line: number, character: number): Promise<Location[]> {
    await this.ensureOpen(filePath)
    const result = await this.withTimeout<Location[] | Location | null>(
      "definition",
      this.conn.sendRequest("textDocument/definition", {
        textDocument: { uri: pathToUri(filePath) },
        position: { line, character },
      }),
    )
    return normalizeLocations(result)
  }

  async references(
    filePath: string,
    line: number,
    character: number,
    includeDeclaration = true,
  ): Promise<Location[]> {
    await this.ensureOpen(filePath)
    const result = await this.withTimeout<Location[] | null>(
      "references",
      this.conn.sendRequest("textDocument/references", {
        textDocument: { uri: pathToUri(filePath) },
        position: { line, character },
        context: { includeDeclaration },
      }),
    )
    return Array.isArray(result) ? result : []
  }

  async rename(filePath: string, line: number, character: number, newName: string): Promise<WorkspaceEdit> {
    await this.ensureOpen(filePath)
    const result = await this.withTimeout<WorkspaceEdit | null>(
      "rename",
      this.conn.sendRequest("textDocument/rename", {
        textDocument: { uri: pathToUri(filePath) },
        position: { line, character },
        newName,
      }),
    )
    return result ?? {}
  }

  async shutdown(): Promise<void> {
    if (this.closed) return
    try {
      await this.withTimeout("shutdown", this.conn.sendRequest("shutdown", null))
      this.conn.sendNotification("exit", null)
    } catch {
      // Server may already be gone — best-effort.
    } finally {
      this.conn.dispose()
      this.closed = true
    }
  }

  private async ensureOpen(filePath: string): Promise<void> {
    if (!this.docVersions.has(pathToUri(filePath))) {
      try {
        await stat(filePath)
        await this.didOpen(filePath)
      } catch {
        // File may not be on disk yet — caller will get an empty result.
      }
    }
  }
}

function normalizeLocations(result: Location[] | Location | null): Location[] {
  if (!result) return []
  if (Array.isArray(result)) return result
  return [result]
}

interface JsonRpcNodeModule {
  StreamMessageReader: new (stream: NodeJS.ReadableStream) => unknown
  StreamMessageWriter: new (stream: NodeJS.WritableStream) => unknown
  createMessageConnection: (reader: unknown, writer: unknown) => RawMessageConnection
}

interface RawMessageConnection {
  sendRequest<T>(method: string, params: unknown): Promise<T>
  sendNotification(method: string, params: unknown): unknown
  onNotification(method: string, handler: (params: unknown) => void): unknown
  onClose(handler: () => void): unknown
  listen(): void
  dispose(): void
}

/** Resolved at runtime to avoid nodenext static resolution issues. */
async function loadJsonRpcNode(): Promise<JsonRpcNodeModule> {
  // Use an indirection so tsgo / nodenext don't try to type-resolve the subpath.
  const modName = "vscode-jsonrpc/node"
  const mod = (await import(modName)) as JsonRpcNodeModule
  return mod
}

/**
 * Default LSP connection factory.
 *
 * IMPORTANT: We deliberately use `node:child_process.spawn` rather than
 * `Bun.spawn` even when running under Bun, because `vscode-jsonrpc/node`'s
 * `StreamMessageReader` / `StreamMessageWriter` expect Node.js stream
 * objects (`stream.on("data", ...)`, `stream.write(...)`). `Bun.spawn`
 * exposes WHATWG Web `ReadableStream` instances on `proc.stdout`, which
 * lack the `.on(...)` API and silently break the JSON-RPC framing —
 * the LSP handshake never completes.
 *
 * `node:child_process` is fully supported under Bun and returns Node-style
 * streams that plug straight into the JSON-RPC reader/writer.
 */
const defaultConnectionFactory: ConnectionFactory = async (spec, rootPath) => {
  const rpc = await loadJsonRpcNode()
  const cp = await import("node:child_process")
  const proc = cp.spawn(spec.command, spec.args, {
    cwd: rootPath,
    stdio: ["pipe", "pipe", "pipe"],
  })
  if (!proc.stdout || !proc.stdin) {
    throw new Error(`Failed to open stdio for LSP server '${spec.command}'`)
  }
  const stdout: NodeJS.ReadableStream = proc.stdout
  const stdin: NodeJS.WritableStream = proc.stdin
  // Drain stderr to prevent the OS pipe buffer from filling and blocking the server.
  proc.stderr?.resume()
  const dispose = (): void => {
    try {
      proc.kill()
    } catch {
      // already exited
    }
  }

  const reader = new rpc.StreamMessageReader(stdout)
  const writer = new rpc.StreamMessageWriter(stdin)
  const conn = rpc.createMessageConnection(reader, writer)

  const wrapper: RpcConnection = {
    sendRequest: <T>(method: string, params: unknown) => conn.sendRequest<T>(method, params),
    sendNotification: (method: string, params: unknown) => {
      void conn.sendNotification(method, params)
    },
    onNotification: (method: string, handler: (params: unknown) => void) => {
      conn.onNotification(method, handler)
    },
    onClose: (handler: () => void) => {
      conn.onClose(handler)
    },
    listen: () => conn.listen(),
    dispose: () => {
      try {
        conn.dispose()
      } finally {
        dispose()
      }
    },
  }
  return wrapper
}
