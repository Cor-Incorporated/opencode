import { mkdir } from "fs/promises"
import path from "path"

const sec = [
  /(^|\/)\.env($|\.)/i,
  /(^|\/).*\.pem$/i,
  /(^|\/).*\.key$/i,
  /(^|\/).*\.p12$/i,
  /(^|\/).*\.pfx$/i,
  /(^|\/).*\.crt$/i,
  /(^|\/).*\.cer$/i,
  /(^|\/).*\.der$/i,
  /(^|\/).*id_rsa.*$/i,
  /(^|\/).*id_ed25519.*$/i,
  /(^|\/).*credentials.*$/i,
]

const cfg = [
  /(^|\/)eslint\.config\.[^/]+$/i,
  /(^|\/)\.eslintrc(\.[^/]+)?$/i,
  /(^|\/)biome\.json(c)?$/i,
  /(^|\/)prettier\.config\.[^/]+$/i,
  /(^|\/)\.prettierrc(\.[^/]+)?$/i,
]

const mut = [
  /\brm\b/i,
  /\bmv\b/i,
  /\bcp\b/i,
  /\bchmod\b/i,
  /\bchown\b/i,
  /\btouch\b/i,
  /\btruncate\b/i,
  /\btee\b/i,
  /\bsed\s+-i\b/i,
  /\bperl\s+-pi\b/i,
  />/,
]

const src = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".py",
  ".go",
  ".rs",
  ".swift",
  ".kt",
  ".java",
  ".rb",
  ".php",
  ".vue",
  ".svelte",
  ".css",
  ".scss",
  ".sql",
  ".prisma",
  ".graphql",
  ".sh",
])

const paid: Record<string, Set<string>> = {
  "zai-coding-plan": new Set([
    "glm-4.5",
    "glm-4.5-air",
    "glm-4.5-flash",
    "glm-4.5v",
    "glm-4.6",
    "glm-4.6v",
    "glm-4.7",
    "glm-4.7-flash",
    "glm-4.7-flashx",
    "glm-5",
    "glm-5-turbo",
    "glm-5.1",
  ]),
  openai: new Set([
    "gpt-5.1-codex",
    "gpt-5.1-codex-max",
    "gpt-5.1-codex-mini",
    "gpt-5.2",
    "gpt-5.2-codex",
    "gpt-5.3-codex",
    "gpt-5.4",
    "gpt-5.4-mini",
  ]),
}

function norm(file: string) {
  return path.resolve(file).replaceAll("\\", "/")
}

function rel(root: string, file: string) {
  const abs = norm(file)
  const dir = norm(root)
  if (!abs.startsWith(dir + "/")) return abs
  return abs.slice(dir.length + 1)
}

function has(file: string, list: RegExp[]) {
  return list.some((item) => item.test(file))
}

function ext(file: string) {
  return path.extname(file).toLowerCase()
}

function stash(file: string) {
  return Bun.file(file)
    .json()
    .catch(() => ({} as Record<string, unknown>))
}

async function save(file: string, data: Record<string, unknown>) {
  await Bun.write(file, JSON.stringify(data, null, 2) + "\n")
}

async function line(file: string, data: Record<string, unknown>) {
  const prev = await Bun.file(file).text().catch(() => "")
  await Bun.write(file, prev + JSON.stringify(data) + "\n")
}

function text(err: string) {
  return `Guardrail policy blocked this action: ${err}`
}

function pick(args: unknown) {
  if (!args || typeof args !== "object") return
  if ("filePath" in args && typeof args.filePath === "string") return args.filePath
}

function bash(cmd: string) {
  return mut.some((item) => item.test(cmd))
}

function list(data: unknown) {
  return Array.isArray(data) ? data.filter((item): item is string => typeof item === "string" && item !== "") : []
}

function num(data: unknown) {
  return typeof data === "number" && Number.isFinite(data) ? data : 0
}

function flag(data: unknown) {
  return data === true
}

function str(data: unknown) {
  return typeof data === "string" ? data : ""
}

async function git(dir: string, args: string[]) {
  const proc = Bun.spawn(["git", "-C", dir, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { stdout, stderr }
}

function free(data: {
  id?: unknown
  providerID?: unknown
  cost?: {
    input?: number
    output?: number
    cache?: { read?: number; write?: number }
  }
}) {
  const inCost = data.cost?.input ?? 0
  const outCost = data.cost?.output ?? 0
  const readCost = data.cost?.cache?.read ?? 0
  const writeCost = data.cost?.cache?.write ?? 0
  if (!(inCost === 0 && outCost === 0 && readCost === 0 && writeCost === 0)) return false
  const ids = paid[str(data.providerID)]
  return !(ids && ids.has(str(data.id)))
}

function preview(data: {
  id?: unknown
  status?: unknown
}) {
  const id = str(data.id)
  const status = str(data.status)
  if (status && status !== "active") return true
  return /(preview|alpha|beta|exp|experimental|:free\b|\bfree\b)/i.test(id)
}

function vers(text: string) {
  return [...text.matchAll(/\bv?\d+\.\d+\.\d+\b/g)].map((item) => item[0]).slice(0, 8)
}

function semver(text: string) {
  const hit = text.match(/^v?(\d+)\.(\d+)\.(\d+)$/)
  if (!hit) return
  return hit.slice(1).map((item) => Number(item))
}

function cmp(left: string, right: string) {
  const a = semver(left)
  const b = semver(right)
  if (!a || !b) return 0
  if (a[0] !== b[0]) return a[0] - b[0]
  if (a[1] !== b[1]) return a[1] - b[1]
  return a[2] - b[2]
}

export default async function guardrail(input: {
  directory: string
  worktree: string
}, opts?: Record<string, unknown>) {
  const mode = typeof opts?.mode === "string" ? opts.mode : "enforced"
  const evals = new Set<string>([])
  const evalAgent = "provider-eval"
  const conf = true
  const denyFree = true
  const denyPreview = true
  const root = path.join(input.directory, ".opencode", "guardrails")
  const log = path.join(root, "events.jsonl")
  const state = path.join(root, "state.json")
  const allow: Record<string, Set<string>> = {}

  await mkdir(root, { recursive: true })

  async function mark(data: Record<string, unknown>) {
    const prev = await stash(state)
    await save(state, { ...prev, ...data, mode, updated_at: new Date().toISOString() })
  }

  async function seen(type: string, data: Record<string, unknown>) {
    await line(log, { type, time: new Date().toISOString(), ...data })
  }

  function note(props: Record<string, unknown> | undefined) {
    return {
      sessionID: str(props?.sessionID) || undefined,
      permission: str(props?.permission) || undefined,
      patterns: Array.isArray(props?.patterns) ? props.patterns : undefined,
    }
  }

  function hidden(file: string) {
    return rel(input.worktree, file).startsWith(".opencode/guardrails/")
  }

  function code(file: string) {
    const item = rel(input.worktree, file)
    if (hidden(file)) return false
    if (item === "AGENTS.md") return false
    if (item.startsWith(".claude/")) return false
    if (item.startsWith(".opencode/")) return false
    if (item.startsWith("docs/")) return false
    if (item.includes("/docs/")) return false
    if (item.startsWith("node_modules/")) return false
    if (item.includes("/node_modules/")) return false
    if (item.startsWith("tmp/")) return false
    if (item.includes("/tmp/")) return false
    return src.has(ext(item))
  }

  function fact(file: string) {
    const item = rel(input.worktree, file)
    if (hidden(file)) return false
    if (code(file)) return true
    if (/(^|\/)(README|AGENTS)\.md$/i.test(item)) return true
    if (item.startsWith("docs/") || item.includes("/docs/")) return true
    if (item.startsWith("hooks/") || item.includes("/hooks/")) return true
    if (item.startsWith("scripts/") || item.includes("/scripts/")) return true
    if (item.startsWith("src/") || item.includes("/src/")) return true
    return [".md", ".mdx", ".json", ".yaml", ".yml", ".toml"].includes(ext(item))
  }

  function stale(data: Record<string, unknown>, key: "edit_count_since_check" | "edits_since_review") {
    return num(data[key]) > 0
  }

  function factLine(data: Record<string, unknown>) {
    if (!flag(data.factchecked)) return "missing"
    const source = str(data.factcheck_source) || "unknown"
    const at = str(data.factcheck_at) || "unknown"
    if (!stale(data, "edit_count_since_check")) return `fresh via ${source} at ${at}`
    return `stale after ${num(data.edit_count_since_check)} edit(s) since ${source} at ${at}`
  }

  function reviewLine(data: Record<string, unknown>) {
    if (!flag(data.reviewed)) return "missing"
    const at = str(data.review_at) || "unknown"
    if (!stale(data, "edits_since_review")) return `fresh at ${at}`
    return `stale after ${num(data.edits_since_review)} edit(s) since ${at}`
  }

  function compact(data: Record<string, unknown>) {
    const block = str(data.last_block) || "none"
    const reason = str(data.last_reason)
    return [
      "Guardrail runtime state:",
      `- unique source reads: ${num(data.read_count)}`,
      `- edit/write count: ${num(data.edit_count)}`,
      `- fact-check: ${factLine(data)}`,
      `- review state: ${reviewLine(data)}`,
      `- last block: ${block}${reason ? ` (${reason})` : ""}`,
      "Treat missing or stale fact-check/review state as an explicit gate.",
    ].join("\n")
  }

  function deny(file: string, kind: "read" | "edit") {
    const item = rel(input.worktree, file)
    if (kind === "read" && has(item, sec)) return "secret material is outside the allowed read surface"
    if (hidden(file)) return "guardrail runtime state is plugin-owned"
    if (kind === "edit" && has(item, cfg)) return "linter or formatter configuration is policy-protected"
  }

  function baseline(old: string, next: string) {
    if (/:latest\b/i.test(old) && vers(next).length > 0) {
      return ":latest pin requires ADR-backed compatibility verification"
    }
    const left = vers(old)
    const right = vers(next)
    if (!left.length || !right.length) return
    if (left.length !== right.length || left.length > 3) return
    for (let i = 0; i < left.length; i++) {
      if (cmp(right[i], left[i]) < 0) return `version baseline regression ${left[i]} -> ${right[i]}`
    }
  }

  async function version(args: Record<string, unknown>) {
    const file = pick(args)
    if (!file || hidden(file)) return
    if (typeof args.oldString === "string" && typeof args.newString === "string") {
      return baseline(args.oldString, args.newString)
    }
    if (typeof args.content !== "string") return
    const prev = await Bun.file(file).text().catch(() => "")
    if (!prev) return
    return baseline(prev, args.content)
  }

  async function budget() {
    const data = await stash(state)
    return num(data.read_count)
  }

  function gate(data: {
    agent?: string
    model?: {
      id?: unknown
      providerID?: unknown
      status?: unknown
      cost?: {
        input?: number
        output?: number
        cache?: { read?: number; write?: number }
      }
    }
  }) {
    const provider = str(data.model?.providerID)
    const agent = str(data.agent)
    if (!provider) return

    if (evals.size > 0 && evals.has(provider) && agent !== evalAgent) {
      return `${provider} is evaluation-only under confidential policy; use ${evalAgent}`
    }
    if (evals.size > 0 && agent === evalAgent && !evals.has(provider)) {
      return `${evalAgent} is reserved for evaluation-lane providers`
    }

    const ids = allow[provider]
    const model = str(data.model?.id)
    if (ids?.size && model && !ids.has(model)) {
      return `${provider}/${model} is not admitted by provider policy`
    }

    if (!conf) return
    if (denyFree && free(data.model ?? {})) return `${provider}/${model || "unknown"} is a free-tier model`
    if (denyPreview && preview(data.model ?? {})) return `${provider}/${model || "unknown"} is preview-only`
  }

  return {
    config: async (cfg: {
      provider?: Record<string, { whitelist?: string[] }>
    }) => {
      for (const key of Object.keys(allow)) delete allow[key]
      for (const [key, val] of Object.entries(cfg.provider ?? {})) {
        const ids = list(val.whitelist)
        if (!ids.length) continue
        allow[key] = new Set(ids)
      }
    },
    event: async ({ event }: { event: { type?: string; properties?: Record<string, unknown> } }) => {
      if (!event.type) return
      if (!["session.created", "permission.asked", "session.idle", "session.compacted"].includes(event.type)) return
      await seen(event.type, note(event.properties))
      if (event.type === "session.created") {
        await mark({
          last_session: event.properties?.sessionID,
          last_event: event.type,
          read_files: [],
          read_count: 0,
          edited_files: [],
          edit_count: 0,
          factchecked: false,
          factcheck_source: "",
          factcheck_at: "",
          edit_count_since_check: 0,
          reviewed: false,
          review_at: "",
          edits_since_review: 0,
          last_block: "",
          last_reason: "",
          git_freshness_checked: false,
          review_state: "",
        })
      }
      if (event.type === "permission.asked") {
        await mark({
          last_permission: event.properties?.permission,
          last_patterns: event.properties?.patterns,
          last_event: event.type,
        })
      }
      if (event.type === "session.compacted") {
        await mark({
          last_compacted: event.properties?.sessionID,
          last_event: event.type,
        })
      }
    },
    "chat.message": async (
      item: {
        sessionID: string
      },
      out: {
        message: {
          id: string
          sessionID: string
          role: string
        }
        parts: {
          id: string
          sessionID: string
          messageID?: string
          type: string
          text: string
        }[]
      },
    ) => {
      if (out.message.role !== "user") return
      const data = await stash(state)
      if (flag(data.git_freshness_checked)) return
      await mark({ git_freshness_checked: true })
      try {
        const fetchCheck = await git(input.worktree, ["fetch", "--dry-run"])
        if (fetchCheck.stdout.trim() || fetchCheck.stderr.includes("From")) {
          out.parts.push({
            id: crypto.randomUUID(),
            sessionID: out.message.sessionID,
            messageID: out.message.id,
            type: "text",
            text: "⚠️ Your branch may be behind origin. Consider running `git pull` before making changes.",
          })
        }
      } catch {
        // git fetch may fail in offline or no-remote scenarios; skip silently
      }
    },
    "tool.execute.before": async (
      item: { tool: string; args?: unknown },
      out: { args: Record<string, unknown> },
    ) => {
      const file = pick(out.args ?? item.args)
      if (file && (item.tool === "read" || item.tool === "edit" || item.tool === "write")) {
        const err = deny(file, item.tool === "read" ? "read" : "edit")
        if (err) {
          await mark({ last_block: item.tool, last_file: rel(input.worktree, file), last_reason: err })
          throw new Error(text(err))
        }
      }
      if (item.tool === "edit" || item.tool === "write") {
        const err = await version(out.args ?? {})
        if (err) {
          await mark({ last_block: item.tool, last_file: file ? rel(input.worktree, file) : "", last_reason: err })
          throw new Error(text(err))
        }
      }
      if ((item.tool === "edit" || item.tool === "write") && file && code(file)) {
        const count = await budget()
        if (count >= 4) {
          const err = `context budget exceeded after ${count} source reads; call the team tool to delegate this edit to an isolated worker, or narrow scope`
          await mark({ last_block: item.tool, last_file: rel(input.worktree, file), last_reason: err })
          throw new Error(text(err))
        }
      }
      if (item.tool === "bash") {
        const cmd = typeof out.args?.command === "string" ? out.args.command : ""
        const file = cmd.replaceAll("\\", "/")
        if (!cmd) return
        if (has(file, sec) || file.includes(".opencode/guardrails/")) {
          await mark({ last_block: "bash", last_command: cmd, last_reason: "shell access to protected files" })
          throw new Error(text("shell access to protected files"))
        }
        if (/\b(git\s+merge|gh\s+pr\s+merge)\b/i.test(cmd)) {
          const data = await stash(state)
          if (str(data.review_state) !== "done") {
            await mark({ last_block: "bash", last_command: cmd, last_reason: "merge blocked: review not done" })
            throw new Error(text("merge blocked: run /review before merging"))
          }
        }
        // Direct push to protected branches
        const protectedBranch = /^(main|master|develop|dev)$/
        if (/\bgit\s+push\b/i.test(cmd)) {
          // Check explicit branch target
          const explicitMatch = cmd.match(/\bgit\s+push\s+(?:(?:-\w+|--[\w-]+)\s+)*\S+\s+(?:HEAD:)?(\S+)/i)
          if (explicitMatch && protectedBranch.test(explicitMatch[1])) {
            throw new Error(text("direct push to protected branch blocked — use a PR workflow"))
          }
          // Check refspec form HEAD:branch
          const refspecMatch = cmd.match(/HEAD:(main|master|develop|dev)(?:\s|$)/i)
          if (refspecMatch) {
            throw new Error(text("direct push to protected branch blocked — use a PR workflow"))
          }
          // Plain `git push` with no branch — check current branch
          if (!/\bgit\s+push\s+(?:(?:-\w+|--[\w-]+)\s+)*\S+\s+\S+/i.test(cmd)) {
            try {
              const result = await git(input.worktree, ["branch", "--show-current"])
              if (result.stdout && protectedBranch.test(result.stdout.trim())) {
                throw new Error(text("direct push to protected branch blocked — use a PR workflow"))
              }
            } catch (e) { if (String(e).includes("blocked")) throw e }
          }
        }
        if (!bash(cmd)) return
        if (!cfg.some((rule) => rule.test(file)) && !file.includes(".opencode/guardrails/")) return
        await mark({ last_block: "bash", last_command: cmd, last_reason: "protected runtime or config mutation" })
        throw new Error(text("protected runtime or config mutation"))
      }
    },
    "tool.execute.after": async (
      item: { tool: string; args?: Record<string, unknown> },
      out: { title: string; output: string; metadata: Record<string, unknown> },
    ) => {
      const now = new Date().toISOString()
      const file = pick(item.args)
      const data = await stash(state)

      if (item.tool === "read" && file) {
        if (code(file)) {
          const seen = list(data.read_files)
          const next = seen.includes(rel(input.worktree, file)) ? seen : [...seen, rel(input.worktree, file)]
          await mark({
            read_files: next,
            read_count: next.length,
            last_read: rel(input.worktree, file),
          })
        }
        if (fact(file)) {
          await mark({
            factchecked: true,
            factcheck_source: "DocRead",
            factcheck_at: now,
            edit_count_since_check: 0,
          })
        }
      }

      if (item.tool === "webfetch" || item.tool.startsWith("mcp__context7__")) {
        await mark({
          factchecked: true,
          factcheck_source: item.tool === "webfetch" ? "WebFetch" : "Context7",
          factcheck_at: now,
          edit_count_since_check: 0,
        })
      }

      if (item.tool === "bash") {
        const cmd = typeof item.args?.command === "string" ? item.args.command : ""
        if (/(^|&&|\|\||;)\s*(gcloud|kubectl|aws)\s+/i.test(cmd)) {
          await mark({
            factchecked: true,
            factcheck_source: "CLI",
            factcheck_at: now,
            edit_count_since_check: 0,
          })
        }
      }

      if ((item.tool === "edit" || item.tool === "write") && file) {
        const seen = list(data.edited_files)
        const next = seen.includes(rel(input.worktree, file)) ? seen : [...seen, rel(input.worktree, file)]
        const nextEditCount = num(data.edit_count) + 1
        await mark({
          edited_files: next,
          edit_count: nextEditCount,
          edit_count_since_check: num(data.edit_count_since_check) + 1,
          edits_since_review: num(data.edits_since_review) + 1,
          last_edit: rel(input.worktree, file),
          review_state: "",
        })

        if (/\.(test|spec)\.(ts|tsx|js|jsx)$|^test_.*\.py$|_test\.go$/.test(rel(input.worktree, file))) {
          out.output += "\n\n🧪 Test file modified. Verify this test actually FAILS without the fix (test falsifiability)."
        }

        if (code(file) && nextEditCount > 0 && nextEditCount % 3 === 0) {
          out.output += "\n\n📝 Source code edited (3+ operations). Check if related documentation (README, AGENTS.md, ADRs) needs updating."
        }
        // Auto-format reminder after 3+ source edits
        if (code(file) && nextEditCount >= 3 && nextEditCount % 3 === 0) {
          out.output = (out.output || "") + "\n🎨 " + nextEditCount + " source edits — consider running formatter (`prettier --write`, `biome format`, `go fmt`)."
        }
      }

      // CI status advisory after push/PR create
      if (item.tool === "bash" && /\b(git\s+push|gh\s+pr\s+create)\b/i.test(str(item.args?.command))) {
        out.output = (out.output || "") + "\n⚠️ Remember to verify CI status: `gh pr checks`"
      }

      if (item.tool === "task") {
        const cmd = typeof item.args?.command === "string" ? item.args.command : ""
        const agent = typeof item.args?.subagent_type === "string" ? item.args.subagent_type : ""
        if (cmd === "review" || agent.includes("review")) {
          await mark({
            reviewed: true,
            review_at: now,
            review_agent: agent,
            review_state: "done",
            edits_since_review: 0,
          })
        }
      }
    },
    "command.execute.before": async (
      item: { command: string; sessionID: string; arguments: string },
      out: {
        parts: {
          type?: string
          prompt?: string
        }[]
      },
    ) => {
      if (!["review", "ship", "handoff"].includes(item.command)) return
      const data = await stash(state)
      const part = out.parts.find((item) => item.type === "subtask" && typeof item.prompt === "string")
      if (!part?.prompt) return
      part.prompt = `${part.prompt}\n\n${compact(data)}`
    },
    "shell.env": async (_item: { cwd: string }, out: { env: Record<string, string> }) => {
      out.env.OPENCODE_GUARDRAIL_MODE = mode
      out.env.OPENCODE_GUARDRAIL_ROOT = root
      out.env.OPENCODE_GUARDRAIL_STATE = state
    },
    "chat.params": async (
      item: {
        sessionID: string
        agent: string
        model: {
          id: string
          providerID: string
          status: "alpha" | "beta" | "deprecated" | "active"
          cost: {
            input: number
            output: number
            cache: { read: number; write: number }
          }
        }
      },
      _out: {
        temperature?: number
        topP?: number
        topK?: number
        options: Record<string, unknown>
      },
    ) => {
      const err = gate(item)
      if (!err) return
      await mark({
        last_block: "chat.params",
        last_provider: item.model.providerID,
        last_model: item.model.id,
        last_agent: item.agent,
        last_reason: err,
      })
      throw new Error(text(err))
    },
    "experimental.session.compacting": async (
      _item: { sessionID: string },
      out: { context: string[]; prompt?: string },
    ) => {
      const data = await stash(state)
      out.context.push(
        [
          `Guardrail mode: ${mode}.`,
          `Preserve policy state from ${rel(input.worktree, state)} when handing work to the next agent.`,
          `Last guardrail event: ${str(data.last_event) || "none"}.`,
          `Last guardrail block: ${str(data.last_block) || "none"}.`,
          `Unique source reads: ${num(data.read_count)}.`,
          `Edit/write count: ${num(data.edit_count)}.`,
          `Fact-check state: ${factLine(data)}.`,
          `Review state: ${reviewLine(data)}.`,
        ].join(" "),
      )
    },
  }
}
