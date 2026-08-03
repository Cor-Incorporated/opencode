import { cp, lstat, mkdir, readdir, readlink, realpath, rm, symlink } from "fs/promises"
import path from "path"
import { tool } from "@opencode-ai/plugin"
import { Background } from "../../../opencode/src/util/background"

const z = tool.schema

const gap = 750
const cap = 5
const live = new Map<string, Run>()
const seen = new WeakMap<object, Seen>()
const sweeping = new Map<string, Promise<void>>()
const models = new Map<string, Lane>()
const sweepWait = 1000
/** Read-only / investigate workers: keep the historic 10m ceiling. */
export const DEFAULT_TEAM_READ_IDLE_TIMEOUT_MS = 10 * 60 * 1000
/**
 * Write / implementation workers: raised from 600s after deepseek-v4-flash
 * and multi-file implement tasks repeatedly hit the hard wait (Issue #286).
 */
export const DEFAULT_TEAM_WRITE_IDLE_TIMEOUT_MS = 20 * 60 * 1000
/** Default hard wait when task shape is unknown — prefer the write budget. */
export const DEFAULT_TEAM_IDLE_TIMEOUT_MS = DEFAULT_TEAM_WRITE_IDLE_TIMEOUT_MS

type Note = {
  id?: string
  sessionID?: string
  messageID?: string
  type?: string
  text?: string
  state?: {
    status?: string
    output?: string
  }
}

type Msg = {
  info: {
    role: string
    finish?: string
    time?: {
      completed?: number
    }
    error?: {
      data?: {
        message?: string
      }
    }
  }
  parts: Note[]
}

type Stat = {
  type: string
}

type Rule = {
  permission: string
  pattern: string
  action: "allow" | "deny" | "ask"
}

type Lane = {
  provider: string
  model: string
  variant: string
}

type Client = {
  permission?: {
    list(input?: { directory?: string; workspace?: string }): Promise<{
      data?: {
        id: string
        sessionID: string
        permission: string
        patterns: string[]
        metadata?: Record<string, unknown>
      }[]
    }>
  }
  question?: {
    list(input?: { directory?: string; workspace?: string }): Promise<{
      data?: {
        id: string
        sessionID: string
        questions: {
          question: string
          header: string
        }[]
      }[]
    }>
  }
  event?: {
    subscribe(): Promise<{
      stream: AsyncIterable<{
        type?: string
        properties?: Record<string, unknown>
      }>
    }>
  }
  session: {
    get(input: { path: { id: string }; query: { directory: string } }): Promise<{ data?: { permission?: Rule[] } }>
    create(input: {
      body: { parentID: string; title: string; permission?: Rule[] }
      query: { directory: string }
    }): Promise<{ data: { id: string } }>
    promptAsync(input: {
      path: { id: string }
      query: { directory: string }
      body: {
        agent?: string
        model?: {
          providerID: string
          modelID: string
        }
        tools?: Record<string, boolean>
        variant?: string
        parts: { type: "text"; text: string }[]
      }
    }): Promise<unknown>
    prompt(input: {
      path: { id: string }
      query: { directory: string }
      body: {
        noReply?: boolean
        parts: { type: "text"; text: string }[]
      }
    }): Promise<unknown>
    status(input: { query: { directory: string } }): Promise<{ data?: Record<string, Stat> }>
    messages(input: { path: { id: string }; query: { directory: string } }): Promise<{ data?: Msg[] }>
    abort(input: { path: { id: string }; query: { directory: string } }): Promise<unknown>
    permission?(id: string): ReadonlyArray<{
      permission?: string
      patterns?: string[]
      metadata?: Record<string, unknown>
    }>
    question?(id: string): ReadonlyArray<{
      header?: string
      question?: string
    }>
  }
}

type Step = {
  id: string
  description: string
  prompt: string
  depends: string[]
  agent: string
  write: boolean
  worktree: boolean
  provider: string
  model: string
  variant: string
  state: "pending" | "queued" | "running" | "done" | "error"
  dir: string
  session: string
  patch: string
  output: string
  error: string
  no_patch: boolean
  allow_no_patch: boolean
  updated_at?: string
  failure_stage?:
    | "worktree_setup"
    | "session_create"
    | "llm_unavailable"
    | "execution"
    | "merge_back"
    | "aborted"
    | "timeout"
    | "blocked"
}

type Run = {
  id: string
  kind: "team" | "background"
  state: "running" | "done" | "error"
  session: string
  directory: string
  created_at: string
  updated_at: string
  tasks: Step[]
}

type Seen = {
  on: boolean
  per: Map<string, { permission: string; patterns: string[]; hint: string }>
  idle: Set<string>
}

type Ctx = {
  sessionID: string
  directory: string
  worktree: string
  abort: AbortSignal
  permission: Rule[]
  metadata(input: { title?: string; metadata?: Record<string, unknown> }): void
}

function now() {
  return new Date().toISOString()
}

function slug(text: string) {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "")
}

function clip(text: string, size = 1600) {
  const data = text.trim()
  if (data.length <= size) return data
  return data.slice(0, size - 1).trimEnd() + "…"
}

function body(parts: Note[]) {
  return parts
    .filter((item): item is { type: "text"; text: string } => item.type === "text" && typeof item.text === "string")
    .map((item) => item.text.trim())
    .filter(Boolean)
    .join("\n\n")
}

function summary(parts: Note[]) {
  const text = body(parts)
  if (text) return text
  return parts
    .filter(
      (item): item is { type: "tool"; state: { status: string; output: string } } =>
        item.type === "tool" && item.state?.status === "completed" && typeof item.state.output === "string",
    )
    .map((item) => item.state.output.trim())
    .filter(Boolean)
    .join("\n\n")
}

function pick(list: Msg[], completedOnly = false) {
  const items = [...list].reverse().filter((item) => item.info.role === "assistant")
  if (!items.length) return
  const done = items.find((item) => typeof item.info.time?.completed === "number" && item.info.finish !== "tool-calls")
  return done ?? (completedOnly ? undefined : items[0])
}

function operationOnly(text: string) {
  const data = text.trim()
  if (!data) return false
  const tail = data.slice(-900)
  const operation =
    /\b(gh\s+pr|pull\s+request|pr\s+(?:create|merge|ready|close|view|check|checks)|commit|push|merge|rebase|cherry-pick)\b|プルリク|PR\s*(?:作成|マージ)|コミット|プッシュ|マージ/i
  if (!operation.test(tail)) return false
  const implementation =
    /\b(implement|implementation|build|add|fix|refactor|rewrite|patch|edit|write|modify|code)\b|修正|実装|追加|改修|編集/i
  return !implementation.test(tail)
}

function write(text: string, flag?: boolean) {
  if (typeof flag === "boolean") return flag
  return /(implement|implementation|write|edit|patch|code|fix|refactor|modify|修正|実装|編集|追加|改修)/i.test(text)
}

function direct(text: string, push = false) {
  const next = /\bopencode\s+run\s+\/init\b/i.test(text)
    ? text
        .replace(
          /\bopencode\s+run\s+\/init\b/gi,
          "perform the equivalent /init repository inspection and AGENTS.md bootstrap directly in this worktree",
        )
        .trim()
    : text.trim()
  const writeRule = push
    ? "- This is a write task. Do not stop after only a progress update or plan; inspect the files, make the requested edits, run the requested verification when possible, and then report the concrete result."
    : ""
  return `Worker execution rules:
- This worker is already running under the guardrail profile.
- Prefer file inspection tools such as Glob, Read, and Grep over bash for repository discovery whenever possible.
- Use bash only when the non-shell tools cannot answer the question or complete the step.
- Do not call the team, background, or task tools from inside this worker.
- Do not invoke nested OpenCode slash commands from inside this team worker.
- Do not create git branches, clones, nested repositories, or nested worktrees. The team tool already created the isolated worktree; edit files in the current directory directly.
- If you are running in an isolated worktree, operate only on files inside the current worktree directory. Do not read from or write to the parent repository path directly.
${writeRule}

${next}`
}

function workerTools() {
  return {
    task: false,
    team: false,
    background: false,
    team_status: false,
    question: false,
    plan_exit: false,
  }
}

function permit() {
  return [
    { permission: "*", pattern: "*", action: "allow" as const },
    { permission: "edit", pattern: "*", action: "allow" as const },
    { permission: "external_directory", pattern: "*", action: "allow" as const },
    { permission: "bash", pattern: "*", action: "allow" as const },
  ]
}

function recordModel(
  sessionID: string,
  model?: { providerID?: unknown; modelID?: unknown; id?: unknown },
  variant?: unknown,
) {
  const provider = typeof model?.providerID === "string" ? model.providerID : ""
  const id = typeof model?.modelID === "string" ? model.modelID : typeof model?.id === "string" ? model.id : ""
  if (!sessionID || !provider || !id) return
  models.set(sessionID, {
    provider,
    model: id,
    variant: typeof variant === "string" ? variant : "",
  })
}

function currentLane(sessionID: string) {
  return models.get(sessionID) ?? { provider: "zai-coding-plan", model: "glm-5.2", variant: "" }
}

function lane(_item: Pick<Step, "id" | "description" | "agent" | "prompt" | "depends">, current: Lane) {
  return {
    provider: current.provider,
    model: current.model,
    variant: current.variant,
  }
}

function root(dir: string) {
  return path.join(dir, ".opencode", "guardrails", "team-runs")
}

function file(dir: string, id: string) {
  return path.join(root(dir), `${id}.json`)
}

function patch(dir: string, run: string, id: string) {
  return path.join(root(dir), `${run}-${id}.patch`)
}

function yard(dir: string) {
  return path.join(dir, ".opencode", "team")
}

function within(root: string, file: string) {
  const rel = path.relative(root, file)
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))
}

function rebase(text: string, root: string, box: string) {
  const src = path.resolve(root)
  const dst = path.resolve(box)
  if (src === dst) return text
  return text.split(src).join(dst)
}

function rebaseForWorktree(text: string, root: string, box: string) {
  let next = rebase(text, root, box)
  const hint = worktreeHint(text)
  if (hint) next = next.split(path.resolve(hint)).join(path.resolve(box))
  return next
}

function cleanHint(text: string) {
  return text.trim().replace(/^[`'"]+|[`'",.)\]]+$/g, "")
}

function worktreeHint(text: string) {
  const direct = [
    /(?:git\s+)?worktree[\s\S]{0,120}?(?:at|path|directory|dir|:|：)[\s\S]{0,40}?`([^`\n]+)`/i,
    /(?:ワークツリー|作業ツリー)[\s\S]{0,120}?`([^`\n]+)`/i,
    /`(\/[^`\n]*\/\.worktrees\/[^`\n]+)`/i,
    /`(\/[^`\n]*\/\.opencode\/worktrees\/[^`\n]+)`/i,
  ]
  for (const rule of direct) {
    const match = text.match(rule)
    const hit = cleanHint(match?.[1] ?? "")
    if (hit && path.isAbsolute(hit)) return hit
  }
}

function expandHome(text: string) {
  if (text === "~") return process.env.HOME || text
  if (text.startsWith("~/")) return path.join(process.env.HOME || "", text.slice(2))
  return text
}

function pathHints(text: string) {
  const direct = worktreeHint(text)
  const matches = Array.from(
    text.matchAll(/(?:~\/|\/Users\/|\/Volumes\/|\/private\/|\/tmp\/|\/var\/|\/)[^\s`'")\]}]+/g),
    (item) => item[0],
  )
  return [...(direct ? [direct] : []), ...matches].map((item) =>
    expandHome(cleanHint(item).replace(/[?*].*$/, "")),
  )
}

async function existingAncestor(input: string): Promise<string | undefined> {
  for (let cur = path.resolve(input); ; cur = path.dirname(cur)) {
    if (await has(cur)) return cur
    if (path.dirname(cur) === cur) return undefined
  }
}

async function gitRootsFromText(text: string) {
  const roots: string[] = []
  for (const item of pathHints(text)) {
    const existing = await existingAncestor(item)
    if (!existing) continue
    const top = await gitTop(existing)
    if (top && !roots.includes(top)) roots.push(top)
  }
  return roots
}

async function routedProjectRoot(ctx: Pick<Ctx, "directory" | "worktree">, text: string): Promise<string | undefined> {
  const current = projectRoot(ctx.directory, ctx.worktree)
  const currentCommon = await gitCommon(current)
  const candidates: { root: string; common: string }[] = []
  for (const root of await gitRootsFromText(text)) {
    if (within(current, root)) continue
    const common = await gitCommon(root)
    if (!common || common === currentCommon) continue
    if (!candidates.some((item) => item.root === root)) candidates.push({ root, common })
  }
  const commons = new Set(candidates.map((item) => item.common))
  if (commons.size !== 1) return undefined
  const hinted = worktreeHint(text)
  if (hinted) {
    const top = await gitTop(hinted)
    const hit = candidates.find((item) => item.root === top)
    if (hit) return hit.root
  }
  return candidates[0]?.root
}

function projectRoot(directory: string, worktree: string) {
  return worktree && worktree !== "/" ? worktree : directory
}

function rootkeep(dir: string) {
  if (dir === ".opencode") {
    return [
      "agent",
      "agents",
      "command",
      "commands",
      "env.d.ts",
      "hooks",
      "node_modules",
      "opencode.json",
      "opencode.jsonc",
      "package-lock.json",
      "package.json",
      "plugin",
      "plugins",
      "rule",
      "rules",
      "skill",
      "skills",
      "themes",
      "tui.json",
      "tui.jsonc",
    ]
  }

  if (dir === ".claude") {
    return ["agents", "commands", "hooks", "settings.json", "settings.local.json", "skills"]
  }

  if (dir === ".agents") {
    return ["agents", "commands", "hooks", "skills"]
  }

  if (dir === ".cursor") {
    return ["rules"]
  }

  if (dir === ".github") {
    return ["copilot-instructions.md"]
  }

  return []
}

const runtime = [".opencode/guardrails", ".opencode/memory"]

function runtimeSpec() {
  return runtime.map((item) => `:(exclude)${item}`)
}

async function ignoredCarrySpec(dir: string, kept: string[]) {
  const roots = new Set(kept.map((item) => item.split(/[\\/]/)[0]).filter((item): item is string => Boolean(item)))
  const spec: string[] = []
  for (const root of roots) {
    const ignored = await git(dir, ["check-ignore", "-q", "--", root, `${root}/`])
    if (ignored.code === 0) spec.push(`:(exclude)${root}`, `:(exclude)${root}/**`)
  }
  return spec
}

async function workFiles(dir: string, spec: string[]) {
  const out = await git(dir, [
    "ls-files",
    "-z",
    "--modified",
    "--deleted",
    "--others",
    "--exclude-standard",
    "--",
    ".",
    ...spec,
  ])
  if (out.code !== 0) throw new Error(out.err || out.out || "Failed to list worktree changes")
  return out.out.split("\0").filter(Boolean)
}

function docs() {
  return ["AGENTS.md", "OPENCODE.md", "CLAUDE.md", "CONTEXT.md"]
}

function roots() {
  return [".opencode", ".claude", ".agents", ".cursor", ".github"]
}

function workspaceRuntime() {
  return ["node_modules", ".pnpm-store", ".yarn", ".pnp.cjs", ".pnp.loader.mjs"]
}

async function has(file: string) {
  return lstat(file)
    .then(() => true)
    .catch(() => false)
}

async function graft(src: string, dst: string) {
  const stat = await lstat(src).catch(() => undefined)
  if (!stat || (await has(dst))) return false

  const kind = stat.isDirectory() ? (process.platform === "win32" ? "junction" : "dir") : "file"
  const link = stat.isSymbolicLink() ? await readlink(src) : src
  const made = await symlink(link, dst, kind as Parameters<typeof symlink>[2])
    .then(() => true)
    .catch(() => false)
  if (made) return true

  return cp(src, dst, {
    recursive: stat.isDirectory(),
    force: false,
    errorOnExist: true,
  })
    .then(() => true)
    .catch(() => false)
}

async function carry(root: string, dir: string, next: string) {
  const base = path.resolve(root)
  const cwd = path.resolve(dir)
  if (!within(base, cwd)) throw new Error(`Cannot prepare team worktree: directory is outside worktree (${dir})`)

  const kept: string[] = []
  for (let cur = dir; ; cur = path.dirname(cur)) {
    const rel = path.relative(root, cur)

    for (const name of docs()) {
      const file = path.join(next, rel, name)
      if (await graft(path.join(cur, name), file)) {
        kept.push(path.relative(next, file))
      }
    }

    for (const base of roots()) {
      const src = path.join(cur, base)
      if (await has(src)) {
        const dst = path.join(next, rel, base)
        await mkdir(dst, { recursive: true })
        for (const name of rootkeep(base)) {
          const file = path.join(dst, name)
          if (await graft(path.join(src, name), file)) {
            kept.push(path.relative(next, file))
          }
        }
      }
    }

    if (cur === root) {
      for (const name of workspaceRuntime()) {
        const file = path.join(next, name)
        if (await graft(path.join(root, name), file)) {
          kept.push(path.relative(next, file))
        }
      }
    }

    if (cur === root || path.dirname(cur) === cur) return kept
  }
}

function isRun(data: unknown): data is Run {
  if (!data || typeof data !== "object") return false
  if (!("id" in data) || !("kind" in data) || !("tasks" in data)) return false
  return Array.isArray((data as { tasks?: unknown }).tasks)
}

async function git(dir: string, args: string[]) {
  const proc = Bun.spawn(["git", "-C", dir, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  })
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { out, err, code }
}

async function gitTop(dir: string) {
  const out = await git(dir, ["rev-parse", "--show-toplevel"])
  if (out.code !== 0) return
  const top = out.out.trim()
  if (!top) return
  return realpath(top).catch(() => path.resolve(top))
}

async function gitCommon(dir: string) {
  const out = await git(dir, ["rev-parse", "--path-format=absolute", "--git-common-dir"])
  if (out.code !== 0) return
  const common = out.out.trim()
  if (!common) return
  return realpath(common).catch(() => path.resolve(common))
}

async function hasPopulatedFiles(dir: string) {
  const out = await git(dir, ["ls-files", "-z"])
  if (out.code !== 0) throw new Error(out.err || out.out || "Failed to inspect worktree files")
  const files = out.out.split("\0").filter(Boolean)
  if (!files.length) return false
  for (const file of files) {
    if (await has(path.join(dir, file))) return true
  }
  return false
}

async function externalWorktree(root: string, prompt: string) {
  const hint = worktreeHint(prompt)
  if (!hint) return
  const target = await gitTop(hint)
  if (!target) return
  const base = await gitTop(root)
  if (!base) return
  if (target === base) return
  const [baseCommon, targetCommon] = await Promise.all([gitCommon(base), gitCommon(target)])
  if (!baseCommon || !targetCommon || baseCommon !== targetCommon) return
  return target
}

async function save(dir: string, run: Run) {
  live.set(run.id, run)
  await mkdir(root(dir), { recursive: true })
  await Bun.write(file(dir, run.id), JSON.stringify(run, null, 2) + "\n")
}

async function load(dir: string, id: string) {
  const data = await Bun.file(file(dir, id))
    .json()
    .catch(() => undefined)
  return isRun(data) ? data : undefined
}

async function scan(dir: string) {
  await mkdir(root(dir), { recursive: true })
  const list = await readdir(root(dir)).catch(() => [])
  return Promise.all(
    list
      .filter((item) => item.endsWith(".json"))
      .map((item) =>
        Bun.file(path.join(root(dir), item))
          .json()
          .catch(() => undefined),
      ),
  ).then((list) => list.filter(isRun).toSorted((a, b) => String(b.updated_at).localeCompare(String(a.updated_at))))
}

async function yardadd(dir: string, id: string) {
  const repo = await git(dir, ["rev-parse", "--show-toplevel"])
  if (repo.code !== 0) {
    throw new Error(`Cannot create worktree: ${dir} is not a git repository.`)
  }

  const top = await realpath(repo.out.trim()).catch(() => path.resolve(repo.out.trim() || dir))
  const cwd = await realpath(dir).catch(() => path.resolve(dir))
  if (!within(top, cwd)) {
    throw new Error(`Cannot create worktree: ${dir} is outside git root ${top}.`)
  }

  const base = path.resolve(yard(cwd))
  const next = path.join(base, slug(id) || "task")
  if (!within(base, next)) {
    throw new Error(`Cannot create worktree outside ${base}.`)
  }

  const drop = async () => {
    await git(cwd, ["worktree", "remove", "--force", next]).catch(() => {})
    await rm(next, { force: true, recursive: true }).catch(() => {})
  }

  await mkdir(base, { recursive: true })

  // Verify repository has commits
  const head = await git(cwd, ["rev-parse", "--verify", "HEAD"])
  if (head.code !== 0) {
    throw new Error("Cannot create worktree: repository has no commits. Create an initial commit first.")
  }

  // Step 1: Create worktree without checking out files (upstream pattern)
  const made = await git(cwd, ["worktree", "add", "--detach", "--no-checkout", next, "HEAD"])
  if (made.code !== 0) {
    await drop()
    throw new Error(made.err || made.out || "Failed to create git worktree")
  }

  // Step 2: Hard reset to populate working directory (upstream pattern)
  const populated = await git(next, ["reset", "--hard"])
  if (populated.code !== 0) {
    await drop()
    throw new Error(`Worktree created but population failed: ${populated.err || populated.out}`)
  }

  // Step 3: Verify files are actually present in the working directory.
  // Some git/sandbox combinations can leave only metadata after add --no-checkout.
  if (!(await hasPopulatedFiles(next))) {
    const checkout = await git(next, ["checkout", "-f", "HEAD", "--", "."])
    if (checkout.code !== 0) {
      await drop()
      throw new Error(`Worktree created but checkout failed: ${checkout.err || checkout.out}`)
    }
  }

  if (!(await hasPopulatedFiles(next))) {
    await drop()
    throw new Error("Worktree is empty after checkout — cannot proceed with delegation")
  }

  return next
}

async function yardrm(dir: string, item: string) {
  const base = path.resolve(yard(dir))
  const next = path.resolve(item)
  if (!within(base, next)) return
  await git(dir, ["worktree", "remove", "--force", next])
  await rm(next, { force: true, recursive: true }).catch(() => {})
}

async function merge(dir: string, item: string, run: string, id: string, kept: string[] = []) {
  let next = ""
  try {
    await Promise.all(
      kept.map((file) => rm(path.join(item, file), { force: true, recursive: true }).catch(() => undefined)),
    )
    const spec = [...runtimeSpec(), ...(await ignoredCarrySpec(item, kept))]
    // Stage all worker-owned files while excluding runtime state that is created locally during execution.
    const files = await workFiles(item, spec)
    if (!files.length) return { patch: "", merged: true }
    const add = await git(item, ["add", "-A", "--", ...files])
    if (add.code !== 0) throw new Error(add.err || add.out || "Failed to stage worktree changes")
    const changed = await git(item, [
      "diff",
      "--cached",
      "--name-only",
      "-z",
      "--diff-filter=ACDMRTUXB",
      "--",
      ...files,
    ])
    if (changed.code !== 0) throw new Error(changed.err || changed.out || "Failed to list worktree changes")
    const staged = changed.out.split("\0").filter(Boolean)
    if (!staged.length) return { patch: "", merged: true }
    const diff = await git(item, ["diff", "--cached", "--binary", "--", ...staged])
    if (diff.code !== 0) throw new Error(diff.err || diff.out || "Failed to read worktree diff")
    next = patch(dir, run, id)
    await Bun.write(next, diff.out)
    const overlap = await dirtyOverlap(dir, staged)
    if (overlap.length) {
      return {
        patch: next,
        merged: false,
        error:
          `Parent worktree has uncommitted changes in worker-touched file(s): ${overlap.join(", ")}. ` +
          `Worker patch was saved at ${next}; commit or stash the parent edits, then apply the patch manually or rerun the task.`,
      }
    }
    const out = await git(dir, ["apply", "--3way", next])
    if (out.code !== 0) return { patch: next, merged: false, error: out.err || out.out || "Failed to apply patch" }
    // [Phase6] Post-merge verification: confirm patch applied cleanly
    const verification: { ok: boolean; issues: string[] } = { ok: true, issues: [] }
    try {
      const diffStat = await git(dir, ["diff", "--stat", "HEAD"])
      if (!diffStat.out.trim() && diff.out.trim()) {
        verification.ok = false
        verification.issues.push("Patch was non-empty but no diff detected after apply")
      }
      const status = await git(dir, ["status", "--porcelain"])
      const untracked = status.out
        .trim()
        .split("\n")
        .filter((l: string) => l.startsWith("??")).length
      if (untracked > 5) {
        verification.issues.push(`${untracked} untracked files after merge — check for stale artifacts`)
      }
    } catch {
      /* verification is advisory */
    }
    // Auto-commit only the files produced by the worker patch so unrelated parent edits stay untouched.
    try {
      if (staged.length > 0) {
        await git(dir, ["add", "--", ...staged])
        const commitMsg = `chore(team): apply worker changes from task ${id}`
        const commit = await git(dir, ["commit", "-m", commitMsg])
        if (commit.code !== 0 && !commit.err.includes("nothing to commit")) {
          verification.issues.push(`Auto-commit failed: ${commit.err || commit.out}`)
        }
      }
    } catch {
      /* auto-commit is best-effort; parent session can still commit manually */
    }
    return { patch: next, merged: true, verification }
  } finally {
    await yardrm(dir, item).catch(() => {})
  }
}

async function dirtyOverlap(dir: string, files: string[]) {
  if (!files.length) return []
  const checks = await Promise.all([
    git(dir, ["diff", "--name-only", "-z", "--", ...files]),
    git(dir, ["diff", "--cached", "--name-only", "-z", "--", ...files]),
    git(dir, ["ls-files", "--others", "--exclude-standard", "-z", "--", ...files]),
  ])
  const dirty = new Set<string>()
  for (const item of checks) {
    if (item.code !== 0) continue
    for (const file of item.out.split("\0").filter(Boolean)) dirty.add(file)
  }
  return files.filter((file) => dirty.has(file))
}

export function resolveIdleTimeout(
  input: {
    write?: boolean
    provider?: string
    model?: string
    env?: NodeJS.ProcessEnv
  } = {},
) {
  const env = input.env ?? process.env
  const explicit = Number(env.OPENCODE_TEAM_IDLE_TIMEOUT_MS)
  if (Number.isFinite(explicit) && explicit > 0) return explicit

  const provider = (input.provider ?? "").toLowerCase()
  const model = (input.model ?? "").toLowerCase()
  const providerKey = provider.replace(/[^a-z0-9]+/gi, "_").toUpperCase()
  if (providerKey) {
    const scoped = Number(env[`OPENCODE_TEAM_IDLE_TIMEOUT_MS_${providerKey}`])
    if (Number.isFinite(scoped) && scoped > 0) return scoped
  }

  // deepseek implementers routinely exceed 600s on multi-file write tasks
  if (provider === "deepseek" || model.includes("deepseek")) return DEFAULT_TEAM_WRITE_IDLE_TIMEOUT_MS

  if (input.write === true) {
    const write = Number(env.OPENCODE_TEAM_WRITE_IDLE_TIMEOUT_MS)
    if (Number.isFinite(write) && write > 0) return write
    return DEFAULT_TEAM_WRITE_IDLE_TIMEOUT_MS
  }

  return DEFAULT_TEAM_READ_IDLE_TIMEOUT_MS
}

export function formatTimeoutProgress(messages: Msg[], statusLabel: string) {
  const bits = [statusLabel]
  const assistant = [...messages].reverse().find((item) => item.info.role === "assistant")
  if (!assistant) return bits.join("; ")
  const tool = [...assistant.parts].reverse().find((item) => item.type === "tool")
  if (tool) bits.push(`last_tool=${tool.state?.status || "pending"}`)
  const text = body(assistant.parts)
  if (text) bits.push(`last_text=${clip(text, 120)}`)
  return bits.join("; ")
}

async function idle(
  client: Client,
  id: string,
  dir: string,
  abort: AbortSignal,
  opts: { write?: boolean; provider?: string; model?: string } = {},
) {
  const started = Date.now()
  const timeout = resolveIdleTimeout(opts)
  let last = "starting"
  const hit = mark(client)
  if (process.env.DEBUG_TEAM) {
    console.log("idle.begin", id, hit.idle.has(id), hit.per.size, hit.on, timeout)
  }
  for (;;) {
    if (abort.aborted) throw new Error("Aborted")
    if (hit.idle.has(id)) return
    const blocked = await wait(client, id, dir)
    if (blocked) throw new Error(blocked)
    const done = await snap(client, id, dir, true)
    if (done.completed) return
    if (Date.now() - started > timeout) {
      const list = await client.session.messages({ path: { id }, query: { directory: dir } }).catch(() => ({ data: [] }))
      const progress = formatTimeoutProgress(list.data ?? [], last)
      throw new Error(
        `Timed out waiting for worker session ${id} after ${Math.round(timeout / 1000)}s (${progress}). ` +
          `Raise OPENCODE_TEAM_IDLE_TIMEOUT_MS (or OPENCODE_TEAM_IDLE_TIMEOUT_MS_<PROVIDER>) to extend the hard wait ceiling.`,
      )
    }
    const stat = await client.session.status({
      query: {
        directory: dir,
      },
    })
    const item = stat.data?.[id]
    if (!item) {
      last = "status missing"
      if (hit.idle.has(id)) return
      await Bun.sleep(gap)
      continue
    }
    last = `status ${item.type}`
    if (item.type === "idle") return
    await Bun.sleep(gap)
  }
}

async function snap(client: Client, id: string, dir: string, completedOnly = false) {
  if (process.env.DEBUG_TEAM) {
    console.log("snap.call", id, completedOnly, dir)
  }
  const list = await client.session.messages({
    path: { id },
    query: { directory: dir },
  })
  const msg = pick(list.data ?? [], completedOnly)
  if (!msg || msg.info.role !== "assistant") return { text: "", error: "", completed: false }
  const out = summary(msg.parts)
  const err = msg.info.error?.data?.message ?? ""
  return { text: clip(out), error: err, completed: typeof msg.info.time?.completed === "number" }
}

function stage(err: string): Step["failure_stage"] {
  return /(model not found|api key|apikey|auth|unauthorized|forbidden|provider|llm|language model|no such model|invalid model|quota|rate limit)/i.test(
    err,
  )
    ? "llm_unavailable"
    : /blocked on (permission|question)/i.test(err)
      ? "blocked"
      : /abort/i.test(err)
        ? "aborted"
        : /timeout|timed out/i.test(err)
          ? "timeout"
          : "execution"
}

function why(item: Step | undefined, err: string): Step["failure_stage"] {
  return !item?.dir
    ? "worktree_setup"
    : !item?.session
      ? "session_create"
      : /merge|patch|apply/.test(err)
        ? "merge_back"
        : stage(err)
}

function fail(run: Run, err: string, id?: string) {
  const text = err || "Unknown error"
  run.tasks
    .filter((item) => item.state === "pending" || item.state === "queued" || item.state === "running")
    .forEach((item) => {
      todo(run, item.id, {
        state: "error",
        error: item.error || text,
        failure_stage: item.failure_stage || (item.id === id ? why(item, text) : stage(text)),
      })
    })
  run.state = "error"
  run.updated_at = now()
}

async function reconcile(client: Client, dir: string, run: Run) {
  if (run.state !== "running") return run
  let changed = false
  for (const item of run.tasks) {
    if (item.state !== "running" || !item.session || !item.dir) continue
    const blocked = await wait(client, item.session, item.dir)
    if (blocked) {
      todo(run, item.id, {
        state: "error",
        error: blocked,
        failure_stage: "blocked",
      })
      changed = true
      continue
    }
    const out = await snap(client, item.session, item.dir, true)
    if (!out.completed) continue
    todo(run, item.id, {
      state: out.error ? "error" : "done",
      output: out.text,
      error: out.error,
      failure_stage: out.error ? stage(out.error) : undefined,
    })
    changed = true
  }
  if (run.tasks.every((item) => item.state === "done" || item.state === "error")) {
    run.state = run.tasks.some((item) => item.state === "error") ? "error" : "done"
    run.updated_at = now()
    changed = true
  }
  if (changed) await save(dir, run)
  return run
}

async function sweep(client: Client, dir: string) {
  const active = sweeping.get(dir)
  if (active) return active
  const task = (async () => {
    const list = await scan(dir)
    const running = list.filter((item) => item.state === "running")
    if (!running.length) return
    await Promise.all(running.map((item) => reconcile(client, dir, item)))
  })()
    .catch(() => undefined)
    .finally(() => {
      if (sweeping.get(dir) === task) sweeping.delete(dir)
    })
  sweeping.set(dir, task)
  return task
}

async function bounded<T>(task: Promise<T>, millis: number) {
  return Promise.race([task, Bun.sleep(millis).then(() => undefined)])
}

async function presweep(client: Client, dir: string) {
  await bounded(sweep(client, dir), sweepWait)
}

function note(run: Run) {
  const head = [`run_id: ${run.id}`, `type: ${run.kind}`, `state: ${run.state}`]
  const list = run.tasks.map((item) =>
    [
      `- ${item.id}: ${item.state}`,
      item.agent ? `agent=${item.agent}` : "",
      item.provider && item.model ? `model=${item.provider}/${item.model}` : "",
      item.variant ? `variant=${item.variant}` : "",
      item.session ? `session=${item.session}` : "",
      item.dir ? `dir=${item.dir}` : "",
      item.patch ? `patch=${item.patch}` : "",
      item.no_patch ? "no_patch=true" : "",
      item.failure_stage ? `failure_stage=${item.failure_stage}` : "",
      item.error ? `error=${clip(item.error, 240)}` : "",
      item.output ? `output=${clip(item.output, 240)}` : "",
    ]
      .filter(Boolean)
      .join(" "),
  )
  return [...head, "", ...list].join("\n").trim()
}

function defs(list: { id: string; depends?: string[] }[]) {
  const ids = new Set<string>()
  for (const item of list) {
    if (ids.has(item.id)) throw new Error(`Duplicate task id: ${item.id}`)
    ids.add(item.id)
  }
  for (const item of list) {
    const deps = item.depends ?? []
    for (const dep of deps) {
      if (!ids.has(dep)) throw new Error(`Unknown dependency: ${dep}`)
      if (dep === item.id) throw new Error(`Task ${item.id} cannot depend on itself`)
    }
  }
}

function todo(run: Run, id: string, data: Partial<Step>) {
  const next = run.tasks.find((item) => item.id === id)
  if (process.env.DEBUG_TEAM) {
    console.log("todo", run.id, id, data.state, data.error || "", data.dir || "")
  }
  if (!next) return
  Object.assign(next, data, { updated_at: now() })
  run.updated_at = now()
}

function mark(client: Client) {
  const key = client as object
  const hit = seen.get(key)
  if (hit) return hit
  const next: Seen = {
    on: false,
    per: new Map(),
    idle: new Set(),
  }
  seen.set(key, next)
  if (!client.event?.subscribe) return next
  next.on = true
  void (async () => {
    for (;;) {
      const sub = await client.event?.subscribe().catch(() => undefined)
      if (!sub?.stream) {
        await Bun.sleep(gap)
        continue
      }
      try {
        for await (const evt of sub.stream) {
          if (evt.type === "permission.updated" || evt.type === "permission.asked") {
            const props = evt.properties ?? {}
            const session = typeof props.sessionID === "string" ? props.sessionID : ""
            if (!session) continue
            const permission =
              typeof props.permission === "string"
                ? props.permission
                : typeof props.type === "string"
                  ? props.type
                  : "unknown"
            const raw = props.patterns ?? props.pattern
            const patterns = Array.isArray(raw)
              ? raw.filter((item): item is string => typeof item === "string")
              : typeof raw === "string"
                ? [raw]
                : []
            const label =
              typeof props.title === "string" && props.title
                ? props.title
                : typeof props.description === "string"
                  ? props.description
                  : ""
            const title = label ? ` (${label})` : ""
            next.per.set(session, { permission, patterns, hint: title })
          }
          if (evt.type === "permission.replied") {
            const props = evt.properties ?? {}
            const session = typeof props.sessionID === "string" ? props.sessionID : ""
            if (!session) continue
            next.per.delete(session)
          }
          if (evt.type === "session.idle") {
            const props = evt.properties ?? {}
            const session = typeof props.sessionID === "string" ? props.sessionID : ""
            if (!session) continue
            next.idle.add(session)
          }
        }
      } catch {
        await Bun.sleep(gap)
      }
    }
  })().catch(() => {})
  return next
}

async function wait(client: Client, id: string, dir: string) {
  const hit = mark(client)
  if (process.env.DEBUG_TEAM) {
    console.log("wait.call", id, dir, "cached?", hit.per.has(id), "idle?", hit.idle.has(id))
  }
  const perm = await client.permission?.list?.({ directory: dir }).catch(() => ({
    data: [] as { sessionID: string; permission: string; patterns: string[]; metadata?: Record<string, unknown> }[],
  }))
  const blocked = perm?.data?.find((item) => item.sessionID === id)
  if (blocked) {
    const meta = blocked.metadata?.description
    const hint = typeof meta === "string" && meta ? ` (${meta})` : ""
    const out = `Blocked on permission: ${blocked.permission}${hint} :: ${blocked.patterns.join(" | ")}`
    if (process.env.DEBUG_TEAM) console.log("wait.blocked", out)
    return out
  }
  const local = client.session.permission?.(id)?.[0]
  if (local?.permission) {
    const meta = local.metadata?.description
    const hint = typeof meta === "string" && meta ? ` (${meta})` : ""
    return `Blocked on permission: ${local.permission}${hint} :: ${(local.patterns ?? []).join(" | ")}`
  }
  const hold = hit.per.get(id)
  if (hold) {
    return `Blocked on permission: ${hold.permission}${hold.hint} :: ${hold.patterns.join(" | ")}`
  }
  const localState = (await Bun.file(path.join(dir, ".opencode", "guardrails", "state.json"))
    .json()
    .catch(() => undefined)) as { last_event?: unknown; last_permission?: unknown; last_patterns?: unknown } | undefined
  if (localState?.last_event === "permission.asked" && typeof localState.last_permission === "string") {
    const patterns = Array.isArray(localState.last_patterns)
      ? localState.last_patterns.filter((item): item is string => typeof item === "string")
      : []
    return `Blocked on permission: ${localState.last_permission} :: ${patterns.join(" | ")}`
  }
  const ask = await client.question
    ?.list?.({ directory: dir })
    .catch(() => ({ data: [] as { sessionID: string; questions: { question: string; header: string }[] }[] }))
  const asked = ask?.data?.find((item) => item.sessionID === id)
  if (asked) {
    const text = asked.questions.map((item) => `${item.header}: ${item.question}`).join(" | ")
    return `Blocked on question: ${text}`
  }
  const quiz = client.session.question?.(id)
  if (quiz?.length) {
    return `Blocked on question: ${quiz.map((item) => `${item.header ?? ""}: ${item.question ?? ""}`).join(" | ")}`
  }
}

async function stop(client: Client, run: Run) {
  await Promise.all(
    run.tasks
      .filter((item) => item.session !== "" && item.dir !== "")
      .map((item) =>
        client.session.abort({
          path: { id: item.session },
          query: { directory: item.dir },
        }),
      ),
  ).catch(() => undefined)
}

export default async function team(input: { client: Client; worktree: string; directory: string }) {
  const inputRoot = projectRoot(input.directory, input.worktree)
  void sweep(input.client, inputRoot)
  const job = async (ctx: Ctx, run: Run, item: Step) => {
    const runRoot = projectRoot(ctx.directory, ctx.worktree)
    const repoRoot = ctx.worktree && ctx.worktree !== "/" ? ctx.worktree : undefined
    const push = write(item.prompt, item.write)
    let useWorktree = false
    let box = ctx.directory
    let kept: string[] = []
    let child = ""

    try {
      const target = repoRoot && push ? await externalWorktree(repoRoot, item.prompt) : undefined
      const useExistingWorktree = push && item.worktree && !!target
      useWorktree = push && item.worktree && !!repoRoot && !useExistingWorktree
      const mergeWorktree = push && item.worktree && !!repoRoot

      if (useExistingWorktree && target) {
        box = target
      } else if (useWorktree && repoRoot) {
        box = await yardadd(repoRoot, `${run.id}-${item.id}`)
        kept = await carry(repoRoot, ctx.directory, box)
      }
      const prompt = direct(
        mergeWorktree && repoRoot ? rebaseForWorktree(item.prompt, repoRoot, box) : item.prompt,
        push,
      )

      if (process.env.DEBUG_TEAM) console.log("job.start", run.id, item.id)
      todo(run, item.id, {
        state: "running",
        dir: box,
      })
      await save(runRoot, run)
      if (process.env.DEBUG_TEAM) console.log("job.saved.running", run.id, item.id)

      const next = await input.client.session.create({
        body: {
          parentID: ctx.sessionID,
          title: item.description,
          permission: ctx.permission,
        },
        query: {
          directory: box,
        },
      })
      if (process.env.DEBUG_TEAM) console.log("job.created", run.id, item.id, next?.data?.id)
      child = next.data.id

      todo(run, item.id, {
        session: child,
      })
      await save(runRoot, run)
      if (process.env.DEBUG_TEAM) console.log("job.saved.session", run.id, item.id, child)

      await input.client.session.promptAsync({
        path: { id: child },
        query: {
          directory: box,
        },
        body: {
          agent: item.agent || undefined,
          model: {
            providerID: item.provider,
            modelID: item.model,
          },
          tools: workerTools(),
          variant: item.variant || undefined,
          parts: [
            {
              type: "text",
              text: prompt,
            },
          ],
        },
      })
      if (process.env.DEBUG_TEAM) console.log("job.prompted", run.id, item.id)

      await idle(input.client, child, box, ctx.abort, {
        write: item.write,
        provider: item.provider,
        model: item.model,
      })
      if (process.env.DEBUG_TEAM) console.log("job.idle-return", run.id, item.id)
      const out = await snap(input.client, child, box)
      if (process.env.DEBUG_TEAM) console.log("job.snapped", run.id, item.id, out.completed)

      let patchfile = ""
      let err = out.error
      // [Phase6] Classify failure stage for abort reason tracking
      let failure_stage: Step["failure_stage"] = undefined
      if (!err && mergeWorktree && repoRoot && box !== ctx.directory) {
        const merged = await merge(repoRoot, box, run.id, item.id, kept)
        patchfile = merged.patch
        if (!merged.merged) {
          err = merged.error || "Failed to merge worktree patch"
          failure_stage = "merge_back"
        } else if (item.write && patchfile === "" && !item.allow_no_patch) {
          err = "Write task completed without producing a patch"
          failure_stage = "execution"
        }
      }
      if (err && !failure_stage) failure_stage = stage(err)

      todo(run, item.id, {
        state: err ? "error" : "done",
        patch: patchfile,
        no_patch: !err && item.write && mergeWorktree && patchfile === "",
        output: out.text,
        error: err,
        failure_stage: err ? failure_stage : undefined,
      })
      if (process.env.DEBUG_TEAM) console.log("job.done", run.id, item.id, err ? "error" : "done")
      await save(runRoot, run)
      if (err) throw new Error(err)
      return out.text
    } catch (err) {
      const text = err instanceof Error ? err.message : String(err)
      const current = run.tasks.find((step) => step.id === item.id)
      if (current && current.state !== "error") {
        todo(run, item.id, {
          state: "error",
          error: text,
          failure_stage: current.failure_stage || why(current, text),
        })
        await save(runRoot, run).catch(() => undefined)
      }
      throw err
    } finally {
      if (useWorktree && repoRoot && box !== ctx.directory) {
        await yardrm(repoRoot, box).catch(() => {})
      }
    }
  }

  const team = tool({
    description:
      "Launch parallel worker sessions, wait for fan-in, and merge isolated write-task patches back into the current worktree.",
    args: {
      strategy: z.enum(["parallel", "wave"]).optional().default("parallel"),
      limit: z.number().int().min(1).max(12).optional().default(cap),
      tasks: z.array(
        z.object({
          id: z.string(),
          description: z.string().optional(),
          agent: z.string().optional(),
          prompt: z.string(),
          depends: z.array(z.string()).optional(),
          write: z.boolean().optional(),
          worktree: z.boolean().optional(),
          no_patch: z.boolean().optional(),
        }),
      ),
    },
    async execute(args, ctx) {
      const route = await routedProjectRoot(
        ctx,
        args.tasks.map((item) => `${item.description ?? item.id}\n${item.prompt}`).join("\n"),
      )
      const exec = route ? { ...ctx, directory: route, worktree: route } : ctx
      const runRoot = projectRoot(exec.directory, exec.worktree)
      const canIsolate = Boolean(exec.worktree && exec.worktree !== "/")
      const strategy = args.strategy ?? "parallel"
      const limit = args.limit ?? cap
      const runAbort = new AbortController()
      defs(args.tasks)
      if (args.tasks.length < 1) throw new Error("team requires at least one task")
      const run: Run = {
        id: crypto.randomUUID(),
        kind: "team",
        state: "running",
        session: ctx.sessionID,
        directory: exec.directory,
        created_at: now(),
        updated_at: now(),
        tasks: args.tasks.map((item) => {
          const pick = lane(
            {
              id: item.id,
              description: item.description || item.id,
              prompt: item.prompt,
              depends: item.depends ?? [],
              agent: item.agent || "",
            },
            currentLane(ctx.sessionID),
          )
          return {
            id: item.id,
            description: item.description || item.id,
            prompt: item.prompt,
            depends: item.depends ?? [],
            agent: item.agent || "",
            write: write(item.prompt, item.write),
            worktree: canIsolate && item.worktree !== false,
            provider: pick.provider,
            model: pick.model,
            variant: pick.variant,
            state: "pending",
            dir: "",
            session: "",
            patch: "",
            no_patch: false,
            allow_no_patch: item.no_patch === true || operationOnly(item.prompt),
            output: "",
            error: "",
          }
        }),
      }
      await save(runRoot, run)
      ctx.metadata({
        title: "team run",
        metadata: {
          run_id: run.id,
          tasks: args.tasks.length,
          strategy,
          ...(route ? { routed_project: route } : {}),
        },
      })
      await presweep(input.client, runRoot)
      const req = {
        ...exec,
        abort: runAbort.signal,
        permission: permit(),
      }

      const done = new Set<string>()
      const list = run.tasks
      const active = new Map<string, Promise<void>>()

      const launch = (item: Step) => {
        const task = job(req, run, item)
          .then(() => {
            done.add(item.id)
          })
          .finally(() => {
            active.delete(item.id)
          })
        active.set(item.id, task)
        return task
      }

      try {
        for (;;) {
          const ready = list.filter(
            (item) => item.state === "pending" && item.depends.every((dep) => done.has(dep)) && !active.has(item.id),
          )

          if (strategy === "wave" && ready.length) {
            ready.forEach((item) => todo(run, item.id, { state: "queued" }))
            await save(runRoot, run)
            await Promise.all(ready.map((item) => launch(item)))
          } else {
            ready.slice(0, Math.max(limit - active.size, 0)).forEach((item) => {
              todo(run, item.id, { state: "queued" })
              void launch(item)
            })
            if (!active.size && done.size !== list.length) {
              const wait = list.filter((item) => item.state === "pending").map((item) => item.id)
              throw new Error(`Dependency deadlock: ${wait.join(", ")}`)
            }
            if (active.size) await Promise.race(active.values())
          }

          if (done.size === list.length) break
          await save(runRoot, run)
        }
      } catch (err) {
        const item =
          run.tasks.find((item) => item.state === "error") ??
          run.tasks.find((item) => item.state === "running" || item.state === "queued")
        fail(run, err instanceof Error ? err.message : String(err), item?.id)
        await save(runRoot, run)
        await stop(input.client, run)
        throw err
      }

      run.state = run.tasks.some((item) => item.state === "error") ? "error" : "done"
      run.updated_at = now()
      await save(runRoot, run)
      return note(run)
    },
  })

  const background = tool({
    description:
      "Spawn a background worker session that can continue after the current turn and optionally notify the parent session when it completes.",
    args: {
      description: z.string().optional(),
      agent: z.string().optional(),
      prompt: z.string(),
      write: z.boolean().optional(),
      worktree: z.boolean().optional(),
      notify: z.boolean().optional().default(true),
    },
    async execute(args, ctx) {
      const route = await routedProjectRoot(ctx, `${args.description ?? ""}\n${args.prompt}`)
      const exec = route ? { ...ctx, directory: route, worktree: route } : ctx
      const runRoot = projectRoot(exec.directory, exec.worktree)
      const canIsolate = Boolean(exec.worktree && exec.worktree !== "/")
      const detachedAbort = new AbortController()
      const step: Step = {
        id: slug(args.description || args.agent || "worker") || "worker",
        description: args.description || "background worker",
        prompt: args.prompt,
        depends: [],
        agent: args.agent || "",
        write: write(args.prompt, args.write),
        worktree: canIsolate && args.worktree !== false,
        state: "pending",
        dir: "",
        session: "",
        patch: "",
        no_patch: false,
        allow_no_patch: operationOnly(args.prompt),
        output: "",
        error: "",
        ...lane(
          {
            id: slug(args.description || args.agent || "worker") || "worker",
            description: args.description || "background worker",
            prompt: args.prompt,
            depends: [],
            agent: args.agent || "",
          },
          currentLane(ctx.sessionID),
        ),
      }
      const run: Run = {
        id: crypto.randomUUID(),
        kind: "background",
        state: "running",
        session: ctx.sessionID,
        directory: exec.directory,
        created_at: now(),
        updated_at: now(),
        tasks: [step],
      }
      await save(runRoot, run)
      ctx.metadata({
        title: args.description || "background run",
        metadata: {
          run_id: run.id,
          ...(route ? { routed_project: route } : {}),
        },
      })
      await presweep(input.client, runRoot)
      const req = {
        ...exec,
        abort: detachedAbort.signal,
        permission: permit(),
      }

      const task = job(req, run, step)
        .then(async () => {
          run.state = "done"
          run.updated_at = now()
          await save(runRoot, run)
          if (!args.notify) return
          await input.client.session.prompt({
            path: { id: req.sessionID },
            query: {
              directory: ctx.directory,
            },
            body: {
              noReply: true,
              parts: [
                {
                  type: "text",
                  text: `Background run ${run.id} completed.\n\n${note(run)}`,
                },
              ],
            },
          })
        })
        .catch(async (err: Error) => {
          const item =
            run.tasks.find((item) => item.state === "error" || item.state === "running" || item.state === "queued") ||
            run.tasks[0]
          fail(run, err.message || "Unknown error", item?.id)
          await save(runRoot, run)
          if (!args.notify) return
          await input.client.session.prompt({
            path: { id: req.sessionID },
            query: {
              directory: ctx.directory,
            },
            body: {
              noReply: true,
              parts: [
                {
                  type: "text",
                  text: `Background run ${run.id} failed at stage: ${run.tasks.find((item) => item.state === "error")?.failure_stage || "execution"}.\n\n${err.message || "Unknown error"}\n\n${note(run)}`,
                },
              ],
            },
          })
        })
      Background.add(ctx.directory, task)
      await Promise.race([task.catch(() => {}), new Promise((ok) => setTimeout(ok, gap))])

      return note(run)
    },
  })

  const team_status = tool({
    description: "Show tracked team/background orchestration runs for the current project.",
    args: {
      run_id: z.string().optional(),
    },
    async execute(args, ctx) {
      const runRoot = projectRoot(ctx.directory, ctx.worktree)
      await presweep(input.client, runRoot)
      const list = args.run_id
        ? [live.get(args.run_id) ?? (await load(runRoot, args.run_id))].filter(isRun)
        : await scan(runRoot)
      const settled = await Promise.all(list.map((item) => reconcile(input.client, runRoot, item)))
      if (!settled.length) return "No team runs found."
      return settled.map((item) => note(item)).join("\n\n")
    },
  })

  return {
    tool: {
      team,
      background,
      team_status,
    },
    "chat.message": async (
      item: {
        sessionID: string
        agent?: string
        model?: {
          providerID: string
          modelID: string
        }
        variant?: string
      },
      out: {
        message: {
          id: string
          sessionID: string
          role: string
        }
        parts: Note[]
      },
    ) => {
      void sweep(input.client, inputRoot)
      recordModel(item.sessionID, item.model, item.variant)
      if (out.message.role !== "user") return
    },
    "chat.params": async (item: {
      sessionID: string
      model: { providerID?: unknown; modelID?: unknown; id?: unknown }
      message: { model?: { variant?: unknown } }
    }) => {
      recordModel(item.sessionID, item.model, item.message.model?.variant)
    },
    "tool.execute.before": async (
      item: {
        tool: string
        sessionID: string
      },
      out: {
        args: Record<string, unknown>
      },
    ) => {
      void sweep(input.client, inputRoot)
      void item
      void out
    },
    "tool.execute.after": async (
      item: {
        tool: string
        sessionID: string
      },
      _out: {
        title: string
        output: string
        metadata: Record<string, unknown>
      },
    ) => {
      void sweep(input.client, inputRoot)
      void item
      void _out
    },
    "tool.execute.error": async (
      item: {
        tool: string
        sessionID: string
      },
      _out: {
        error: unknown
      },
    ) => {
      void sweep(input.client, inputRoot)
      void item
      void _out
    },
    "experimental.chat.system.transform": async (
      _item: {},
      out: {
        system: string[]
      },
    ) => {
      void sweep(input.client, inputRoot)
      out.system.unshift(
        "The team and background tools are available for optional fan-out when they materially help, but direct implementation is allowed. Worker sessions are already configured for non-interactive execution; avoid recursive team/background/task calls inside workers.",
      )
    },
  }
}
