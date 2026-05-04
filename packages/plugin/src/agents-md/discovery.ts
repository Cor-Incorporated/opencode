/**
 * Phase 1 — Discovery.
 *
 * Walk a project tree and collect per-directory facts (file counts, LOC,
 * languages, manifests, existing AGENTS.md). Honors `.gitignore` from the
 * discovery root in addition to the always-excluded directory list.
 */

import * as fs from "node:fs/promises"
import * as path from "node:path"
import {
  ALWAYS_EXCLUDED_DIRS,
  SOURCE_EXTENSIONS,
  type DirStats,
  type SourceExtension,
} from "./types.js"

const SOURCE_EXT_SET = new Set<string>(SOURCE_EXTENSIONS)
const EXCLUDED_DIR_SET = new Set<string>(ALWAYS_EXCLUDED_DIRS)
const MANIFESTS = ["package.json", "pyproject.toml", "go.mod", "Cargo.toml", "build.gradle", "pom.xml"]

export type DiscoveryOpts = {
  cwd: string
  maxDepth: number
}

/** Walk the tree and return stats for every visited directory, root first. */
export async function discover(opts: DiscoveryOpts): Promise<DirStats[]> {
  const root = path.resolve(opts.cwd)
  const ignore = await loadGitignore(root)
  const out: DirStats[] = []
  await walk(root, root, 0, opts.maxDepth, ignore, out)
  return out
}

/** Visit a single directory, append stats, then recurse into children. */
async function walk(
  dir: string,
  root: string,
  depth: number,
  maxDepth: number,
  ignore: GitignoreMatcher,
  out: DirStats[],
): Promise<void> {
  const entries = await safeReadDir(dir)
  if (!entries) return
  const stats = await collectStats(dir, root, depth, entries)
  out.push(stats)
  if (depth >= maxDepth) return
  const children = entries
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .filter((name) => !EXCLUDED_DIR_SET.has(name))
    .filter((name) => !name.startsWith("."))
    .filter((name) => !ignore.matches(toRelPosix(path.join(dir, name), root), true))
    .sort()
  for (const name of children) {
    await walk(path.join(dir, name), root, depth + 1, maxDepth, ignore, out)
  }
}

/** Build {@link DirStats} for one directory using its already-listed entries. */
async function collectStats(
  dir: string,
  root: string,
  depth: number,
  entries: Awaited<ReturnType<typeof safeReadDir>>,
): Promise<DirStats> {
  const fileNames = (entries ?? []).filter((e) => e.isFile()).map((e) => e.name)
  const subdirNames = (entries ?? [])
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .filter((name) => !EXCLUDED_DIR_SET.has(name))
    .filter((name) => !name.startsWith("."))
  const sourceFiles = fileNames.filter((name) => SOURCE_EXT_SET.has(path.extname(name)))
  const languages = uniqueExtensions(sourceFiles)
  const loc = await sumLoc(dir, sourceFiles)
  const manifests = fileNames.filter((name) => MANIFESTS.includes(name))
  const existing = fileNames.includes("AGENTS.md") ? await safeReadFile(path.join(dir, "AGENTS.md")) : undefined
  const packageDescription = manifests.includes("package.json")
    ? await readPackageDescription(path.join(dir, "package.json"))
    : undefined
  return {
    path: dir,
    relPath: dir === root ? "." : toRelPosix(dir, root),
    depth,
    fileCount: sourceFiles.length,
    subdirCount: subdirNames.length,
    loc,
    languages,
    existing,
    packageDescription,
    manifests,
  }
}

/** Sum newline-terminated line counts across a list of source files. */
async function sumLoc(dir: string, files: string[]): Promise<number> {
  let total = 0
  for (const name of files) {
    const text = await safeReadFile(path.join(dir, name))
    if (!text) continue
    total += countLines(text)
  }
  return total
}

/** Count physical lines, treating files without a trailing newline as +1. */
function countLines(text: string): number {
  if (text.length === 0) return 0
  let count = 0
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) count++
  }
  return text.charCodeAt(text.length - 1) === 10 ? count : count + 1
}

/** Distinct source extensions in path order, preserving spec ordering. */
function uniqueExtensions(files: string[]): SourceExtension[] {
  const seen = new Set<string>()
  for (const name of files) {
    const ext = path.extname(name)
    if (SOURCE_EXT_SET.has(ext)) seen.add(ext)
  }
  return SOURCE_EXTENSIONS.filter((ext) => seen.has(ext))
}

async function safeReadDir(dir: string) {
  try {
    return await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return null
  }
}

async function safeReadFile(file: string): Promise<string | undefined> {
  try {
    return await fs.readFile(file, "utf8")
  } catch {
    return undefined
  }
}

async function readPackageDescription(file: string): Promise<string | undefined> {
  const raw = await safeReadFile(file)
  if (!raw) return undefined
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== "object" || parsed === null) return undefined
    const desc = (parsed as Record<string, unknown>).description
    return typeof desc === "string" && desc.length > 0 ? desc : undefined
  } catch {
    return undefined
  }
}

function toRelPosix(p: string, root: string): string {
  const rel = path.relative(root, p)
  return rel.split(path.sep).join("/")
}

/** Minimal `.gitignore` matcher — supports literal names and `*` wildcards. */
type GitignoreMatcher = {
  matches(relPath: string, isDir: boolean): boolean
}

async function loadGitignore(root: string): Promise<GitignoreMatcher> {
  const raw = await safeReadFile(path.join(root, ".gitignore"))
  if (!raw) return { matches: () => false }
  const patterns = raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"))
    .map(compilePattern)
    .filter((p): p is CompiledPattern => p !== null)
  return {
    matches(relPath, isDir) {
      for (const p of patterns) {
        if (p.dirOnly && !isDir) continue
        if (p.regex.test(relPath)) return true
      }
      return false
    },
  }
}

type CompiledPattern = { regex: RegExp; dirOnly: boolean }

function compilePattern(line: string): CompiledPattern | null {
  if (line.startsWith("!")) return null
  let pat = line
  const dirOnly = pat.endsWith("/")
  if (dirOnly) pat = pat.slice(0, -1)
  if (pat.startsWith("/")) pat = pat.slice(1)
  const escaped = pat
    .split("")
    .map((ch) => {
      if (ch === "*") return "[^/]*"
      if (ch === "?") return "[^/]"
      if (".+^$()[]{}|\\".includes(ch)) return "\\" + ch
      return ch
    })
    .join("")
  // Match either the exact relative path or a path nested anywhere underneath.
  return { regex: new RegExp("(^|/)" + escaped + "(/|$)"), dirOnly }
}
