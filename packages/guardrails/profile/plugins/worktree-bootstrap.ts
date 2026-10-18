import path from "path"
import { existsSync } from "fs"
import type { GuardrailContext } from "./guardrail-context"
import { git } from "./guardrail-patterns"

/** Structural: git worktree add ... */
export function isWorktreeAddCommand(cmd: string) {
  return /\bgit(?:\s+\S+)*\s+worktree\s+add\b/i.test(cmd)
}

export function parseWorktreeAddPath(cmd: string) {
  const match = cmd.match(/\bworktree\s+add\b\s+(?:-b\s+\S+\s+|--detach\s+|-[B]\s+\S+\s+)*("([^"]+)"|'([^']+)'|(\S+))/i)
  return match?.[2] || match?.[3] || match?.[4] || ""
}

export async function isGitWorktreeCheckout(dir: string) {
  const gitFile = path.join(dir, ".git")
  if (!existsSync(gitFile)) {
    const result = await git(dir, ["rev-parse", "--git-dir"]).catch(() => ({ stdout: "", stderr: "", code: 1 }))
    return result.code === 0 && /worktrees\//.test(result.stdout)
  }
  try {
    const text = await Bun.file(gitFile).text()
    return text.trimStart().startsWith("gitdir:")
  } catch {
    return false
  }
}

export function needsNodeModulesProvision(dir: string) {
  const hasPackage = existsSync(path.join(dir, "package.json"))
  if (!hasPackage) return false
  return !existsSync(path.join(dir, "node_modules"))
}

export async function resolveMainWorktreeRoot(dir: string) {
  const result = await git(dir, ["rev-parse", "--path-format=absolute", "--git-common-dir"]).catch(() => ({
    stdout: "",
    stderr: "",
    code: 1,
  }))
  if (result.code !== 0 || !result.stdout.trim()) return ""
  const common = result.stdout.trim()
  // common-dir is usually <root>/.git — parent is the main worktree
  if (common.endsWith("/.git") || common.endsWith("\\.git")) return path.dirname(common)
  if (path.basename(common) === ".git") return path.dirname(common)
  // bare / unusual layouts: walk up looking for package.json + node_modules
  let cursor = path.dirname(common)
  for (let i = 0; i < 6; i++) {
    if (existsSync(path.join(cursor, "package.json")) && existsSync(path.join(cursor, "node_modules"))) return cursor
    const parent = path.dirname(cursor)
    if (parent === cursor) break
    cursor = parent
  }
  return ""
}

export function worktreeBootstrapAdvisory(worktreeDir: string, mainRoot: string) {
  const rel = mainRoot ? path.relative(worktreeDir, path.join(mainRoot, "node_modules")) : "../../node_modules"
  const target = rel.startsWith(".") ? rel : `../${rel}`
  return (
    `⚠️ [WORKTREE BOOTSTRAP — pattern M] This checkout looks like a git worktree without node_modules.\n` +
    `JS/TS tests will fail with ERR_MODULE_NOT_FOUND until provisioned.\n` +
    `Suggested (monorepo share):\n` +
    `  ln -s ${target || "../../node_modules"} "${path.join(worktreeDir, "node_modules")}"\n` +
    `Or from the main worktree: bun install / npm install, then re-link.\n` +
    `Set OPENCODE_WORKTREE_BOOTSTRAP_GUARD=off to silence.`
  )
}

export function worktreeBootstrapGuardDisabled(env: NodeJS.ProcessEnv = process.env) {
  return /^(0|false|off|no)$/i.test(env.OPENCODE_WORKTREE_BOOTSTRAP_GUARD ?? "")
}

export function createWorktreeBootstrapHandlers(ctx: GuardrailContext) {
  async function onSessionCreated() {
    if (worktreeBootstrapGuardDisabled()) return
    const dir = ctx.input.worktree
    if (!(await isGitWorktreeCheckout(dir))) return
    if (!needsNodeModulesProvision(dir)) return
    const root = await resolveMainWorktreeRoot(dir)
    const message = worktreeBootstrapAdvisory(dir, root)
    await ctx.mark({ worktree_bootstrap_advisory: message })
    await ctx.seen("worktree_bootstrap.missing_node_modules", { dir, root })
  }

  async function afterBash(item: { tool: string; args?: Record<string, unknown> }, out: { output?: string }) {
    if (worktreeBootstrapGuardDisabled()) return
    if (item.tool !== "bash") return
    const cmd = typeof item.args?.command === "string" ? item.args.command : ""
    if (!isWorktreeAddCommand(cmd)) return
    const added = parseWorktreeAddPath(cmd)
    const dir = added
      ? path.isAbsolute(added)
        ? added
        : path.resolve(ctx.input.worktree, added)
      : ""
    if (!dir || !needsNodeModulesProvision(dir)) return
    const root = (await resolveMainWorktreeRoot(ctx.input.worktree)) || ctx.input.worktree
    const message = worktreeBootstrapAdvisory(dir, root)
    out.output = `${out.output || ""}\n\n${message}`
    await ctx.mark({ worktree_bootstrap_advisory: message })
    await ctx.seen("worktree_bootstrap.after_add", { dir })
  }

  return { onSessionCreated, afterBash }
}
