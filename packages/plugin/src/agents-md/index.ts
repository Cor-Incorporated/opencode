/**
 * `/init-deep` — Hierarchical AGENTS.md generator.
 *
 * Public entry point. Orchestrates four phases:
 *
 *   Phase 1: Discovery     — `discover()` walks the tree.
 *   Phase 2: Scoring       — `score()` decides per-directory action.
 *   Phase 3: Generate      — `generate()` renders + `merge()` preserves.
 *   Phase 4: Review/dedupe — `dedupe()` removes redundant guidance.
 *
 * Idempotent: running twice with the same tree produces the same files.
 *
 * Clean-room implementation. The functional spec is derived from public
 * descriptions of similar generators; no third-party source was consulted.
 */

import * as fs from "node:fs/promises"
import * as path from "node:path"
import { discover } from "./discovery.js"
import { score } from "./score.js"
import { generate } from "./generate.js"
import { merge } from "./merge.js"
import { approxTokens, dedupe } from "./dedupe.js"
import type { DirScore, InitDeepOpts, InitDeepResult } from "./types.js"

export type { InitDeepOpts, InitDeepResult, DirAction } from "./types.js"

const DEFAULT_MAX_DEPTH = 4

type ErrnoLike = { code?: string }

/** Run the full pipeline. With `dryRun: true`, returns the plan only. */
export async function runInitDeep(opts: InitDeepOpts = {}): Promise<InitDeepResult> {
  const cwd = path.resolve(opts.cwd ?? process.cwd())
  const maxDepth = opts.maxDepth ?? DEFAULT_MAX_DEPTH
  const stats = await discover({ cwd, maxDepth })
  const scored = score(stats, { createNew: opts.createNew ?? false })
  const emitting = scored.filter((d) => d.action !== "skip")
  if (opts.dryRun) {
    return {
      generated: [],
      skipped: scored.filter((d) => d.action === "skip").map((d) => ({ path: d.stats.path, reason: d.reason })),
      duplicatesRemoved: 0,
      approxTokensAdded: 0,
      plan: scored.map((d) => ({ path: d.stats.path, score: d.score, action: d.action })),
    }
  }
  const rendered = renderAll(scored, emitting)
  const deduped = dedupe({ files: keyByRelative(rendered, cwd) })
  const persistResult = await persist(deduped.files, scored)
  return {
    generated: persistResult.written,
    skipped: [
      ...scored.filter((d) => d.action === "skip").map((d) => ({ path: d.stats.path, reason: d.reason })),
      ...persistResult.skipped,
    ],
    duplicatesRemoved: deduped.removed.length,
    approxTokensAdded: [...deduped.files.values()].reduce((acc, t) => acc + approxTokens(t), 0),
  }
}

/** Render every emitting directory, merging against any existing AGENTS.md. */
function renderAll(all: DirScore[], emitting: DirScore[]): Map<string, string> {
  const out = new Map<string, string>()
  for (const target of emitting) {
    const fresh = generate(target, { all, emitting, rootRelPath: "." })
    const text = target.stats.existing ? merge(target.stats.existing, fresh) : fresh
    out.set(filePathFor(target), text)
  }
  return out
}

function filePathFor(target: DirScore): string {
  return path.join(target.stats.path, "AGENTS.md")
}

/** Convert absolute file paths to repo-relative keys for dedupe. */
function keyByRelative(files: Map<string, string>, cwd: string): Map<string, string> {
  const out = new Map<string, string>()
  for (const [absPath, body] of files) {
    const rel = path.relative(cwd, absPath).split(path.sep).join("/")
    out.set(rel === "AGENTS.md" ? "AGENTS.md" : rel, body)
  }
  return out
}

/**
 * Write deduped contents back to disk.
 *
 * Symlink safety: an `AGENTS.md` that already exists as a symlink could point
 * outside the project tree. Following it would silently overwrite a foreign
 * file, so we refuse to write through symlinks and surface the path in the
 * skip list instead.
 */
async function persist(
  files: Map<string, string>,
  scored: DirScore[],
): Promise<{ written: string[]; skipped: { path: string; reason: string }[] }> {
  const written: string[] = []
  const skipped: { path: string; reason: string }[] = []
  const byRel = new Map<string, DirScore>()
  for (const d of scored) byRel.set(d.stats.relPath === "." ? "AGENTS.md" : d.stats.relPath + "/AGENTS.md", d)
  for (const [rel, body] of files) {
    const target = byRel.get(rel)
    if (!target) continue
    const abs = path.join(target.stats.path, "AGENTS.md")
    if (await isSymlink(abs)) {
      skipped.push({ path: abs, reason: "AGENTS.md is a symlink; refusing to follow (path safety)" })
      continue
    }
    await fs.mkdir(path.dirname(abs), { recursive: true })
    await fs.writeFile(abs, body, "utf8")
    written.push(abs)
  }
  return { written: written.sort(), skipped }
}

/** True iff `abs` exists and is a symlink. ENOENT (missing file) is fine. */
async function isSymlink(abs: string): Promise<boolean> {
  try {
    const st = await fs.lstat(abs)
    return st.isSymbolicLink()
  } catch (e) {
    if ((e as ErrnoLike).code === "ENOENT") return false
    throw e
  }
}
