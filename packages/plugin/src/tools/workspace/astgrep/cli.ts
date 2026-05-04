/**
 * Wrapper around the `ast-grep` CLI (binary name `sg`).
 *
 * We invoke `sg run --pattern ... --lang ... --json=stream [paths...]`
 * and parse its JSON-stream output. With `--rewrite`, the same flags are
 * combined with `--update-all` to apply changes (unless dryRun=true).
 */

import { Buffer } from "node:buffer"
import { readFile, writeFile, rename as renameFile } from "node:fs/promises"
import { createRequire } from "node:module"
import path from "node:path"

import type {
  AstGrepLang,
  ReplaceOpts,
  ReplaceResult,
  ReplaceSample,
  SearchOpts,
  SearchResult,
} from "./types.js"

export interface SpawnedProcess {
  stdout: ReadableStream<Uint8Array> | NodeJS.ReadableStream
  stderr: ReadableStream<Uint8Array> | NodeJS.ReadableStream | null
  exited: Promise<number>
}

export type SpawnFn = (cmd: string[], opts: { cwd?: string }) => SpawnedProcess

export interface AstGrepCliOptions {
  /** Override the spawn function (used by tests). */
  spawn?: SpawnFn
  /** Override the path to the `sg` binary. */
  binary?: string
}

interface AstGrepRawMatch {
  file?: string
  text?: string
  range?: {
    byteOffset?: { start: number; end: number }
    start?: { line: number; column: number }
    end?: { line: number; column: number }
  }
  metaVariables?: {
    single?: Record<string, { text: string }>
    multi?: Record<string, Array<{ text: string }>>
  }
  lines?: string
  replacement?: string
}

const SEARCH_RESULT_CAP = 200

/**
 * Exit codes from `sg` we treat as "no matches" (not an error).
 *
 * ast-grep historically returns exit 1 when zero matches are found and the
 * pattern compiled cleanly. Anything else with non-empty stderr is a real
 * failure (bad pattern, missing path, IO error, etc.).
 */
const ASTGREP_NO_MATCH_EXIT_CODES = new Set([0, 1])

/** Raised by {@link AstGrepCli} when the underlying CLI fails. */
export class AstGrepCliError extends Error {
  constructor(
    message: string,
    public readonly exitCode: number,
    public readonly stderr: string,
  ) {
    super(message)
    this.name = "AstGrepCliError"
  }
}

export class AstGrepCli {
  private readonly spawnFn: SpawnFn
  private resolvedBinary: string | null

  constructor(options: AstGrepCliOptions = {}) {
    this.spawnFn = options.spawn ?? defaultSpawn
    this.resolvedBinary = options.binary ?? null
  }

  /**
   * Resolve the `sg` binary path. Returns the cached value if already
   * resolved, otherwise probes PATH and the local node_modules.
   */
  async ensureBinary(): Promise<string> {
    if (this.resolvedBinary) return this.resolvedBinary
    const candidates = candidateBinaries()
    for (const candidate of candidates) {
      if (await binaryWorks(candidate, this.spawnFn)) {
        this.resolvedBinary = candidate
        return candidate
      }
    }
    throw new Error(
      "ast-grep CLI (`sg`) not found. Install: bun add -g @ast-grep/cli  (or run `bun install` in this repo if it is a dependency)",
    )
  }

  buildSearchArgs(opts: SearchOpts, includeRewrite?: string, dryRun?: boolean): string[] {
    const args = ["run", "--pattern", opts.pattern, "--lang", opts.lang, "--json=stream"]
    if (opts.context && opts.context > 0) args.push("--context", String(opts.context))
    if (opts.globs?.length) {
      for (const g of opts.globs) args.push("--globs", g)
    }
    if (includeRewrite !== undefined) {
      args.push("--rewrite", includeRewrite)
      if (!dryRun) args.push("--update-all")
    }
    if (opts.paths?.length) {
      for (const p of opts.paths) args.push(p)
    }
    return args
  }

  async search(opts: SearchOpts): Promise<{ results: SearchResult[]; total: number; truncated: boolean }> {
    const binary = await this.ensureBinary()
    const args = this.buildSearchArgs(opts)
    const proc = this.spawnFn([binary, ...args], { cwd: opts.paths?.[0] })
    const matches = await collectMatches(proc)
    const truncated = matches.length > SEARCH_RESULT_CAP
    const trimmed = truncated ? matches.slice(0, SEARCH_RESULT_CAP) : matches
    return {
      total: matches.length,
      truncated,
      results: trimmed.map((m) => toSearchResult(m, opts.context)),
    }
  }

  async replace(opts: ReplaceOpts): Promise<ReplaceResult> {
    const binary = await this.ensureBinary()
    const dryRun = opts.dryRun ?? false
    if (dryRun) {
      // For dryRun we need both before/after — invoke once with --rewrite but no --update-all,
      // and ast-grep reports the proposed `replacement` per match without touching disk.
      const proc = this.spawnFn(
        [binary, ...this.buildSearchArgs(opts, opts.rewrite, true)],
        { cwd: opts.paths?.[0] },
      )
      const matches = await collectMatches(proc)
      return summarizeMatches(matches)
    }
    // Non-dry: capture the matches first (so we can return before/after samples),
    // then apply edits atomically by writing the new content per file ourselves.
    const previewProc = this.spawnFn(
      [binary, ...this.buildSearchArgs(opts, opts.rewrite, true)],
      { cwd: opts.paths?.[0] },
    )
    const matches = await collectMatches(previewProc)
    if (matches.length === 0) return { filesChanged: 0, totalEdits: 0, sample: [] }
    await applyMatchesToDisk(matches)
    return summarizeMatches(matches)
  }
}

function candidateBinaries(): string[] {
  const list: string[] = []
  const cwd = typeof process !== "undefined" ? process.cwd() : ""
  if (cwd) {
    list.push(path.join(cwd, "node_modules", ".bin", "sg"))
    list.push(path.join(cwd, "node_modules", ".bin", "ast-grep"))
  }
  list.push("sg")
  list.push("ast-grep")
  return list
}

async function binaryWorks(binary: string, spawnFn: SpawnFn): Promise<boolean> {
  try {
    const proc = spawnFn([binary, "--version"], {})
    // Drain stdout/stderr so a chatty binary on PATH (e.g. another `sg`
    // that prints help text on `--version`) cannot fill the OS pipe
    // buffer (~64 KiB on Linux) and deadlock waiting for `exited`.
    drainStreamSilently(proc.stdout)
    if (proc.stderr) drainStreamSilently(proc.stderr)
    const code = await proc.exited
    return code === 0
  } catch {
    return false
  }
}

/** Best-effort drain of a stdout/stderr stream without retaining the data. */
function drainStreamSilently(stream: ReadableStream<Uint8Array> | NodeJS.ReadableStream): void {
  if (isWebStream(stream)) {
    void (async () => {
      try {
        const reader = stream.getReader()
        while (true) {
          const { done } = await reader.read()
          if (done) return
        }
      } catch {
        // ignore
      }
    })()
    return
  }
  try {
    stream.on("data", () => {})
    stream.on("error", () => {})
    if (typeof (stream as { resume?: unknown }).resume === "function") {
      ;(stream as { resume: () => void }).resume()
    }
  } catch {
    // ignore
  }
}

function toSearchResult(raw: AstGrepRawMatch, context?: number): SearchResult {
  const file = raw.file ?? ""
  const start = raw.range?.start ?? { line: 0, column: 0 }
  const metavars: Record<string, string> = {}
  if (raw.metaVariables?.single) {
    for (const [k, v] of Object.entries(raw.metaVariables.single)) {
      metavars[k] = v.text
    }
  }
  if (raw.metaVariables?.multi) {
    for (const [k, arr] of Object.entries(raw.metaVariables.multi)) {
      metavars[k] = arr.map((x) => x.text).join("\n")
    }
  }
  const result: SearchResult = {
    file,
    line: start.line,
    column: start.column,
    matchedText: raw.text ?? "",
  }
  if (Object.keys(metavars).length > 0) result.metavars = metavars
  if (context && raw.lines) {
    const lines = raw.lines.split("\n")
    if (lines.length > 1) {
      result.contextBefore = lines.slice(0, Math.min(context, lines.length - 1))
      result.contextAfter = lines.slice(-Math.min(context, lines.length - 1))
    }
  }
  return result
}

function summarizeMatches(matches: AstGrepRawMatch[]): ReplaceResult {
  const fileSet = new Set<string>()
  const sample: ReplaceSample[] = []
  for (const m of matches) {
    if (m.file) fileSet.add(m.file)
    if (sample.length < 10 && m.file) {
      sample.push({
        file: m.file,
        line: m.range?.start?.line ?? 0,
        before: m.text ?? "",
        after: m.replacement ?? m.text ?? "",
      })
    }
  }
  return { filesChanged: fileSet.size, totalEdits: matches.length, sample }
}

async function applyMatchesToDisk(matches: AstGrepRawMatch[]): Promise<void> {
  const byFile = new Map<string, AstGrepRawMatch[]>()
  for (const m of matches) {
    if (!m.file || m.replacement === undefined) continue
    const list = byFile.get(m.file) ?? []
    list.push(m)
    byFile.set(m.file, list)
  }
  // Build all updated contents first, then write per file. Each write is
  // atomic at the file level (temp+rename); if the process is interrupted
  // between files the run is NOT atomic across files. Recovery story:
  // re-run the same `replace` after fixing the cause — applied edits
  // remain, unapplied files retain their original contents on disk.
  const writes: Array<{ file: string; content: string }> = []
  for (const [file, fileMatches] of byFile) {
    const original = await readFile(file, "utf8")
    const updated = applyByteEdits(original, fileMatches)
    writes.push({ file, content: updated })
  }
  for (const w of writes) {
    const tmp = `${w.file}.tmp.${process.pid}.${Date.now()}`
    await writeFile(tmp, w.content, "utf8")
    await renameFile(tmp, w.file)
  }
}

/**
 * Apply replacement edits using ast-grep's UTF-8 byte offsets.
 *
 * IMPORTANT: ast-grep emits `byteOffset.{start,end}` as UTF-8 byte
 * positions, but JavaScript strings are UTF-16 code units. Slicing the
 * string directly with byte offsets corrupts any file containing
 * multi-byte characters (CJK, emoji, accented Latin, BOM, etc.).
 *
 * We round-trip through a Node `Buffer` so the slice math is performed
 * in the same byte space ast-grep emitted, then decode the result back
 * to UTF-8.
 */
function applyByteEdits(content: string, matches: AstGrepRawMatch[]): string {
  const sorted = [...matches]
    .filter((m) => m.range?.byteOffset && m.replacement !== undefined)
    .sort((a, b) => (b.range!.byteOffset!.start ?? 0) - (a.range!.byteOffset!.start ?? 0))
  if (sorted.length === 0) return content
  let bytes = Buffer.from(content, "utf8")
  for (const m of sorted) {
    const start = m.range!.byteOffset!.start
    const end = m.range!.byteOffset!.end
    const head = bytes.subarray(0, start)
    const tail = bytes.subarray(end)
    const replacement = Buffer.from(m.replacement ?? "", "utf8")
    bytes = Buffer.concat([head, replacement, tail])
  }
  return bytes.toString("utf8")
}

async function collectMatches(proc: SpawnedProcess): Promise<AstGrepRawMatch[]> {
  // Read stdout and stderr concurrently with `exited` so we never block
  // the child by leaving pipes un-drained.
  const stdoutP = readAllText(proc.stdout)
  const stderrP = proc.stderr ? readAllText(proc.stderr) : Promise.resolve("")
  const [text, stderr, code] = await Promise.all([stdoutP, stderrP, proc.exited])

  // Real CLI failure (bad pattern, missing path, IO, etc.). ast-grep
  // returns exit 1 when there are no matches but the run was successful;
  // anything else is a hard failure we must surface so callers don't
  // silently treat broken patterns as "no results".
  if (!ASTGREP_NO_MATCH_EXIT_CODES.has(code)) {
    throw new AstGrepCliError(
      `ast-grep CLI exited with code ${code}${stderr.trim() ? `: ${stderr.trim()}` : ""}`,
      code,
      stderr,
    )
  }

  if (text.trim().length === 0) return []
  const matches: AstGrepRawMatch[] = []
  // --json=stream produces newline-delimited JSON.
  for (const line of text.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const parsed = JSON.parse(trimmed)
      if (Array.isArray(parsed)) {
        for (const item of parsed) matches.push(item as AstGrepRawMatch)
      } else {
        matches.push(parsed as AstGrepRawMatch)
      }
    } catch {
      // Skip malformed lines (e.g. progress messages).
    }
  }
  return matches
}

async function readAllText(stream: ReadableStream<Uint8Array> | NodeJS.ReadableStream): Promise<string> {
  if (isWebStream(stream)) {
    const reader = stream.getReader()
    const decoder = new TextDecoder()
    let out = ""
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      if (value) out += decoder.decode(value, { stream: true })
    }
    out += decoder.decode()
    return out
  }
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = []
    stream.on("data", (chunk: Buffer | string) => {
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk)
    })
    stream.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")))
    stream.on("error", reject)
  })
}

function isWebStream(stream: unknown): stream is ReadableStream<Uint8Array> {
  return (
    typeof stream === "object" &&
    stream !== null &&
    typeof (stream as { getReader?: unknown }).getReader === "function"
  )
}

/**
 * `createRequire` lets us load `node:child_process` synchronously from an
 * ESM module without a top-level `await`. This is the canonical Node.js
 * escape hatch and avoids the bare `require(...)` call that fails under
 * strict ESM resolution. Both Node and Bun support it.
 */
const moduleRequire = createRequire(import.meta.url)
const nodeChildProcess = moduleRequire("node:child_process") as typeof import("node:child_process")

const defaultSpawn: SpawnFn = (cmd, opts) => {
  // We deliberately use node:child_process even under Bun. The rest of
  // the module reads stdout/stderr as Node streams; uniform stream type
  // keeps `readAllText` simple and matches the LSP client decision in
  // ./lsp/client.ts.
  const child = nodeChildProcess.spawn(cmd[0]!, cmd.slice(1), {
    cwd: opts.cwd,
    stdio: ["ignore", "pipe", "pipe"],
  })
  const exited = new Promise<number>((resolve) => {
    child.on("exit", (code) => resolve(code ?? 1))
    child.on("error", () => resolve(1))
  })
  return { stdout: child.stdout!, stderr: child.stderr, exited }
}

/** Exposed for tests: lang validator. */
export function isSupportedLang(lang: string): lang is AstGrepLang {
  return (["ts", "tsx", "js", "jsx", "py", "go", "rs", "java", "cpp"] as const).includes(lang as AstGrepLang)
}
