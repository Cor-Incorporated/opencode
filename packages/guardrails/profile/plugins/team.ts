import { cp, lstat, mkdir, readdir, readlink, rm, symlink } from "fs/promises"
import path from "path"
import { tool } from "@opencode-ai/plugin"
import { Background } from "../../../opencode/src/util/background"

const z = tool.schema

const gap = 750
const cap = 5
const kids = new Set<string>()
const need = new Map<string, Need>()
const live = new Map<string, Run>()
const seen = new WeakMap<object, Seen>()
const sweeping = new Map<string, Promise<void>>()

type Need = {
  done: boolean
  reason: string
  at: string
}

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
    create(input: { body: { parentID: string; title: string; permission?: Rule[] }; query: { directory: string } }): Promise<{ data: { id: string } }>
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
  updated_at?: string
  failure_stage?: "worktree_setup" | "session_create" | "execution" | "merge_back" | "aborted" | "timeout" | "blocked"
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
        item.type === "tool" &&
        item.state?.status === "completed" &&
        typeof item.state.output === "string",
    )
    .map((item) => item.state.output.trim())
    .filter(Boolean)
    .join("\n\n")
}

function pick(list: Msg[], completedOnly = false) {
  const items = [...list].reverse().filter((item) => item.info.role === "assistant")
  if (!items.length) return
  return items.find((item) => typeof item.info.time?.completed === "number") ?? (completedOnly ? undefined : items[0])
}

function scrub(cmd: string) {
  return cmd
    .replace(/(?:\d*>>?|\&>>?|\&>)\s*\/dev\/null\b/g, " ")
    .replace(/\d*>\s*&\s*\d+\b/g, " ")
    .replace(/\d*>\s*&-/g, " ")
}

function redir(cmd: string) {
  let sq = false
  let dq = false
  let bt = false
  let esc = false

  for (const ch of cmd) {
    if (esc) {
      esc = false
      continue
    }

    if (ch === "\\") {
      if (!sq) esc = true
      continue
    }

    if (sq) {
      if (ch === "'") sq = false
      continue
    }

    if (dq) {
      if (ch === '"') dq = false
      continue
    }

    if (bt) {
      if (ch === "`") bt = false
      continue
    }

    if (ch === "'") {
      sq = true
      continue
    }

    if (ch === '"') {
      dq = true
      continue
    }

    if (ch === "`") {
      bt = true
      continue
    }

    if (ch === ">") return true
  }

  return false
}

function mut(cmd: string) {
  const data = scrub(cmd)
  return [
    /\brm\s+/i,
    /\bmv\s+/i,
    /\bcp\s+/i,
    /\bchmod\b/i,
    /\bchown\b/i,
    /\btouch\b/i,
    /\btruncate\b/i,
    /\btee\b/i,
    /\bsed\s+-i\b/i,
    /\bperl\s+-pi\b/i,
    /\bgit\s+(apply|am|rebase|cherry-pick|checkout\s+--|reset\s+--hard)\b/i,
    /\bgit\s+merge(\s|$)/i,
  ].some((item) => item.test(data)) || redir(data)
}

function big(text: string) {
  const data = text.trim()
  if (!data) return false
  // Exempt read-only investigation requests that start with investigation verbs
  // and do NOT contain write-intent keywords
  const readOnly = /^\s*(investigate|diagnose|explain|analyze|check|status|report|describe|show|list|review|audit|inspect|確認|調査|分析|説明|レビュー)/i.test(data)
    && !/(implement|create|rewrite|patch|refactor|fix|add|edit|write|modify|実装|改修|修正|追加)/i.test(data)
  if (readOnly) return false
  const plan = (data.match(/^\s*([-*]|\d+\.)\s+/gm) ?? []).length
  const impl = /(implement|implementation|build|create|add|fix|refactor|rewrite|patch|parallel|subagent|team|background|worker|修正|実装|追加|改修|並列|サブエージェント|チーム)/i.test(
    data,
  )
  const wide =
    data.length >= 500 ||
    plan >= 3 ||
    /(packages\/|apps\/|services\/|複数|multi[- ]file|cross[- ]cutting|large plan|大きな実装|大規模)/i.test(data)
  return impl && wide
}

function write(text: string, flag?: boolean) {
  if (typeof flag === "boolean") return flag
  return /(implement|implementation|write|edit|patch|code|fix|refactor|modify|修正|実装|編集|追加|改修)/i.test(text)
}

function direct(text: string) {
  const next = /\bopencode\s+run\s+\/init\b/i.test(text)
    ? text.replace(
      /\bopencode\s+run\s+\/init\b/gi,
      "perform the equivalent /init repository inspection and AGENTS.md bootstrap directly in this worktree",
    ).trim()
    : text.trim()
  return `Worker execution rules:
- Prefer file inspection tools such as Glob, Read, and Grep over bash for repository discovery whenever possible.
- Use bash only when the non-shell tools cannot answer the question or complete the step.
- Do not invoke nested OpenCode slash commands from inside this team worker.
- If you are running in an isolated worktree, operate only on files inside the current worktree directory. Do not read from or write to the parent repository path directly.

${next}`
}

function permit(base: Rule[]) {
  return [
    ...base,
    { permission: "bash", pattern: "pwd", action: "allow" as const },
    { permission: "bash", pattern: "ls", action: "allow" as const },
    { permission: "bash", pattern: "ls *", action: "allow" as const },
    { permission: "bash", pattern: "find *", action: "allow" as const },
    { permission: "bash", pattern: "rg *", action: "allow" as const },
    { permission: "bash", pattern: "cat *", action: "allow" as const },
    { permission: "bash", pattern: "sed *", action: "allow" as const },
    { permission: "bash", pattern: "head *", action: "allow" as const },
    { permission: "bash", pattern: "tail *", action: "allow" as const },
    { permission: "bash", pattern: "git status*", action: "allow" as const },
    { permission: "bash", pattern: "git diff*", action: "allow" as const },
    { permission: "bash", pattern: "git log*", action: "allow" as const },
    { permission: "bash", pattern: "git rev-parse*", action: "allow" as const },
    { permission: "bash", pattern: "git ls-tree*", action: "allow" as const },
    { permission: "bash", pattern: "git show*", action: "allow" as const },
    { permission: "bash", pattern: "git ls-files*", action: "allow" as const },
    { permission: "bash", pattern: "git grep *", action: "allow" as const },
    { permission: "bash", pattern: "opencode *", action: "deny" as const },
    { permission: "bash", pattern: "claude *", action: "deny" as const },
    { permission: "bash", pattern: "codex *", action: "deny" as const },
  ]
}

function lane(item: Pick<Step, "id" | "description" | "agent" | "prompt" | "depends">) {
  const text = [item.id, item.description, item.agent, item.prompt, ...item.depends].join("\n")
  const large =
    big(text) ||
    item.depends.length > 1 ||
    /(leader|integrat|review|coord|arch|design|migration|cross|wide|large|broad|major|critical|fan-?in|全体|統合|横断|設計|移行|大規模)/i.test(
      text,
    )
  if (large) {
    return {
      provider: "openai",
      model: "gpt-5.4",
      variant: "high",
    }
  }
  return {
    provider: "zai-coding-plan",
    model: "glm-5.1",
    variant: "",
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
    return [
      "agents",
      "commands",
      "hooks",
      "settings.json",
      "settings.local.json",
      "skills",
    ]
  }

  if (dir === ".agents") {
    return [
      "agents",
      "commands",
      "hooks",
      "skills",
    ]
  }

  if (dir === ".cursor") {
    return [
      "rules",
    ]
  }

  if (dir === ".github") {
    return [
      "copilot-instructions.md",
    ]
  }

  return []
}

const runtime = [
  ".opencode/guardrails",
  ".opencode/memory",
]

function runtimeSpec() {
  return runtime.map((item) => `:(exclude)${item}`)
}

function docs() {
  return [
    "AGENTS.md",
    "OPENCODE.md",
    "CLAUDE.md",
    "CONTEXT.md",
  ]
}

function roots() {
  return [
    ".opencode",
    ".claude",
    ".agents",
    ".cursor",
    ".github",
  ]
}

function workspaceRuntime() {
  return [
    "node_modules",
    ".pnpm-store",
    ".yarn",
    ".pnp.cjs",
    ".pnp.loader.mjs",
  ]
}

async function has(file: string) {
  return lstat(file).then(() => true).catch(() => false)
}

async function graft(src: string, dst: string) {
  const stat = await lstat(src).catch(() => undefined)
  if (!stat || (await has(dst))) return false

  const kind = stat.isDirectory() ? (process.platform === "win32" ? "junction" : "dir") : "file"
  const link = stat.isSymbolicLink() ? await readlink(src) : src
  const made = await symlink(link, dst, kind as Parameters<typeof symlink>[2]).then(() => true).catch(() => false)
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
  const kept: string[] = []
  for (let cur = dir;; cur = path.dirname(cur)) {
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

async function rules(client: Client, ctx: Pick<Ctx, "sessionID" | "directory">) {
  const out = await client.session
    .get({
      path: { id: ctx.sessionID },
      query: { directory: ctx.directory },
    })
    .catch(() => undefined)
  return Array.isArray(out?.data?.permission) ? out.data.permission : []
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

async function save(dir: string, run: Run) {
  live.set(run.id, run)
  await mkdir(root(dir), { recursive: true })
  await Bun.write(file(dir, run.id), JSON.stringify(run, null, 2) + "\n")
}

async function load(dir: string, id: string) {
  const data = await Bun.file(file(dir, id)).json().catch(() => undefined)
  return isRun(data) ? data : undefined
}

async function scan(dir: string) {
  await mkdir(root(dir), { recursive: true })
  const list = await readdir(root(dir)).catch(() => [])
  return Promise.all(list.filter((item) => item.endsWith(".json")).map((item) => Bun.file(path.join(root(dir), item)).json().catch(() => undefined))).then(
    (list) =>
      list
        .filter(isRun)
        .toSorted((a, b) => String(b.updated_at).localeCompare(String(a.updated_at))),
  )
}

async function yardadd(dir: string, id: string) {
  const base = yard(dir)
  const next = path.join(base, slug(id))
  await mkdir(base, { recursive: true })

  // Verify repository has commits
  const head = await git(dir, ["rev-parse", "--verify", "HEAD"])
  if (head.code !== 0) {
    throw new Error("Cannot create worktree: repository has no commits. Create an initial commit first.")
  }

  // Step 1: Create worktree without checking out files (upstream pattern)
  const made = await git(dir, ["worktree", "add", "--detach", "--no-checkout", next, "HEAD"])
  if (made.code !== 0) {
    await git(dir, ["worktree", "remove", "--force", next]).catch(() => {})
    throw new Error(made.err || made.out || "Failed to create git worktree")
  }

  // Step 2: Hard reset to populate working directory (upstream pattern)
  const populated = await git(next, ["reset", "--hard"])
  if (populated.code !== 0) {
    await git(dir, ["worktree", "remove", "--force", next]).catch(() => {})
    throw new Error(`Worktree created but population failed: ${populated.err || populated.out}`)
  }

  // Step 3: Verify files are actually present in the working directory
  const check = await git(next, ["ls-files", "--cached"])
  if (check.code !== 0 || !check.out.trim()) {
    await git(dir, ["worktree", "remove", "--force", next]).catch(() => {})
    throw new Error("Worktree is empty after reset --hard — cannot proceed with delegation")
  }

  return next
}

async function yardrm(dir: string, item: string) {
  await git(dir, ["worktree", "remove", "--force", item])
}

async function merge(dir: string, item: string, run: string, id: string, kept: string[] = []) {
  await Promise.all(kept.map((file) => rm(path.join(item, file), { force: true, recursive: true }).catch(() => undefined)))
  const spec = runtimeSpec()
  // Stage all worker-owned files while excluding runtime state that is created locally during execution.
  const add = await git(item, ["add", "-A", "--", ".", ...spec])
  if (add.code !== 0) throw new Error(add.err || add.out || "Failed to stage worktree changes")
  const changed = await git(item, ["diff", "--cached", "--name-only", "--diff-filter=ACDMRTUXB", "--", ".", ...spec])
  if (changed.code !== 0) throw new Error(changed.err || changed.out || "Failed to list worktree changes")
  const files = changed.out
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
  if (!files.length) {
    await yardrm(dir, item)
    return { patch: "", merged: true }
  }
  const diff = await git(item, ["diff", "--cached", "--binary", "--", ".", ...spec])
  if (diff.code !== 0) throw new Error(diff.err || diff.out || "Failed to read worktree diff")
  const next = patch(dir, run, id)
  await Bun.write(next, diff.out)
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
    const untracked = status.out.trim().split("\n").filter((l: string) => l.startsWith("??")).length
    if (untracked > 5) {
      verification.issues.push(`${untracked} untracked files after merge — check for stale artifacts`)
    }
  } catch { /* verification is advisory */ }
  // Auto-commit only the files produced by the worker patch so unrelated parent edits stay untouched.
  try {
    if (files.length > 0) {
      await git(dir, ["add", "--", ...files])
      const commitMsg = `chore(team): apply worker changes from task ${id}`
      const commit = await git(dir, ["commit", "-m", commitMsg])
      if (commit.code !== 0 && !commit.err.includes("nothing to commit")) {
        verification.issues.push(`Auto-commit failed: ${commit.err || commit.out}`)
      }
    }
  } catch { /* auto-commit is best-effort; parent session can still commit manually */ }
  await yardrm(dir, item)
  return { patch: next, merged: true, verification }
}

async function idle(client: Client, id: string, dir: string, abort: AbortSignal) {
  let seen = false
  const hit = mark(client)
  for (;;) {
    if (abort.aborted) throw new Error("Aborted")
    if (hit.idle.has(id)) return
    const blocked = await wait(client, id, dir)
    if (blocked) throw new Error(blocked)
    const done = await snap(client, id, dir, true)
    if (done.completed) return
    const stat = await client.session.status({
      query: {
        directory: dir,
      },
    })
    const item = stat.data?.[id]
    if (!item) {
      if (hit.idle.has(id)) return
      if (seen) return
      await Bun.sleep(gap)
      continue
    }
    seen = true
    if (item.type === "idle") return
    await Bun.sleep(gap)
  }
}

async function snap(client: Client, id: string, dir: string, completedOnly = false) {
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
  return /blocked on (permission|question)/i.test(err) ? "blocked"
    : /abort/i.test(err) ? "aborted"
    : /timeout/i.test(err) ? "timeout"
    : "execution"
}

function why(item: Step | undefined, err: string): Step["failure_stage"] {
  return !item?.dir ? "worktree_setup"
    : !item?.session ? "session_create"
    : /merge|patch|apply/.test(err) ? "merge_back"
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
            const permission = typeof props.permission === "string" ? props.permission : typeof props.type === "string" ? props.type : "unknown"
            const raw = props.patterns ?? props.pattern
            const patterns = Array.isArray(raw) ? raw.filter((item): item is string => typeof item === "string") : typeof raw === "string" ? [raw] : []
            const label = typeof props.title === "string" && props.title ? props.title : typeof props.description === "string" ? props.description : ""
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
  const perm = await client.permission?.list?.({ directory: dir }).catch(() => ({ data: [] as { sessionID: string; permission: string; patterns: string[]; metadata?: Record<string, unknown> }[] }))
  const blocked = perm?.data?.find((item) => item.sessionID === id)
  if (blocked) {
    const meta = blocked.metadata?.description
    const hint = typeof meta === "string" && meta ? ` (${meta})` : ""
    return `Blocked on permission: ${blocked.permission}${hint} :: ${blocked.patterns.join(" | ")}`
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
  const localState = await Bun.file(path.join(dir, ".opencode", "guardrails", "state.json")).json().catch(() => undefined) as
    | { last_event?: unknown; last_permission?: unknown; last_patterns?: unknown }
    | undefined
  if (localState?.last_event === "permission.asked" && typeof localState.last_permission === "string") {
    const patterns = Array.isArray(localState.last_patterns)
      ? localState.last_patterns.filter((item): item is string => typeof item === "string")
      : []
    return `Blocked on permission: ${localState.last_permission} :: ${patterns.join(" | ")}`
  }
  const ask = await client.question?.list?.({ directory: dir }).catch(() => ({ data: [] as { sessionID: string; questions: { question: string; header: string }[] }[] }))
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

export default async function team(input: {
  client: Client
  worktree: string
  directory: string
}) {
  const inputRoot = projectRoot(input.directory, input.worktree)
  void sweep(input.client, inputRoot)
  const job = async (ctx: Ctx, run: Run, item: Step) => {
    const runRoot = projectRoot(ctx.directory, ctx.worktree)
    const repoRoot = ctx.worktree && ctx.worktree !== "/" ? ctx.worktree : undefined
    const push = write(item.prompt, item.write)
    const prompt = direct(item.prompt)
    const useWorktree = push && item.worktree && !!repoRoot
    const box = useWorktree ? await yardadd(repoRoot, `${run.id}-${item.id}`) : ctx.directory
    const kept = useWorktree && repoRoot ? await carry(repoRoot, ctx.directory, box) : []

    todo(run, item.id, {
      state: "running",
      dir: box,
    })
    await save(runRoot, run)

    const made = await input.client.session.create({
      body: {
        parentID: ctx.sessionID,
        title: item.description,
        permission: permit(ctx.permission),
      },
      query: {
        directory: box,
      },
    })
    kids.add(made.data.id)

    todo(run, item.id, {
      session: made.data.id,
    })
    await save(runRoot, run)

    await input.client.session.promptAsync({
      path: { id: made.data.id },
      query: {
        directory: box,
      },
      body: {
        agent: item.agent || undefined,
        model: {
          providerID: item.provider,
          modelID: item.model,
        },
        tools: push
          ? undefined
          : {
              edit: false,
              write: false,
              apply_patch: false,
              task: false,
              todowrite: false,
            },
        variant: item.variant || undefined,
        parts: [
          {
            type: "text",
            text: prompt,
          },
        ],
      },
    })

    await idle(input.client, made.data.id, box, ctx.abort)
    const out = await snap(input.client, made.data.id, box)

    let patchfile = ""
    let err = out.error
    // [Phase6] Classify failure stage for abort reason tracking
    let failure_stage: Step["failure_stage"] = undefined
    if (!err && useWorktree && repoRoot && box !== ctx.directory) {
      const merged = await merge(repoRoot, box, run.id, item.id, kept)
      patchfile = merged.patch
      if (!merged.merged) {
        err = merged.error || "Failed to merge worktree patch"
        failure_stage = "merge_back"
      }
    }
    if (err && !failure_stage) failure_stage = stage(err)

    todo(run, item.id, {
      state: err ? "error" : "done",
      patch: patchfile,
      no_patch: !err && item.write && useWorktree && patchfile === "",
      output: out.text,
      error: err,
      failure_stage: err ? failure_stage : undefined,
    })
    await save(runRoot, run)
    if (err) throw new Error(err)
    return out.text
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
        }),
      ),
    },
    async execute(args, ctx) {
      const runRoot = projectRoot(ctx.directory, ctx.worktree)
      const canIsolate = Boolean(ctx.worktree && ctx.worktree !== "/")
      await sweep(input.client, runRoot)
      defs(args.tasks)
      if (args.tasks.length < 1) throw new Error("team requires at least one task")
      const req = {
        ...ctx,
        permission: await rules(input.client, ctx),
      }
      req.metadata({
        title: "team run",
        metadata: {
          tasks: args.tasks.length,
          strategy: args.strategy,
        },
      })

      const run: Run = {
        id: crypto.randomUUID(),
        kind: "team",
        state: "running",
        session: ctx.sessionID,
        directory: ctx.directory,
        created_at: now(),
        updated_at: now(),
        tasks: args.tasks.map((item) => {
          const pick = lane({
            id: item.id,
            description: item.description || item.id,
            prompt: item.prompt,
            depends: item.depends ?? [],
            agent: item.agent || "",
          })
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
            output: "",
            error: "",
          }
        }),
      }
      await save(runRoot, run)

      const done = new Set<string>()
      const list = run.tasks
      const active = new Map<string, Promise<void>>()

      const launch = (item: Step) => {
        const task = job(req, run, item).then(() => {
          done.add(item.id)
          active.delete(item.id)
        })
        active.set(item.id, task)
        return task
      }

      try {
        for (;;) {
          const ready = list.filter((item) => item.state === "pending" && item.depends.every((dep) => done.has(dep)) && !active.has(item.id))

          if (args.strategy === "wave" && ready.length) {
            ready.forEach((item) => todo(run, item.id, { state: "queued" }))
            await save(runRoot, run)
            await Promise.all(ready.map((item) => launch(item)))
          } else {
            ready.slice(0, Math.max(args.limit - active.size, 0)).forEach((item) => {
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
        const item = run.tasks.find((item) => item.state === "error")
          ?? run.tasks.find((item) => item.state === "running" || item.state === "queued")
        fail(run, err instanceof Error ? err.message : String(err), item?.id)
        await save(runRoot, run)
        await stop(input.client, run)
        throw err
      }

      run.state = run.tasks.some((item) => item.state === "error") ? "error" : "done"
      run.updated_at = now()
      await save(runRoot, run)
      need.set(ctx.sessionID, {
        done: true,
        reason: "team",
        at: now(),
      })
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
      const runRoot = projectRoot(ctx.directory, ctx.worktree)
      const canIsolate = Boolean(ctx.worktree && ctx.worktree !== "/")
      const detachedAbort = new AbortController()
      await sweep(input.client, runRoot)
      const req = {
        ...ctx,
        abort: detachedAbort.signal,
        permission: await rules(input.client, ctx),
      }
      const step: Step = {
        id: slug(args.description || args.agent || "worker") || "worker",
        description: args.description || "background worker",
        prompt: args.prompt,
        depends: [],
        agent: args.agent || "",
        write: write(args.prompt, args.write),
        worktree: canIsolate && args.worktree !== false,
        ...lane({
          id: slug(args.description || args.agent || "worker") || "worker",
          description: args.description || "background worker",
          prompt: args.prompt,
          depends: [],
          agent: args.agent || "",
        }),
        state: "pending",
        dir: "",
        session: "",
        patch: "",
        no_patch: false,
        output: "",
        error: "",
      }
      const run: Run = {
        id: crypto.randomUUID(),
        kind: "background",
        state: "running",
        session: ctx.sessionID,
        directory: ctx.directory,
        created_at: now(),
        updated_at: now(),
        tasks: [step],
      }
      await save(runRoot, run)
      req.metadata({
        title: args.description || "background run",
        metadata: {
          run_id: run.id,
        },
      })

      const task = job(req, run, step)
        .then(async () => {
          run.state = "done"
          run.updated_at = now()
          await save(runRoot, run)
          if (!args.notify) return
          await input.client.session.prompt({
            path: { id: req.sessionID },
            query: {
              directory: req.directory,
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
          const item = run.tasks.find((item) => item.state === "error" || item.state === "running" || item.state === "queued") || run.tasks[0]
          fail(run, err.message || "Unknown error", item?.id)
          await save(runRoot, run)
          if (!args.notify) return
          await input.client.session.prompt({
            path: { id: req.sessionID },
            query: {
              directory: req.directory,
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
      Background.add(req.directory, task)
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
      await sweep(input.client, runRoot)
      const list = args.run_id ? [live.get(args.run_id) ?? (await load(runRoot, args.run_id))].filter(isRun) : await scan(runRoot)
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
      if (out.message.role !== "user") return
      if (kids.has(item.sessionID)) return
      if (item.agent && /(review|technical-writer|doc-updater)/i.test(item.agent)) return
      const text = body(out.parts)
      if (text.includes("under the guardrail profile.")) return
      if (!big(text)) return
      const headCheck = await git(input.worktree, ["rev-parse", "--verify", "HEAD"])
      if (headCheck.code !== 0) {
        out.parts.push({
          id: crypto.randomUUID(),
          sessionID: out.message.sessionID,
          messageID: out.message.id,
          type: "text",
          text: "Bootstrap mode: this repository has no commits yet. Parallel implementation policy is suspended until the first commit is created. Proceed with direct mutations to bootstrap the repository.",
        })
        return
      }
      need.set(item.sessionID, {
        done: false,
        reason: clip(text, 240),
        at: now(),
      })
      out.parts.push({
        id: crypto.randomUUID(),
        sessionID: out.message.sessionID,
        messageID: out.message.id,
        type: "text",
        text:
          "Parallel implementation policy is active for this request. Before any edit, write, apply_patch, or mutating bash call, you MUST call the `team` tool and fan out at least one worker task. Mark tasks that should edit code with `write: true`; those tasks will be isolated in git worktrees and merged back when possible. Use `background` only for side work that should keep running after this turn.",
      })
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
      const gate = need.get(item.sessionID)
      if (!gate || gate.done) return
      if (item.tool === "team") return
      if (item.tool !== "edit" && item.tool !== "write" && item.tool !== "apply_patch" && item.tool !== "bash") return
      if (item.tool === "bash" && !mut(String(out.args.command ?? ""))) return
      throw new Error(
        `Parallel implementation is enforced for this turn. Call the team tool before mutating the worktree. Reason: ${gate.reason}`,
      )
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
      if (item.tool !== "team" && item.tool !== "background") return
      need.set(item.sessionID, {
        done: true,
        reason: item.tool,
        at: now(),
      })
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
      if (item.tool !== "team" && item.tool !== "background") return
      need.set(item.sessionID, {
        done: true,
        reason: `${item.tool}-failed`,
        at: now(),
      })
    },
    "experimental.chat.system.transform": async (
      _item: {},
      out: {
        system: string[]
      },
    ) => {
      void sweep(input.client, inputRoot)
      out.system.unshift(
        "When the user asks for a broad or multi-file implementation, decompose with the team tool before mutating files. Background work belongs in background; large implementation turns are hook-enforced.",
      )
    },
  }
}
