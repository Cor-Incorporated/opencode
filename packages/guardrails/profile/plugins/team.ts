import { mkdir, readdir } from "fs/promises"
import path from "path"
import { tool } from "@opencode-ai/plugin"

const z = tool.schema

const gap = 750
const cap = 5
const kids = new Set<string>()
const need = new Map<string, Need>()
const live = new Map<string, Run>()

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
}

type Msg = {
  info: {
    role: string
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

type Client = {
  session: {
    create(input: { body: { parentID: string; title: string }; query: { directory: string } }): Promise<{ data: { id: string } }>
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
  updated_at?: string
  failure_stage?: "worktree_setup" | "session_create" | "execution" | "merge_back" | "aborted" | "timeout"
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

type Ctx = {
  sessionID: string
  directory: string
  worktree: string
  abort: AbortSignal
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

function scrub(cmd: string) {
  return cmd
    .replace(/(?:\d*>>?|\&>>?|\&>)\s*\/dev\/null\b/g, " ")
    .replace(/\d*>\s*&\s*\d+\b/g, " ")
    .replace(/\d*>\s*&-/g, " ")
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
    />/,
    /\bgit\s+(apply|am|rebase|cherry-pick|checkout\s+--|reset\s+--hard)\b/i,
    /\bgit\s+merge(\s|$)/i,
  ].some((item) => item.test(data))
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
  return path.join(path.dirname(dir), `.${path.basename(dir)}-opencode-team`)
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
  const head = await git(dir, ["rev-parse", "--verify", "HEAD"])
  if (head.code !== 0) {
    throw new Error("Cannot create worktree: repository has no commits. Create an initial commit first.")
  }
  const made = await git(dir, ["worktree", "add", "--detach", next, "HEAD"])
  if (made.code !== 0) throw new Error(made.err || made.out || "Failed to create git worktree")
  // Verify worktree actually has files (Issue #144: empty git init)
  const files = await git(next, ["ls-files", "--cached"]).catch(() => ({ code: 1, out: "", err: "" }))
  if (files.code !== 0 || !files.out.trim()) {
    // Worktree might be empty — force checkout HEAD contents
    await git(next, ["checkout", "HEAD", "--", "."])
  }
  return next
}

async function yardrm(dir: string, item: string) {
  await git(dir, ["worktree", "remove", "--force", item])
}

async function merge(dir: string, item: string, run: string, id: string) {
  // Stage all files (including untracked) to capture new files in the diff
  const add = await git(item, ["add", "-A"])
  if (add.code !== 0) throw new Error(add.err || add.out || "Failed to stage worktree changes")
  const diff = await git(item, ["diff", "--cached", "--binary"])
  if (diff.code !== 0) throw new Error(diff.err || diff.out || "Failed to read worktree diff")
  if (!diff.out.trim()) {
    await yardrm(dir, item)
    return { patch: "", merged: true }
  }
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
  // Auto-commit applied changes so they are not left uncommitted in the parent worktree.
  // Without this, patched changes remain as unstaged modifications — the root cause of
  // "worktree changes returned but not committed" (Issue #144, Claude Code Agent parity gap).
  try {
    await git(dir, ["add", "-A"])
    const commitMsg = `chore(team): apply worker changes from task ${id}`
    const commit = await git(dir, ["commit", "-m", commitMsg, "--no-verify"])
    if (commit.code !== 0 && !commit.err.includes("nothing to commit")) {
      verification.issues.push(`Auto-commit failed: ${commit.err || commit.out}`)
    }
  } catch { /* auto-commit is best-effort; parent session can still commit manually */ }
  await yardrm(dir, item)
  return { patch: next, merged: true, verification }
}

async function idle(client: Client, id: string, dir: string, abort: AbortSignal) {
  for (;;) {
    if (abort.aborted) throw new Error("Aborted")
    const stat = await client.session.status({
      query: {
        directory: dir,
      },
    })
    const item = stat.data?.[id]
    if (!item || item.type === "idle") return
    await Bun.sleep(gap)
  }
}

async function snap(client: Client, id: string, dir: string) {
  const list = await client.session.messages({
    path: { id },
    query: { directory: dir },
  })
  const msg = [...(list.data ?? [])].reverse().find((item) => item.info.role === "assistant")
  if (!msg || msg.info.role !== "assistant") return { text: "", error: "" }
  const out = body(msg.parts)
  const err = msg.info.error?.data?.message ?? ""
  return { text: clip(out), error: err }
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
  const job = async (ctx: Ctx, run: Run, item: Step) => {
    const push = write(item.prompt, item.write)
    const box = push && item.worktree ? await yardadd(ctx.worktree, `${run.id}-${item.id}`) : ctx.directory

    todo(run, item.id, {
      state: "running",
      dir: box,
    })
    await save(ctx.worktree, run)

    const made = await input.client.session.create({
      body: {
        parentID: ctx.sessionID,
        title: item.description,
      },
      query: {
        directory: box,
      },
    })
    kids.add(made.data.id)

    todo(run, item.id, {
      session: made.data.id,
    })
    await save(ctx.worktree, run)

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
              bash: false,
              edit: false,
              write: false,
              apply_patch: false,
            },
        variant: item.variant || undefined,
        parts: [
          {
            type: "text",
            text: item.prompt,
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
    if (!err && push && box !== ctx.directory) {
      const merged = await merge(ctx.worktree, box, run.id, item.id)
      patchfile = merged.patch
      if (!merged.merged) {
        err = merged.error || "Failed to merge worktree patch"
        failure_stage = "merge_back"
      }
    }
    if (err && !failure_stage) {
      failure_stage = /abort/i.test(err) ? "aborted"
        : /timeout/i.test(err) ? "timeout"
        : "execution"
    }

    todo(run, item.id, {
      state: err ? "error" : "done",
      patch: patchfile,
      output: out.text,
      error: err,
      failure_stage: err ? failure_stage : undefined,
    })
    await save(ctx.worktree, run)
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
      defs(args.tasks)
      if (args.tasks.length < 1) throw new Error("team requires at least one task")
      ctx.metadata({
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
            worktree: item.worktree !== false,
            provider: pick.provider,
            model: pick.model,
            variant: pick.variant,
            state: "pending",
            dir: "",
            session: "",
            patch: "",
            output: "",
            error: "",
          }
        }),
      }
      await save(ctx.worktree, run)

      const done = new Set<string>()
      const list = run.tasks
      const active = new Map<string, Promise<void>>()

      const launch = (item: Step) => {
        const task = job(ctx, run, item).then(() => {
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
            await save(ctx.worktree, run)
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
          await save(ctx.worktree, run)
        }
      } catch (err) {
        run.state = "error"
        run.updated_at = now()
        await save(ctx.worktree, run)
        await stop(input.client, run)
        throw err
      }

      run.state = run.tasks.some((item) => item.state === "error") ? "error" : "done"
      run.updated_at = now()
      await save(ctx.worktree, run)
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
      const step: Step = {
        id: slug(args.description || args.agent || "worker") || "worker",
        description: args.description || "background worker",
        prompt: args.prompt,
        depends: [],
        agent: args.agent || "",
        write: write(args.prompt, args.write),
        worktree: args.worktree !== false,
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
      await save(ctx.worktree, run)
      ctx.metadata({
        title: args.description || "background run",
        metadata: {
          run_id: run.id,
        },
      })

      void job(ctx, run, step)
        .then(async () => {
          run.state = "done"
          run.updated_at = now()
          await save(ctx.worktree, run)
          if (!args.notify) return
          await input.client.session.prompt({
            path: { id: ctx.sessionID },
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
          run.state = "error"
          run.updated_at = now()
          // Classify failure stage from step state and error content
          const task = run.tasks.find((t) => t.state === "error" || t.state === "running") || run.tasks[0]
          const stage: Step["failure_stage"] = !task?.dir ? "worktree_setup"
            : !task?.session ? "session_create"
            : /merge|patch|apply/.test(err.message || "") ? "merge_back"
            : /abort/i.test(err.message || "") ? "aborted"
            : "execution"
          if (task) task.failure_stage = stage
          await save(ctx.worktree, run)
          if (!args.notify) return
          await input.client.session.prompt({
            path: { id: ctx.sessionID },
            query: {
              directory: ctx.directory,
            },
            body: {
              noReply: true,
              parts: [
                {
                  type: "text",
                  text: `Background run ${run.id} failed at stage: ${stage}.\n\n${err.message || "Unknown error"}\n\n${note(run)}`,
                },
              ],
            },
          })
        })

      return `run_id: ${run.id}\nstate: running`
    },
  })

  const team_status = tool({
    description: "Show tracked team/background orchestration runs for the current project.",
    args: {
      run_id: z.string().optional(),
    },
    async execute(args, ctx) {
      const list = args.run_id ? [live.get(args.run_id) ?? (await load(ctx.worktree, args.run_id))].filter(isRun) : await scan(ctx.worktree)
      if (!list.length) return "No team runs found."
      return list.map((item) => note(item)).join("\n\n")
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
      if (out.message.role !== "user") return
      if (kids.has(item.sessionID)) return
      if (item.agent && /review/i.test(item.agent)) return
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
      if (item.tool !== "team") return
      need.set(item.sessionID, {
        done: true,
        reason: "team",
        at: now(),
      })
    },
    "experimental.chat.system.transform": async (
      _item: {},
      out: {
        system: string[]
      },
    ) => {
      out.system.unshift(
        "When the user asks for a broad or multi-file implementation, decompose with the team tool before mutating files. Background work belongs in background; large implementation turns are hook-enforced.",
      )
    },
  }
}
