import type { GuardrailContext } from "./guardrail-context"
import { git } from "./guardrail-patterns"

export const DEFAULT_HYGIENE_THRESHOLDS = {
  worktrees: 8,
  staleBranches: 10,
}

export type HygieneThresholds = typeof DEFAULT_HYGIENE_THRESHOLDS

export type HygieneStats = {
  worktrees: number
  staleBranches: number
}

/** Count worktree entries from `git worktree list --porcelain` (structural, not word match). */
export function countWorktrees(porcelain: string) {
  return porcelain
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("worktree ")).length
}

/** Count local branches whose tip is already an ancestor of the integration tip. */
export function countStaleBranches(mergedNames: string[], currentBranch: string, protectedNames: string[]) {
  const protectedSet = new Set(["main", "master", "develop", "dev", "HEAD", ...protectedNames])
  return mergedNames
    .map((name) => name.replace(/^\*\s+/, "").trim())
    .filter(Boolean)
    .filter((name) => name !== currentBranch && !protectedSet.has(name) && !name.startsWith("remotes/")).length
}

export function hygieneWarningMessage(stats: HygieneStats, thresholds: HygieneThresholds = DEFAULT_HYGIENE_THRESHOLDS) {
  const parts: string[] = []
  if (stats.worktrees > thresholds.worktrees) {
    parts.push(`worktrees=${stats.worktrees} (threshold ${thresholds.worktrees})`)
  }
  if (stats.staleBranches > thresholds.staleBranches) {
    parts.push(`merged-local-branches=${stats.staleBranches} (threshold ${thresholds.staleBranches})`)
  }
  if (!parts.length) return
  return (
    `⚠️ Repo hygiene: ${parts.join(", ")}. ` +
    `Run /repo-hygiene to list cleanup candidates (dry-run). Do not delete without confirmation.`
  )
}

export async function collectHygieneStats(worktree: string): Promise<HygieneStats> {
  const [worktreeList, branchShow, merged] = await Promise.all([
    git(worktree, ["worktree", "list", "--porcelain"]).catch(() => ({ stdout: "", stderr: "", code: 1 })),
    git(worktree, ["branch", "--show-current"]).catch(() => ({ stdout: "", stderr: "", code: 1 })),
    git(worktree, ["branch", "--merged"]).catch(() => ({ stdout: "", stderr: "", code: 1 })),
  ])

  const current = branchShow.stdout.trim()
  const mergedNames = merged.stdout.split(/\r?\n/).map((line) => line.trim())
  return {
    worktrees: countWorktrees(worktreeList.stdout),
    staleBranches: countStaleBranches(mergedNames, current, []),
  }
}

export function hygieneGuardDisabled(env: NodeJS.ProcessEnv = process.env) {
  return /^(0|false|off|no)$/i.test(env.OPENCODE_HYGIENE_GUARD ?? "")
}

export function createHygieneHandlers(ctx: GuardrailContext, thresholds: HygieneThresholds = DEFAULT_HYGIENE_THRESHOLDS) {
  async function onSessionCreated() {
    if (hygieneGuardDisabled()) return
    const stats = await collectHygieneStats(ctx.input.worktree)
    const warning = hygieneWarningMessage(stats, thresholds)
    if (!warning) {
      await ctx.mark({ hygiene_warning: "" })
      return
    }
    await ctx.mark({ hygiene_warning: warning })
    await ctx.seen("repo_hygiene.warning", stats)
  }

  return { onSessionCreated }
}
