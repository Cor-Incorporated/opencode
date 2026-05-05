/**
 * Phase 2 — Scoring.
 *
 * Score formula independently designed for the fork. Combines a square-root
 * file count (diminishing returns on file fanout), a linear subdir term
 * (organisational depth), and a multiplicative interaction between line-share
 * and language diversity that gives every code-heavy directory at least one
 * "density point" even when it is monolingual. Not derived from any
 * third-party source.
 *
 *   filesTerm   = sqrt(file_count) * 2
 *   subdirTerm  = subdir_count
 *   densityTerm = (loc_share / 10) * (lang_count + 1)   // multiplicative
 *   raw         = filesTerm + subdirTerm + densityTerm
 *   loc_share   = clamp((this_loc / total_loc) * 100, 0, 10)
 *
 * Calibration (typical values, with totalLoc large enough that loc_share
 * stays under the cap unless the directory really dominates):
 *   - 1 file, 0 subdirs, 1 language, ~0% LOC  → ≈ 2.0   → skip
 *   - 3 files, 0 subdirs, 1 language, ~5% LOC → ≈ 4.5   → mid band
 *   - 4 files, 0 subdirs, 1 language, share→10 → 4 + 0 + 2 = 6 → high
 *   - 5 files, 2 subdirs, 2 langs, share→10   → 4.47+2+3 = 9.47 → high
 *   - 10 files, 4 subdirs, 2 langs, share→10  → 6.32+4+3 = 13.32 → strong high
 *
 * Decision rules (re-calibrated to the new range):
 *   raw > 5           → generate (or update if AGENTS.md already exists)
 *   3 <= raw <= 5     → generate only when no ancestor within 2 levels
 *                       carries its own AGENTS.md (avoids redundant guidance)
 *   raw < 3           → skip
 *   The discovery root is always emitted regardless of score.
 *   --create-new lowers the must-generate threshold to 2.
 */

import type { DirScore, DirStats } from "./types.js"

export type ScoreOpts = {
  createNew: boolean
}

const HIGH_THRESHOLD = 5
const MID_THRESHOLD = 3
const CREATE_NEW_THRESHOLD = 2

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
    const filesTerm = Math.sqrt(s.fileCount) * 2
    const subdirTerm = s.subdirCount
    const densityTerm = (locShare / 10) * (s.languages.length + 1)
    const raw = filesTerm + subdirTerm + densityTerm
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
    if (raw >= CREATE_NEW_THRESHOLD) {
      return { action: s.existing ? "update" : "generate", reason: `create-new mode (score=${round(raw)})` }
    }
    return { action: "skip", reason: `create-new threshold not met (score=${round(raw)} < ${CREATE_NEW_THRESHOLD})` }
  }
  if (raw > HIGH_THRESHOLD) {
    return { action: s.existing ? "update" : "generate", reason: `score > ${HIGH_THRESHOLD} (=${round(raw)})` }
  }
  if (raw >= MID_THRESHOLD) {
    if (ancestorWithinHasAgents(s, prior, indexByRel, 2)) {
      return { action: "skip", reason: `score ${round(raw)} but ancestor within 2 levels already covers this dir` }
    }
    return { action: s.existing ? "update" : "generate", reason: `score ${round(raw)} with no nearby ancestor coverage` }
  }
  return { action: "skip", reason: `score ${round(raw)} < ${MID_THRESHOLD}` }
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
