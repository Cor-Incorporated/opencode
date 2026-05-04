/**
 * Wrapper around the `ast-grep` CLI (binary name `sg`).
 *
 * We invoke `sg run --pattern ... --lang ... --json=stream [paths...]`
 * and parse its JSON-stream output. With `--rewrite`, the same flags are
 * combined with `--update-all` to apply changes (unless dryRun=true).
 */

import { readFile, writeFile, rename as renameFile } from "node:fs/promises"
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
    const code = await proc.exited
    return code === 0
  } catch {
    return false
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
  // Build all updated contents first, then write atomically per file.
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

function applyByteEdits(content: string, matches: AstGrepRawMatch[]): string {
  // Apply in reverse byte-offset order so earlier offsets remain valid.
  const sorted = [...matches]
    .filter((m) => m.range?.byteOffset && m.replacement !== undefined)
    .sort((a, b) => (b.range!.byteOffset!.start ?? 0) - (a.range!.byteOffset!.start ?? 0))
  let out = content
  for (const m of sorted) {
    const start = m.range!.byteOffset!.start
    const end = m.range!.byteOffset!.end
    out = out.slice(0, start) + (m.replacement ?? "") + out.slice(end)
  }
  return out
}

async function collectMatches(proc: SpawnedProcess): Promise<AstGrepRawMatch[]> {
  const text = await readAllText(proc.stdout)
  const code = await proc.exited
  // ast-grep exits with non-zero when no matches found; treat that as empty result.
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
  // Suppress unused-code warning: callers rely on side effect of awaiting exited.
  void code
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

const defaultSpawn: SpawnFn = (cmd, opts) => {
  const bunGlobal = (globalThis as { Bun?: { spawn: (cmd: string[], opts: unknown) => unknown } }).Bun
  if (bunGlobal?.spawn) {
    const proc = bunGlobal.spawn(cmd, {
      cwd: opts.cwd,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    }) as {
      stdout: ReadableStream<Uint8Array>
      stderr: ReadableStream<Uint8Array> | null
      exited: Promise<number>
    }
    return { stdout: proc.stdout, stderr: proc.stderr, exited: proc.exited }
  }
  // Fallback to Node child_process for non-Bun runtimes.
  const { spawn } = require("node:child_process") as typeof import("node:child_process")
  const child = spawn(cmd[0]!, cmd.slice(1), { cwd: opts.cwd })
  const exited = new Promise<number>((resolve) => {
    child.on("exit", (code) => resolve(code ?? 1))
  })
  return { stdout: child.stdout, stderr: child.stderr, exited }
}

/** Exposed for tests: lang validator. */
export function isSupportedLang(lang: string): lang is AstGrepLang {
  return (["ts", "tsx", "js", "jsx", "py", "go", "rs", "java", "cpp"] as const).includes(lang as AstGrepLang)
}
