/**
 * Phase 2 — Scoring.
 *
 * Compute an eligibility score per directory and decide whether to generate,
 * update, or skip an AGENTS.md there.
 *
 * Formula:
 *   score = file_count*3 + subdir_count*2 + loc_share*2 + lang_count*1
 *   loc_share = clamp((this_loc / total_loc) * 100, 0, 10)
 *
 * Decision rules:
 *   score > 15        → generate (or update if AGENTS.md already exists)
 *   8 <= score <= 15  → generate only when no ancestor within 2 levels carries
 *                       its own AGENTS.md (avoids redundant guidance)
 *   score < 8         → skip
 *   The discovery root is always emitted regardless of score.
 *   --create-new lowers the must-generate threshold to 5.
 */

import type { DirScore, DirStats } from "./types.js"

export type ScoreOpts = {
  createNew: boolean
}

/** Score every directory, applying decision rules in topological order. */
export function score(stats: DirStats[], opts: ScoreOpts): DirScore[] {
  if (stats.length === 0) return []
  const totalLoc = stats.reduce((acc, s) => acc + s.loc, 0)
  const indexByRel = new Map<string, number>()
  stats.forEach((s, i) => indexByRel.set(s.relPath, i))
  const out: DirScore[] = []
  for (let i = 0; i < stats.length; i++) {
    const s = stats[i]!
    const locShare = totalLoc === 0 ? 0 : Math.min(10, (s.loc / totalLoc) * 100)
    const raw = s.fileCount * 3 + s.subdirCount * 2 + locShare * 2 + s.languages.length
    const decision = decide(s, raw, out, indexByRel, opts)
    out.push({ stats: s, score: round(raw), locShare: round(locShare), action: decision.action, reason: decision.reason })
  }
  return out
}

/** Apply the rule table in spec order; returns the chosen action and reason. */
function decide(
  s: DirStats,
  raw: number,
  prior: DirScore[],
  indexByRel: Map<string, number>,
  opts: ScoreOpts,
): { action: DirScore["action"]; reason: string } {
  if (s.depth === 0) {
    return { action: s.existing ? "update" : "generate", reason: "repo root always gets AGENTS.md" }
  }
  if (opts.createNew) {
    if (raw >= 5) return { action: s.existing ? "update" : "generate", reason: `create-new mode (score=${round(raw)})` }
    return { action: "skip", reason: `create-new threshold not met (score=${round(raw)} < 5)` }
  }
  if (raw > 15) {
    return { action: s.existing ? "update" : "generate", reason: `score > 15 (=${round(raw)})` }
  }
  if (raw >= 8) {
    if (ancestorWithinHasAgents(s, prior, indexByRel, 2)) {
      return { action: "skip", reason: `score ${round(raw)} but ancestor within 2 levels already covers this dir` }
    }
    return { action: s.existing ? "update" : "generate", reason: `score ${round(raw)} with no nearby ancestor coverage` }
  }
  return { action: "skip", reason: `score ${round(raw)} < 8` }
}

/**
 * True if a non-root ancestor within `levels` is producing/updating an
 * AGENTS.md. The repo root is excluded — it is always emitted, so counting
 * it would collapse the entire 8..15 band into "skip".
 */
function ancestorWithinHasAgents(
  s: DirStats,
  prior: DirScore[],
  indexByRel: Map<string, number>,
  levels: number,
): boolean {
  const parts = s.relPath.split("/")
  for (let up = 1; up <= levels; up++) {
    if (parts.length - up < 0) break
    const ancestorParts = parts.slice(0, parts.length - up)
    if (ancestorParts.length === 0) continue
    const ancestorRel = ancestorParts.join("/")
    const idx = indexByRel.get(ancestorRel)
    if (idx === undefined) continue
    const decision = prior[idx]
    if (decision && (decision.action === "generate" || decision.action === "update")) return true
  }
  return false
}

function round(n: number): number {
  return Math.round(n * 10) / 10
}
