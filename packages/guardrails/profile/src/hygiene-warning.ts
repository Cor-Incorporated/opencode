import type { GuardrailContext } from "./guardrail-context"
import { git, stash } from "./guardrail-patterns"

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
      await ctx.mark({ hygiene_warning: "", hygiene_ignore_streak: 0 })
      return
    }
    // OC-D7: ledger every threshold warning + auto issue after 3 consecutive ignored sessions
    await ctx.seen("repo_hygiene.warning", {
      ...stats,
      component: "OC-D7",
      event: "advise",
    })
    const prev = await stash(ctx.state)
    const sameAsPrev = typeof prev.hygiene_warning === "string" && prev.hygiene_warning === warning
    const streak = sameAsPrev ? Number(prev.hygiene_ignore_streak ?? 0) + 1 : 1
    await ctx.mark({ hygiene_warning: warning, hygiene_ignore_streak: streak })
    if (streak >= 3) {
      await ctx.seen("repo_hygiene.auto_issue_candidate", {
        component: "OC-D7",
        event: "advise",
        rule: "hygiene-ignore-streak",
        streak,
        detail: warning,
      })
      // Advise-only: do not block. Prefer gh issue when available; never fail session.
      try {
        const proc = Bun.spawn(
          [
            "gh",
            "issue",
            "create",
            "--title",
            `chore(hygiene): ignored warning ${streak} sessions`,
            "--body",
            `OC-D7 auto issue (advise-only).\n\nStreak: ${streak}\nWarning: ${warning}\n\nDo not block; review cleanup candidates.`,
          ],
          { cwd: ctx.input.worktree, stdout: "pipe", stderr: "pipe", env: { ...process.env } },
        )
        await proc.exited
        await ctx.seen("repo_hygiene.auto_issue_created", { streak, exit: proc.exitCode })
        await ctx.mark({ hygiene_ignore_streak: 0 })
      } catch {
        await ctx.seen("repo_hygiene.auto_issue_failed", { streak })
      }
    }
  }

  return { onSessionCreated }
}
