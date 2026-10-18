import path from "path"
import type { GuardrailContext } from "./guardrail-context"
import { git, text } from "./guardrail-patterns"

const SHELL_WORD = `(?:"[^"]+"|'[^']+'|\\S+)`

/** Structural: git rm / git add that stages deletions. Not word-match on "delete"/"high". */
export function isGitRemovalCommand(cmd: string) {
  if (
    new RegExp(
      `\\bgit(?:\\s+-C\\s+${SHELL_WORD}|\\s+-c\\s+${SHELL_WORD}|\\s+--(?:git-dir|work-tree|namespace)=${SHELL_WORD}|\\s+--(?:git-dir|work-tree|namespace)\\s+${SHELL_WORD})*\\s+rm\\b`,
      "i",
    ).test(cmd)
  ) {
    return true
  }
  if (
    !new RegExp(
      `\\bgit(?:\\s+-C\\s+${SHELL_WORD}|\\s+-c\\s+${SHELL_WORD}|\\s+--(?:git-dir|work-tree|namespace)=${SHELL_WORD}|\\s+--(?:git-dir|work-tree|namespace)\\s+${SHELL_WORD})*\\s+add\\b`,
      "i",
    ).test(cmd)
  ) {
    return false
  }
  return /(?:^|\s)(-A|--all|-u|--update)(?:\s|$)/.test(cmd)
}

export function parseGitRmTargets(cmd: string) {
  const match = cmd.match(/\bgit(?:\s+[^\s]+)*\s+rm\b([\s\S]*)$/i)
  if (!match) return [] as string[]
  const args = match[1] ?? ""
  const targets: string[] = []
  const re = /"([^"]+)"|'([^']+)'|(\S+)/g
  for (const part of args.matchAll(re)) {
    const token = part[1] ?? part[2] ?? part[3] ?? ""
    if (!token || token.startsWith("-")) continue
    targets.push(token)
  }
  return targets
}

export function referenceNeedle(file: string) {
  const base = path.basename(file)
  const stem = base.includes(".") ? base.slice(0, base.lastIndexOf(".")) : base
  return stem.length >= 3 ? stem : base
}

/** Structural import/path needles. Short stems avoid bare 1–2 char greps (over-restriction). */
export function referenceNeedles(file: string) {
  const base = path.basename(file)
  const stem = base.includes(".") ? base.slice(0, base.lastIndexOf(".")) : base
  if (!stem) return [] as string[]
  if (stem.length >= 3) return [stem]
  return [`./${stem}`, `/${stem}`, `${stem}.`, base]
}

export async function findReverseReferences(worktree: string, targets: string[]) {
  const hits: { target: string; refs: string[] }[] = []
  for (const target of targets) {
    const needles = referenceNeedles(target)
    if (!needles.length) continue
    const found = new Set<string>()
    for (const needle of needles) {
      const result = await git(worktree, ["grep", "-l", "-F", "--", needle]).catch(() => ({
        stdout: "",
        stderr: "",
        code: 1,
      }))
      if (result.code !== 0 && !result.stdout.trim()) continue
      for (const line of result.stdout.split(/\r?\n/)) {
        const file = line.trim()
        if (file) found.add(file)
      }
    }
    const normTarget = path.normalize(target)
    const refs = [...found].filter((file) => path.normalize(file) !== normTarget && !file.endsWith(`/${normTarget}`))
    if (refs.length) hits.push({ target, refs: refs.slice(0, 12) })
  }
  return hits
}

export function removalBlockMessage(hits: { target: string; refs: string[] }[]) {
  if (!hits.length) return
  const detail = hits
    .map((hit) => `- ${hit.target} ← ${hit.refs.slice(0, 5).join(", ")}${hit.refs.length > 5 ? ", …" : ""}`)
    .join("\n")
  return (
    "removal blocked: reverse references found. Run impact analysis (/impact-analysis or skill) before deleting.\n" +
    detail +
    "\nSet OPENCODE_REMOVAL_GUARD=off only after confirming replacements exist."
  )
}

export function removalGuardDisabled(env: NodeJS.ProcessEnv = process.env) {
  return /^(0|false|off|no)$/i.test(env.OPENCODE_REMOVAL_GUARD ?? "")
}

export function createRemovalHandlers(ctx: GuardrailContext) {
  async function bashBeforeRemoval(cmd: string) {
    if (removalGuardDisabled()) return
    if (!isGitRemovalCommand(cmd)) return

    const targets =
      parseGitRmTargets(cmd).length > 0
        ? parseGitRmTargets(cmd)
        : (
            await git(ctx.input.worktree, ["diff", "--name-only", "--diff-filter=D", "HEAD"]).catch(() => ({
              stdout: "",
              stderr: "",
              code: 1,
            }))
          ).stdout
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter(Boolean)

    if (!targets.length) return
    const hits = await findReverseReferences(ctx.input.worktree, targets)
    const message = removalBlockMessage(hits)
    if (!message) return
    await ctx.mark({ last_block: "bash", last_command: cmd, last_reason: "removal reverse-reference" })
    throw new Error(text(message))
  }

  return { bashBeforeRemoval }
}
