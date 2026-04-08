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

function json(data: unknown): Record<string, number> {
  if (data && typeof data === "object" && !Array.isArray(data)) return data as Record<string, number>
  return {}
}

async function git(dir: string, args: string[]) {
  const proc = Bun.spawn(["git", "-C", dir, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { stdout, stderr, code }
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

  // --- Delegation gate config ---
  const maxParallelTasks = 5
  const maxSessionCost = 10.0 // USD
  const agentModelTier: Record<string, "high" | "standard" | "low"> = {
    implement: "high",
    security: "high",
    "security-engineer": "high",
    "security-reviewer": "high",
    review: "standard",
    "code-reviewer": "standard",
    explore: "low",
    planner: "standard",
    architect: "high",
    "build-error-resolver": "standard",
    "tdd-guide": "standard",
    investigate: "low",
    "provider-eval": "low",
    "doc-updater": "low",
    "technical-writer": "low",
    "refactor-cleaner": "standard",
    "e2e-runner": "standard",
  }
  const tierModels: Record<string, string[]> = {
    high: ["glm-5.1", "glm-5", "gpt-5.4", "gpt-5.3-codex", "gpt-5.2-codex"],
    standard: ["glm-4.7", "glm-4.6", "gpt-5.2", "gpt-5.1-codex", "gpt-5.1-codex-mini"],
    low: ["glm-4.5-flash", "glm-4.5-air", "gpt-5-mini", "gpt-5-nano"],
  }

  // --- Domain naming patterns ---
  const domainDirs: Record<string, RegExp> = {
    "src/ui/": /^[A-Z][a-zA-Z]*\.(tsx?|jsx?)$/,
    "src/components/": /^[A-Z][a-zA-Z]*\.(tsx?|jsx?)$/,
    "src/api/": /^[a-z][a-zA-Z]*\.(ts|js)$/,
    "src/routes/": /^[a-z][a-zA-Z-]*\.(ts|js)$/,
    "src/util/": /^[a-z][a-zA-Z-]*\.(ts|js)$/,
    "src/lib/": /^[a-z][a-zA-Z-]*\.(ts|js)$/,
    "test/": /\.(test|spec)\.(ts|tsx|js|jsx)$/,
  }

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
        // [W9] auto-init-permissions: detect project stack on session start
        const stacks: string[] = []
        try {
          const { existsSync } = await import("fs")
          if (existsSync(path.join(input.worktree, "package.json"))) stacks.push("node")
          if (existsSync(path.join(input.worktree, "pyproject.toml")) || existsSync(path.join(input.worktree, "requirements.txt"))) stacks.push("python")
          if (existsSync(path.join(input.worktree, "go.mod"))) stacks.push("go")
          if (existsSync(path.join(input.worktree, "Dockerfile")) || existsSync(path.join(input.worktree, "terraform"))) stacks.push("infra")
        } catch { /* fs check may fail */ }

        // [W9] enforce-branch-workflow: check branch on session start
        let branchWarning = ""
        try {
          const branchRes = await git(input.worktree, ["branch", "--show-current"])
          const currentBranch = branchRes.stdout.trim()
          if (/^(main|master)$/.test(currentBranch)) {
            branchWarning = `WARNING: on ${currentBranch} branch. Create a feature branch: git checkout -b feat/<description> develop`
          } else if (currentBranch === "develop") {
            branchWarning = `On develop branch. Use feature branch for implementation: git checkout -b feat/<description>`
          }
        } catch { /* git may fail */ }

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
          // Delegation gates (Map-based tracking for race safety)
          active_tasks: {},
          active_task_count: 0,
          llm_call_count: 0,
          llm_calls_by_provider: {},
          session_providers: [],
          consecutive_failures: 0,
          consecutive_fix_prs: 0,
          last_merge_at: "",
          issue_verification_done: false,
          edits_since_doc_reminder: 0,
          // [W9] auto-init-permissions: detected stacks
          detected_stacks: stacks,
          // [W9] enforce-branch-workflow: branch status
          branch_warning: branchWarning,
        })
        if (stacks.length > 0) {
          await seen("auto_init.stacks_detected", { stacks })
        }
        // [Phase6] Ignore hygiene: check if .opencode/ is in .gitignore
        try {
          const gitignore = await Bun.file(path.join(input.worktree, ".gitignore")).text()
          if (!gitignore.includes(".opencode")) {
            await mark({ gitignore_missing_opencode: true })
            await seen("ignore_hygiene.missing", { pattern: ".opencode/" })
          }
        } catch { /* .gitignore may not exist */ }
        if (branchWarning) {
          await seen("branch_workflow.warning", { warning: branchWarning })
        }
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
        const proc = Bun.spawn(["git", "-C", input.worktree, "fetch", "--dry-run"], {
          stdout: "pipe",
          stderr: "pipe",
        })
        const fetchResult = await Promise.race([
          Promise.all([
            new Response(proc.stdout).text(),
            new Response(proc.stderr).text(),
            proc.exited,
          ]).then(([stdout, stderr, code]) => ({ stdout, stderr, code })),
          Bun.sleep(5000).then(() => {
            proc.kill()
            return null
          }),
        ])
        if (fetchResult && fetchResult.code === 0 && (fetchResult.stdout.trim() || fetchResult.stderr.includes("From"))) {
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
      // Branch hygiene: surface stored branch warning from session.created
      const branchWarn = str(data.branch_warning)
      if (branchWarn) {
        const statusCheck = await git(input.worktree, ["status", "--porcelain"]).catch(() => ({ stdout: "", stderr: "", code: 1 }))
        const dirty = statusCheck.stdout.trim().length > 0 && !statusCheck.stderr.trim()
        out.parts.push({
          id: crypto.randomUUID(),
          sessionID: out.message.sessionID,
          messageID: out.message.id,
          type: "text",
          text: dirty
            ? `${branchWarn} Uncommitted changes detected — stash or commit before switching branches.`
            : branchWarn,
        })
        await mark({ branch_warning: "" })
      }
      // [Phase6] Ignore hygiene advisory
      if (data.gitignore_missing_opencode) {
        out.parts.push({
          id: crypto.randomUUID(),
          sessionID: out.message.sessionID,
          messageID: out.message.id,
          type: "text",
          text: "⚠️ `.opencode/` is not in `.gitignore`. Add it to reduce noise in `git status`.",
        })
        await mark({ gitignore_missing_opencode: false })
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
          const budgetData = await stash(state)
          const readFiles = list(budgetData.read_files).slice(-5).join(", ")
          const err = `context budget exceeded after ${count} source reads (recent: ${readFiles || "unknown"}). Recovery options:\n(1) call \`team\` tool to delegate edit to isolated worker\n(2) use \`background\` tool for side work\n(3) narrow edit scope to a specific function/section rather than whole file\n(4) start a new session and continue from where you left off`
          await mark({ last_block: item.tool, last_file: rel(input.worktree, file), last_reason: err })
          throw new Error(text(err))
        }
      }
      if (item.tool === "bash") {
        const cmd = typeof out.args?.command === "string" ? out.args.command : ""
        const file = cmd.replaceAll("\\", "/")
        if (!cmd) return
        // [HIGH-1 fix] Read state once for all bash checks
        const bashData = await stash(state)
        if (has(file, sec) || file.includes(".opencode/guardrails/")) {
          await mark({ last_block: "bash", last_command: cmd, last_reason: "shell access to protected files" })
          throw new Error(text("shell access to protected files"))
        }
        // [W9] pre-merge: tier-aware gate + CRITICAL/HIGH block (consolidated)
        if (/\bgit\s+merge(\s|$)/i.test(cmd) || /\bgh\s+pr\s+merge(\s|$)/i.test(cmd)) {
          // Check CRITICAL/HIGH first (applies to all tiers)
          const criticalCount = num(bashData.review_critical_count)
          const highCount = num(bashData.review_high_count)
          if (criticalCount > 0 || highCount > 0) {
            const prNum = str(bashData.review_pr_number)
            await mark({ last_block: "bash", last_command: cmd, last_reason: `unresolved CRITICAL=${criticalCount} HIGH=${highCount}` })
            throw new Error(text(`merge blocked: PR #${prNum} has unresolved CRITICAL=${criticalCount} HIGH=${highCount} review findings`))
          }
          try {
            const branch = (await git(input.worktree, ["branch", "--show-current"])).stdout.trim()
            const tier = /^(ci|chore|docs)\//.test(branch) ? "EXEMPT" :
                         /^fix\//.test(branch) ? "LIGHT" : "FULL"
            if (tier === "EXEMPT") {
              await seen("pre_merge.tier", { branch, tier, result: "pass" })
            } else if (tier === "LIGHT") {
              // LIGHT: code-reviewer done OR (checks ran AND C/H=0)
              const codeReviewDone = str(bashData.review_state) === "done"
              const checksRan = Boolean(str(bashData.review_checks_at))
              const noSevere = checksRan && criticalCount === 0 && highCount === 0
              if (!codeReviewDone && !noSevere) {
                await mark({ last_block: "bash", last_command: cmd, last_reason: "LIGHT tier: review or C/H=0 required" })
                throw new Error(text("merge blocked (LIGHT tier): run code-reviewer agent OR run `gh pr checks` with CRITICAL=0 HIGH=0"))
              }
            } else {
              if (str(bashData.review_state) !== "done") {
                await mark({ last_block: "bash", last_command: cmd, last_reason: "FULL tier: review not done" })
                throw new Error(text("merge blocked (FULL tier): run code-reviewer agent before merging"))
              }
            }
          } catch (e) {
            if (String(e).includes("blocked")) throw e
            if (str(bashData.review_state) !== "done") {
              await mark({ last_block: "bash", last_command: cmd, last_reason: "merge blocked: review not done" })
              throw new Error(text("merge blocked: run /review before merging"))
            }
          }
        }
        // CI hard block: verify all checks are green before gh pr merge
        if (/\bgh\s+pr\s+merge\b/i.test(cmd)) {
          try {
            const prMatch = cmd.match(/\bgh\s+pr\s+merge\s+(\d+)/i)
            const prArg = prMatch ? prMatch[1] : ""
            const proc = Bun.spawn(["gh", "pr", "checks", ...(prArg ? [prArg] : [])], {
              cwd: input.worktree,
              stdout: "pipe",
              stderr: "pipe",
            })
            const [ciOut] = await Promise.all([
              new Response(proc.stdout).text(),
              new Response(proc.stderr).text(),
              proc.exited,
            ])
            if (proc.exitCode !== 0 || /fail|pending/i.test(ciOut)) {
              await mark({ last_block: "bash", last_command: cmd, last_reason: "CI checks not all green" })
              throw new Error(text("merge blocked: CI checks not all green — run `gh pr checks` to verify"))
            }
          } catch (e) {
            if (String(e).includes("blocked")) throw e
            // gh unavailable or network failure — log so CI skip is observable
            await mark({ last_block: "bash:ci-warn", last_command: cmd, last_reason: "CI check verification failed" })
            await seen("ci.check_verification_failed", { error: String(e) })
          }
        }
        // [Phase6] Unresolved review comments: block merge if CHANGES_REQUESTED
        if (/\bgh\s+pr\s+merge\b/i.test(cmd)) {
          try {
            const repoRes = await git(input.worktree, ["remote", "get-url", "origin"])
            const repo = repoRes.stdout.trim().replace(/.*github\.com[:/]/, "").replace(/\.git$/, "")
            const prMatch2 = cmd.match(/\bgh\s+pr\s+merge\s+(\d+)/i)
            const prNum2 = prMatch2 ? prMatch2[1] : ""
            if (repo && prNum2) {
              const proc2 = Bun.spawn(["gh", "api", `repos/${repo}/pulls/${prNum2}/reviews`, "--jq", "[.[] | select(.state==\"CHANGES_REQUESTED\")] | length"], {
                cwd: input.worktree, stdout: "pipe", stderr: "pipe",
              })
              const [revOut] = await Promise.all([new Response(proc2.stdout).text(), proc2.exited])
              if (parseInt(revOut.trim()) > 0) {
                await mark({ last_block: "bash", last_command: cmd, last_reason: "unresolved CHANGES_REQUESTED reviews" })
                throw new Error(text("merge blocked: unresolved CHANGES_REQUESTED reviews — address reviewer feedback first"))
              }
            }
          } catch (e) { if (String(e).includes("blocked")) throw e }
        }
        // [Phase6] Stacked PR rebase gate: warn if child PRs exist and are stale
        if (/\bgh\s+pr\s+merge\b/i.test(cmd)) {
          try {
            const curBranch = (await git(input.worktree, ["branch", "--show-current"])).stdout.trim()
            if (curBranch) {
              const proc3 = Bun.spawn(["gh", "pr", "list", "--base", curBranch, "--json", "number,headRefName", "--jq", ".[].number"], {
                cwd: input.worktree, stdout: "pipe", stderr: "pipe",
              })
              const [childOut] = await Promise.all([new Response(proc3.stdout).text(), proc3.exited])
              const childPRs = childOut.trim().split("\n").filter(Boolean)
              if (childPRs.length > 0) {
                out.output = (out.output || "") + `\n⚠️ Stacked PR detected: ${childPRs.length} child PR(s) depend on this branch. Rebase child PRs after merging.`
                await seen("stacked_pr.children_detected", { count: childPRs.length, children: childPRs })
              }
            }
          } catch { /* gh may fail */ }
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
        // [W9] enforce-develop-base: block branch creation from main when develop exists
        if (/\bgit\s+(checkout\s+-b|switch\s+-c)\b/i.test(cmd)) {
          try {
            const devCheck = await git(input.worktree, ["rev-parse", "--verify", "origin/develop"])
            if (devCheck.stdout.trim()) {
              const branch = (await git(input.worktree, ["branch", "--show-current"])).stdout.trim()
              if (/^(main|master)$/.test(branch)) {
                await mark({ last_block: "bash", last_command: cmd, last_reason: "branch creation from main blocked" })
                throw new Error(text("branch creation from main blocked: checkout develop first, then create branch"))
              }
            }
          } catch (e) { if (String(e).includes("blocked")) throw e }
        }
        // [W9] block-manual-merge-ops: block cherry-pick, arbitrary rebase/merge, branch rename
        if (/\bgit\s+(cherry-pick)\b/i.test(cmd) && !/--abort\b/i.test(cmd)) {
          await mark({ last_block: "bash", last_command: cmd, last_reason: "cherry-pick blocked: delegate to Codex CLI" })
          throw new Error(text("cherry-pick blocked: delegate to Codex CLI for context-heavy merge operations"))
        }
        if (/\bgit\s+rebase\b/i.test(cmd) && !/--abort\b/i.test(cmd)) {
          if (/\bgit\s+rebase\s+(origin\/)?(main|master|develop)\b/i.test(cmd)) {
            await mark({ rebase_session_active: true, rebase_session_at: new Date().toISOString() })
          } else if (/\bgit\s+rebase\s+--(continue|skip)\b/i.test(cmd)) {
            const d = await stash(state)
            const at = str(d.rebase_session_at)
            if (!at || Date.now() - new Date(at).getTime() > 3600_000) {
              await mark({ last_block: "bash", last_command: cmd, last_reason: "rebase --continue/--skip: no active session" })
              throw new Error(text("rebase --continue/--skip blocked: no active permitted rebase session (1h expiry)"))
            }
          } else {
            await mark({ last_block: "bash", last_command: cmd, last_reason: "arbitrary rebase blocked" })
            throw new Error(text("arbitrary rebase blocked: only sync from main/master/develop is permitted"))
          }
        }
        if (/\bgit\s+branch\s+(-[mMfF]\b|--move\b|--force\b)/i.test(cmd)) {
          await mark({ last_block: "bash", last_command: cmd, last_reason: "branch rename/force-move blocked" })
          throw new Error(text("branch rename/force-move blocked: prevents commit guard bypass"))
        }
        // Enforce soak time: develop→main merge requires half-day minimum
        if (/\bgit\s+merge(\s|$)/i.test(cmd) || /\bgh\s+pr\s+merge(\s|$)/i.test(cmd)) {
          const lastMerge = str(bashData.last_merge_at)
          if (lastMerge) {
            const elapsed = Date.now() - new Date(lastMerge).getTime()
            const halfDay = 12 * 60 * 60 * 1000
            if (elapsed < halfDay) {
              const hours = Math.round(elapsed / (60 * 60 * 1000) * 10) / 10
              await mark({ soak_time_warning: true, soak_time_elapsed_h: hours })
              await seen("soak_time.advisory", { elapsed_ms: elapsed, required_ms: halfDay })
            }
          }
        }
        // Enforce follow-up limit: detect 2+ consecutive fix PRs on same feature
        if (/\bgh\s+pr\s+create\b/i.test(cmd)) {
          const consecutiveFixes = num(bashData.consecutive_fix_prs)
          if (consecutiveFixes >= 2) {
            await seen("follow_up.limit_reached", { consecutive: consecutiveFixes })
          }
        }
        // Enforce issue close verification: require evidence before gh issue close
        if (/\bgh\s+issue\s+close\b/i.test(cmd)) {
          if (!flag(bashData.issue_verification_done)) {
            await seen("issue_close.unverified", { command: cmd })
          }
        }
        // [W9] audit-docker-build-args upgrade: full secret pattern scan + hard block
        if (/\bdocker\s+build\b/i.test(cmd)) {
          const secretPatterns = [
            /^(AKIA[A-Z0-9]{16})/,           // AWS access key
            /^(sk-[a-zA-Z0-9]{20,})/,        // OpenAI/Stripe key
            /^(ghp_[a-zA-Z0-9]{36})/,        // GitHub PAT
            /^(gho_[a-zA-Z0-9]{36})/,        // GitHub OAuth
            /^(ghs_[a-zA-Z0-9]{36})/,        // GitHub App
            /^(glpat-[a-zA-Z0-9-]{20,})/,    // GitLab PAT
            /^(xox[bprs]-[a-zA-Z0-9-]+)/,    // Slack token
            /^(npm_[a-zA-Z0-9]{36})/,        // npm token
            /BEGIN\s+(RSA|EC|PRIVATE)/,       // Private key header
          ]
          const buildArgMatches = cmd.matchAll(/--build-arg\s+(\w+)=(\S+)/gi)
          for (const m of buildArgMatches) {
            const argName = m[1].toUpperCase()
            const argValue = m[2]
            const nameHit = /(SECRET|TOKEN|KEY|PASSWORD|CREDENTIAL|API_KEY|PRIVATE|AUTH)/i.test(argName)
            const valueHit = secretPatterns.some((p) => p.test(argValue))
            if (nameHit || valueHit) {
              await mark({ docker_secret_warning: true, docker_secret_arg: m[1], last_block: "bash", last_reason: "docker secret in build-arg" })
              await seen("docker.secret_in_build_arg", { arg_name: m[1], pattern: "redacted" })
              throw new Error(text("docker build --build-arg contains secrets: use Docker build secrets (--secret) or multi-stage builds instead"))
            }
          }
        }
        // [W9] enforce-review-reading upgrade: hard block merge if review is stale
        if (/\bgh\s+pr\s+merge\b/i.test(cmd)) {
          const reviewAt = str(bashData.review_at)
          const lastPushAt = str(bashData.last_push_at)
          if (reviewAt && lastPushAt && new Date(reviewAt) < new Date(lastPushAt)) {
            await mark({ review_reading_warning: true, last_block: "bash", last_reason: "stale review: push after review" })
            await seen("review_reading.stale", { review_at: reviewAt, last_push_at: lastPushAt })
            throw new Error(text("merge blocked: code was pushed after the last review. Re-request review before merging."))
          }
        }
        // [W9] enforce-deploy-verify-on-pr: require deploy evidence for infra changes
        if (/\bgh\s+pr\s+create\b/i.test(cmd)) {
          try {
            const diffRes = await git(input.worktree, ["diff", "--name-only", "origin/develop...HEAD"])
            const changedFiles = diffRes.stdout.trim()
            const hasInfra = /^(hooks\/|scripts\/)[^/]+\.sh$/m.test(changedFiles)
            if (hasInfra) {
              if (!flag(bashData.deploy_verified)) {
                await seen("deploy_verify.missing", { files: changedFiles.split("\n").filter((f: string) => /^(hooks|scripts)\//.test(f)) })
                // Advisory only — not blocking, but strongly recommended
                await mark({ deploy_verify_warning: true })
              }
            }
          } catch { /* git diff may fail — non-blocking */ }
        }
        // [W9] pr-guard upgrade: hard block for missing issue ref + --base main
        if (/\bgh\s+pr\s+create\b/i.test(cmd)) {
          // Block: --base main when develop exists
          if (/--base\s+main(\s|$)/i.test(cmd)) {
            try {
              const devCheck = await git(input.worktree, ["rev-parse", "--verify", "origin/develop"])
              if (devCheck.stdout.trim()) {
                // Allow release PR from develop
                const branch = (await git(input.worktree, ["branch", "--show-current"])).stdout.trim()
                if (branch !== "develop" && !/--head\s+develop/i.test(cmd)) {
                  await mark({ last_block: "bash", last_command: cmd, last_reason: "PR targeting main when develop exists" })
                  throw new Error(text("PR targeting main blocked: use --base develop. Release PRs must be from develop branch."))
                }
              }
            } catch (e) { if (String(e).includes("blocked")) throw e }
          }
          // Advisory: missing issue reference (Closes/Fixes/Resolves #XX)
          // Note: cmd may not contain --body content (editor-based flow), so advisory not hard block
          if (!/\b(closes?|fixes?|resolves?)\s*#\d+/i.test(cmd) && !/#\d+/i.test(cmd)) {
            await mark({ pr_guard_issue_ref_warning: true })
            await seen("pr_guard.missing_issue_ref", { command: cmd.slice(0, 200) })
          }
          // Advisory: preflight checks
          const testRan = flag(bashData.tests_executed)
          const typeChecked = flag(bashData.type_checked)
          if (!testRan || !typeChecked) {
            await mark({ pr_guard_warning: true, pr_guard_tests: testRan, pr_guard_types: typeChecked })
            await seen("pr_guard.preflight_incomplete", { tests: testRan, types: typeChecked })
          }
        }
        // [NEW] stop-test-gate: block ship/deploy without test verification
        if (/\b(git\s+push|gh\s+pr\s+merge)\b/i.test(cmd) && !/\bfetch\b/i.test(cmd)) {
          if (!flag(bashData.tests_executed) && num(bashData.edit_count) >= 3) {
            await mark({ stop_test_warning: true })
            await seen("stop_test_gate.untested", { edit_count: num(bashData.edit_count) })
          }
        }
        if (!bash(cmd)) return
        if (!cfg.some((rule) => rule.test(file)) && !file.includes(".opencode/guardrails/")) return
        await mark({ last_block: "bash", last_command: cmd, last_reason: "protected runtime or config mutation" })
        throw new Error(text("protected runtime or config mutation"))
      }
      // [W9] enforce-seed-data-verification: block seed/knowledge file writes without verification
      if ((item.tool === "write") && file) {
        const relFile = rel(input.worktree, file)
        if (/seed_knowledge|knowledge\.(yaml|yml|json)$/i.test(relFile)) {
          const content = typeof out.args?.content === "string" ? out.args.content : ""
          if (content && /(電話|phone|営業時間|hours|休[館日]|holiday|料金|price|住所|address)/i.test(content)) {
            if (!/(verified|検証済|参照元|source:|ref:)/i.test(content)) {
              await mark({ last_block: "write", last_file: relFile, last_reason: "seed data without verification source" })
              throw new Error(text("knowledge/seed data write blocked: content contains factual claims without verification source. Add 'verified' or 'source:' comment."))
            }
          }
        }
      }
      // Delegation: parallel execution gate for task tool (Map-based to avoid race conditions)
      if (item.tool === "task") {
        const data = await stash(state)
        const activeTasks = json(data.active_tasks)
        const staleThreshold = 5 * 60 * 1000
        // Staleness recovery: remove entries older than 5 minutes (crash protection)
        for (const [id, ts] of Object.entries(activeTasks)) {
          if (typeof ts === "number" && Date.now() - ts > staleThreshold) {
            await seen("delegation.stale_reset", { task_id: id, age_ms: Date.now() - ts })
            delete activeTasks[id]
          }
        }
        const activeCount = Object.keys(activeTasks).length
        if (activeCount >= maxParallelTasks) {
          const err = `parallel task limit reached (${activeCount}/${maxParallelTasks}); wait for a running task to complete before delegating more`
          await mark({ last_block: "task", last_reason: err, active_tasks: activeTasks })
          throw new Error(text(err))
        }
        const callID = str((item as Record<string, unknown>).callID) || str((item.args as Record<string, unknown>)?.callID) || `task_${Date.now()}`
        activeTasks[callID] = Date.now()
        await mark({ active_tasks: activeTasks, active_task_count: Object.keys(activeTasks).length })
      }
      // Domain naming advisory for new file creation (flag for user-visible output in after hook)
      if (item.tool === "write" && file) {
        const relFile = rel(input.worktree, file)
        const fileName = path.basename(relFile)
        for (const [dir, pattern] of Object.entries(domainDirs)) {
          if (relFile.startsWith(dir) && !pattern.test(fileName)) {
            await mark({ domain_naming_warning: relFile, domain_naming_expected: pattern.source, domain_naming_dir: dir })
            await seen("domain_naming.mismatch", { file: relFile, expected_pattern: pattern.source, dir })
          }
        }
      }
    },
    "tool.execute.after": async (
      item: { tool: string; args?: Record<string, unknown> },
      out: { title: string; output: string; metadata: Record<string, unknown> },
    ) => {
      const now = new Date().toISOString()
      const file = pick(item.args)
      const data = await stash(state)

      // [HIGH-3 fix] TOCTOU check at START of after-hook (before any mark() calls)
      try {
        const prevSha = str(data.state_sha256)
        if (prevSha) {
          const { state_sha256: _s, updated_at: _u, ...rest } = data
          const hasher = new Bun.CryptoHasher("sha256")
          hasher.update(JSON.stringify(rest))
          const actualSha = hasher.digest("hex")
          if (prevSha !== actualSha) {
            await seen("state_integrity.toctou_detected", { expected: prevSha, actual: actualSha })
          }
        }
      } catch { /* hash check is best-effort */ }

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
        // Reset review_state on mutating bash commands (sed -i, redirects, etc.)
        if (bash(cmd)) {
          await mark({
            edits_since_review: num(data.edits_since_review) + 1,
            review_state: "",
          })
        }
      }

      if ((item.tool === "edit" || item.tool === "write" || item.tool === "apply_patch") && file) {
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

        if (/\.(test|spec)\.(ts|tsx|js|jsx)$|(^|\/)test_.*\.py$|_test\.go$/.test(rel(input.worktree, file))) {
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

      // Architecture layer advisory
      if ((item.tool === "edit" || item.tool === "write") && file && code(file)) {
        const relFile = rel(input.worktree, file)
        const content = typeof item.args?.content === "string" ? item.args.content :
                        typeof item.args?.newString === "string" ? item.args.newString : ""
        if (content) {
          const isUI = /^(src\/(ui|components|tui)\/)/i.test(relFile)
          const isAPI = /^(src\/(api|routes)\/)/i.test(relFile)
          const importsDB = /from\s+['"].*\/(db|database|model|sql)\//i.test(content)
          const importsUI = /from\s+['"].*\/(ui|components|tui)\//i.test(content)
          if (isUI && importsDB) {
            out.output += "\n⚠️ Architecture: UI layer importing from DB layer directly. Consider using a service/repository layer."
          }
          if (isAPI && importsUI) {
            out.output += "\n⚠️ Architecture: API layer importing from UI layer. This creates a circular dependency risk."
          }
        }
      }

      // [W9] inject-claude-review-on-checks: track review severity from gh pr checks output
      if (item.tool === "bash" && /\bgh\s+pr\s+checks\b/i.test(str(item.args?.command))) {
        // Parse gh pr checks output for review comment severity hints
        const checksOutput = out.output || ""
        const criticalMatches = checksOutput.match(/CRITICAL[=:]?\s*(\d+)/i)
        const highMatches = checksOutput.match(/HIGH[=:]?\s*(\d+)/i)
        const prNumMatch = str(item.args?.command).match(/\bgh\s+pr\s+checks\s+(\d+)/i)
        if (criticalMatches || highMatches || prNumMatch) {
          await mark({
            review_critical_count: criticalMatches ? parseInt(criticalMatches[1]) : 0,
            review_high_count: highMatches ? parseInt(highMatches[1]) : 0,
            review_pr_number: prNumMatch ? prNumMatch[1] : "",
            review_checks_at: now,
          })
        }
      }

      // CI status advisory after push/PR create
      if (item.tool === "bash" && /\b(git\s+push|gh\s+pr\s+create)\b/i.test(str(item.args?.command))) {
        out.output = (out.output || "") + "\n⚠️ Remember to verify CI status: `gh pr checks`"
        // [Phase6] PR mergeable conflict check
        try {
          const proc = Bun.spawn(["gh", "pr", "view", "--json", "mergeable", "--jq", ".mergeable"], {
            cwd: input.worktree, stdout: "pipe", stderr: "pipe",
          })
          const [mergeOut] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
          const mergeable = mergeOut.trim()
          if (mergeable === "CONFLICTING") {
            out.output += "\n⚠️ PR has merge conflicts. Rebase or merge the base branch before proceeding."
            await seen("pr.merge_conflict_detected", {})
          }
        } catch { /* gh may fail in offline/no-PR scenarios */ }
      }

      // Post-merge deployment verification advisory
      if (item.tool === "bash" && /\bgh\s+pr\s+merge\b/i.test(str(item.args?.command))) {
        out.output = (out.output || "") + "\n🚀 Post-merge: verify deployment status and run smoke tests on the target environment."
        // [W9] enforce-post-merge-validation: detect high-risk changes in merged PR
        try {
          const prMatch = str(item.args?.command).match(/\bgh\s+pr\s+merge\s+(\d+)/i)
          if (prMatch) {
            const prNum = prMatch[1]
            const repoRes = await git(input.worktree, ["remote", "get-url", "origin"])
            const repo = repoRes.stdout.trim().replace(/.*github\.com[:/]/, "").replace(/\.git$/, "")
            if (repo) {
              const proc = Bun.spawn(["gh", "api", `repos/${repo}/pulls/${prNum}/files`, "--jq", ".[].filename"], {
                cwd: input.worktree, stdout: "pipe", stderr: "pipe",
              })
              const [filesOut] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
              const files = filesOut.trim()
              const risks: string[] = []
              if (/^terraform\/|\.tf$/m.test(files)) risks.push("Terraform")
              if (/migration|migrate|\.sql$/im.test(files)) risks.push("Migration/DDL")
              if (/^\.github\/workflows\//m.test(files)) risks.push("GitHub Actions")
              if (/Dockerfile|docker-compose|cloudbuild/im.test(files)) risks.push("Docker/Cloud Build")
              if (/deploy|release/im.test(files)) risks.push("Deploy/Release")
              if (risks.length > 0) {
                out.output += "\n\n⚠️ [POST-MERGE VALIDATION] High-risk changes detected: " + risks.join(", ") + ".\nChecklist: HTTP 200, HTTPS, no errors in logs, migration rollback plan, Terraform plan attached, Docker --platform linux/amd64."
                await seen("post_merge.validation_required", { pr: prNum, risks })
              }
            }
          }
        } catch { /* gh api may fail — non-blocking */ }
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
        // Delegation: remove completed task from active tasks map
        const activeTasks = json(data.active_tasks)
        const callID = str((item as Record<string, unknown>).callID) || str(item.args?.callID) || ""
        if (callID && activeTasks[callID]) {
          delete activeTasks[callID]
          await mark({ active_tasks: activeTasks, active_task_count: Object.keys(activeTasks).length })
        } else if (Object.keys(activeTasks).length > 0) {
          // Fallback: remove oldest entry if callID not found
          const oldest = Object.entries(activeTasks).sort((a, b) => a[1] - b[1])[0]
          if (oldest) delete activeTasks[oldest[0]]
          await mark({ active_tasks: activeTasks, active_task_count: Object.keys(activeTasks).length })
        }
        // Delegation: track per-agent delegation count
        const agentDelegations = num(data[`delegation_${agent}`])
        await mark({ [`delegation_${agent}`]: agentDelegations + 1 })

        // Verify agent output: parse <task_result> payload to detect empty responses
        const rawOutput = str(out.output)
        const taskResultMatch = rawOutput.match(/<task_result>([\s\S]*?)<\/task_result>/)
        const payload = taskResultMatch ? taskResultMatch[1].trim() : rawOutput.trim()
        if (agent && payload.length < 20) {
          out.output = (out.output || "") + "\n⚠️ Agent output appears empty or trivially short (" + payload.length + " chars). Verify the agent completed its task."
          await seen("verify_agent.short_output", { agent, payload_length: payload.length })
        }
      }

      // Tool failure recovery: detect consecutive failures via metadata exit code
      const exitCode = typeof out.metadata?.exitCode === "number" ? out.metadata.exitCode : undefined
      const isBashFail = item.tool === "bash" && exitCode !== undefined && exitCode !== 0
      const isToolError = out.title === "Error" || (typeof out.metadata?.error === "string" && out.metadata.error !== "")
      if (isBashFail || isToolError) {
        const failures = num(data.consecutive_failures) + 1
        await mark({ consecutive_failures: failures, last_failure_tool: item.tool })
        if (failures >= 3) {
          out.output = (out.output || "") + "\n⚠️ " + failures + " consecutive tool failures detected. Consider: (1) checking error root cause, (2) trying alternate approach, (3) delegating to a specialist agent."
        }
      } else if (item.tool !== "read") {
        if (num(data.consecutive_failures) > 0) {
          await mark({ consecutive_failures: 0 })
        }
      }

      // Post-merge: track merge timestamp for soak time and suggest issue close
      if (item.tool === "bash" && /\bgh\s+pr\s+merge\b/i.test(str(item.args?.command))) {
        await mark({ last_merge_at: now })
        if (/\b(fix(es)?|close[sd]?|resolve[sd]?)\s+#\d+/i.test(out.output)) {
          out.output = (out.output || "") + "\n📋 Detected issue reference in merge output. Verify referenced issues are closed."
        }
      }
      // Soak time advisory: surface warning set during tool.execute.before
      if (item.tool === "bash" && (/\bgit\s+merge(\s|$)/i.test(str(item.args?.command)) || /\bgh\s+pr\s+merge(\s|$)/i.test(str(item.args?.command)))) {
        const freshData = await stash(state)
        if (flag(freshData.soak_time_warning)) {
          const hours = num(freshData.soak_time_elapsed_h)
          out.output = (out.output || "") + "\n⏳ Soak time advisory: only " + hours + "h since last merge (12h recommended). Consider waiting before merging to main."
          await mark({ soak_time_warning: false })
        }
      }

      // [W9] workflow-sync-guard: warn when workflow files differ from main after push
      if (item.tool === "bash" && /\bgit\s+push\b/i.test(str(item.args?.command))) {
        try {
          const branch = (await git(input.worktree, ["branch", "--show-current"])).stdout.trim()
          if (branch && !/^(main|master)$/.test(branch)) {
            const wfDiff = await git(input.worktree, ["diff", "--name-only", "main..HEAD", "--", ".github/workflows/"])
            const wfFiles = wfDiff.stdout.trim()
            if (wfFiles) {
              out.output += "\n\n⚠️ [WORKFLOW SYNC] .github/workflows/ files differ from main:\n" +
                wfFiles.split("\n").map((f: string) => "  - " + f).join("\n") +
                "\nOIDC validation requires workflow files to match the default branch. Create a chore PR to sync."
              await seen("workflow_sync.diverged", { branch, files: wfFiles.split("\n") })
            }
          }
        } catch { /* git may fail — non-blocking */ }
      }

      // Memory update reminder after git commit
      if (item.tool === "bash" && /\bgit\s+commit\b/i.test(str(item.args?.command))) {
        const editCount = num(data.edit_count)
        if (editCount >= 5) {
          out.output = (out.output || "") + "\n🧠 Significant changes committed (" + editCount + " edits). Consider updating memory with key decisions or learnings."
        }
      }

      // [W9] post-pr-create-review-trigger: suggest review after PR creation
      if (item.tool === "bash" && /\bgh\s+pr\s+create\b/i.test(str(item.args?.command))) {
        const prUrl = (out.output || "").match(/github\.com\/[^/]+\/[^/]+\/pull\/(\d+)/)?.[1]
        if (prUrl) {
          await mark({ review_pending: true, review_pending_pr: prUrl })
          out.output += "\n\n📋 [AUTO-REVIEW REQUIRED] PR #" + prUrl + " created. Run code-reviewer agent and address all CRITICAL/HIGH findings before merging."
          await seen("post_pr_create.review_trigger", { pr: prUrl })
        }
      }

      // Track fix PR creation for follow-up limit
      if (item.tool === "bash" && /\bgh\s+pr\s+create\b/i.test(str(item.args?.command))) {
        const cmd = str(item.args?.command)
        if (/--title\s+["']?fix/i.test(cmd) || /\bfix\//i.test(cmd)) {
          const consecutiveFixes = num(data.consecutive_fix_prs) + 1
          await mark({ consecutive_fix_prs: consecutiveFixes })
          if (consecutiveFixes >= 2) {
            out.output = (out.output || "") + "\n⚠️ Feature freeze warning: " + consecutiveFixes + " consecutive fix PRs on the same feature. Consider stabilizing before adding more changes."
          }
        } else {
          await mark({ consecutive_fix_prs: 0 })
        }
      }

      // Domain naming advisory: surface warning set during tool.execute.before
      if ((item.tool === "write") && file) {
        const freshData = await stash(state)
        const warningFile = str(freshData.domain_naming_warning)
        if (warningFile && warningFile === rel(input.worktree, file)) {
          out.output = (out.output || "") + "\n📛 Domain naming mismatch: " + warningFile + " does not match expected pattern /" + str(freshData.domain_naming_expected) + "/ for " + str(freshData.domain_naming_dir)
          await mark({ domain_naming_warning: "" })
        }
      }
      // Endpoint dataflow advisory: detect API endpoint modifications
      if ((item.tool === "edit" || item.tool === "write") && file && code(file)) {
        const relFile = rel(input.worktree, file)
        const content = typeof item.args?.content === "string" ? item.args.content :
                        typeof item.args?.newString === "string" ? item.args.newString : ""
        if (content && /\b(router\.(get|post|put|patch|delete)|app\.(get|post|put|patch|delete)|fetch\(|axios\.|\.handler)\b/i.test(content)) {
          out.output = (out.output || "") + "\n🔄 Endpoint modification detected in " + relFile + ". Verify 4-point dataflow: client → API route → backend action → response format."
          await seen("endpoint_dataflow.modified", { file: relFile })
        }
      }

      // Doc update scope: remind about related documentation when modifying source
      if ((item.tool === "edit" || item.tool === "write") && file && code(file)) {
        const relFile = rel(input.worktree, file)
        const editsSinceDocCheck = num(data.edits_since_doc_reminder)
        if (editsSinceDocCheck >= 5) {
          out.output = (out.output || "") + "\n📄 " + (editsSinceDocCheck + 1) + " source edits since last doc check. Grep for references to modified files in docs/ and README."
          await mark({ edits_since_doc_reminder: 0 })
        } else {
          await mark({ edits_since_doc_reminder: editsSinceDocCheck + 1 })
        }
      }

      // Task completion gate: ensure task claims are backed by evidence
      if (item.tool === "bash" && /\b(gh\s+issue\s+close)\b/i.test(str(item.args?.command))) {
        const reviewed = flag(data.reviewed)
        const factchecked = flag(data.factchecked)
        if (!reviewed || !factchecked) {
          out.output = (out.output || "") + "\n⚠️ Issue close without full verification: reviewed=" + reviewed + ", factchecked=" + factchecked + ". Ensure acceptance criteria have code-level evidence."
          await seen("task_completion.incomplete", { reviewed, factchecked })
        }
        // Only mark verified when both conditions are met — prevents suppressing future reminders
        if (reviewed && factchecked) {
          await mark({ issue_verification_done: true })
        }
      }

      // [NEW] Track test execution for pr-guard and stop-test-gate
      if (item.tool === "bash") {
        const cmd = str(item.args?.command)
        if (/\b(bun\s+test|bun\s+turbo\s+test|jest|vitest|pytest|go\s+test|cargo\s+test)\b/i.test(cmd)) {
          const exitCode = typeof out.metadata?.exitCode === "number" ? out.metadata.exitCode : undefined
          await mark({ tests_executed: true, last_test_at: now, last_test_exit: exitCode ?? "unknown" })
        }
        if (/\b(bun\s+turbo\s+typecheck|tsc|tsgo)\b/i.test(cmd)) {
          await mark({ type_checked: true, last_typecheck_at: now })
        }
        // Track push for review-reading staleness detection
        if (/\bgit\s+push\b/i.test(cmd)) {
          await mark({ last_push_at: now })
        }
      }

      // [NEW] audit-docker-build-args: surface warning
      if (item.tool === "bash" && /\bdocker\s+build\b/i.test(str(item.args?.command))) {
        const freshData = await stash(state)
        if (flag(freshData.docker_secret_warning)) {
          out.output = (out.output || "") + "\n🔐 Security: --build-arg '" + str(freshData.docker_secret_arg) + "' may contain secrets. Use Docker build secrets (--secret) or multi-stage builds instead."
          await mark({ docker_secret_warning: false })
        }
      }

      // [NEW] enforce-review-reading: surface stale review warning
      if (item.tool === "bash" && /\bgh\s+pr\s+merge\b/i.test(str(item.args?.command))) {
        const freshData = await stash(state)
        if (flag(freshData.review_reading_warning)) {
          out.output = (out.output || "") + "\n📖 Stale review: code was pushed after the last review. Re-request review before merging."
          await mark({ review_reading_warning: false })
        }
      }

      // [NEW] pr-guard: surface preflight warning
      if (item.tool === "bash" && /\bgh\s+pr\s+create\b/i.test(str(item.args?.command))) {
        const freshData = await stash(state)
        if (flag(freshData.pr_guard_warning)) {
          const tests = flag(freshData.pr_guard_tests)
          const types = flag(freshData.pr_guard_types)
          const missing = [!tests && "tests", !types && "typecheck"].filter(Boolean).join(", ")
          out.output = (out.output || "") + "\n🛡️ PR guard: " + missing + " not yet run this session. Run `bun turbo test:ci && bun turbo typecheck` before creating PR."
          await mark({ pr_guard_warning: false })
        }
      }

      // [W9] enforce-deploy-verify-on-pr: surface deploy verification warning
      if (item.tool === "bash" && /\bgh\s+pr\s+create\b/i.test(str(item.args?.command))) {
        const freshData = await stash(state)
        if (flag(freshData.deploy_verify_warning)) {
          out.output = (out.output || "") + "\n🚀 Deploy verification: changed hooks/scripts detected but not yet deployed. Run setup.sh and verify firing before merging."
          await mark({ deploy_verify_warning: false })
        }
      }

      // [NEW] stop-test-gate: surface untested push/merge warning
      if (item.tool === "bash" && /\b(git\s+push|gh\s+pr\s+merge)\b/i.test(str(item.args?.command))) {
        const freshData = await stash(state)
        if (flag(freshData.stop_test_warning)) {
          out.output = (out.output || "") + "\n🚫 Test gate: " + num(freshData.edit_count) + " edits without running tests. Run tests before pushing/merging."
          await mark({ stop_test_warning: false })
        }
      }

      // [W9] verify-state-file-integrity: update SHA-256 at end of hook cycle
      try {
        const finalData = await stash(state)
        if (finalData && typeof finalData === "object" && !Array.isArray(finalData)) {
          const { state_sha256: _s, updated_at: _u, ...rest } = finalData
          const hasher = new Bun.CryptoHasher("sha256")
          hasher.update(JSON.stringify(rest))
          await save(state, { ...finalData, state_sha256: hasher.digest("hex"), updated_at: now })
        } else {
          await seen("state_integrity.corrupted", { reason: Array.isArray(finalData) ? "array" : "non-object" })
          await save(state, { mode, repaired_at: now, repair_reason: "corrupted state repaired" })
        }
      } catch {
        await seen("state_integrity.parse_error", { file: state })
        await save(state, { mode, repaired_at: now, repair_reason: "JSON parse failure" })
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
        maxOutputTokens?: number | undefined
        options: Record<string, unknown>
      },
    ) => {
      // Provider admission gate (existing)
      const err = gate(item)
      if (err) {
        await mark({
          last_block: "chat.params",
          last_provider: item.model.providerID,
          last_model: item.model.id,
          last_agent: item.agent,
          last_reason: err,
        })
        throw new Error(text(err))
      }

      // Multi-model delegation: provider-aware routing + tier advisory (OpenCode advantage)
      const provider = str(item.model.providerID)
      const modelId = str(item.model.id)
      const tier = agentModelTier[item.agent]
      if (tier && modelId) {
        const currentTier = Object.entries(tierModels).find(([, models]) => models.includes(modelId))?.[0]
        // Detect tier mismatch: high-tier agent on low-tier model (or vice versa for cost waste)
        if (currentTier) {
          const tierOrder = { high: 3, standard: 2, low: 1 }
          const expected = tierOrder[tier] ?? 2
          const actual = tierOrder[currentTier as keyof typeof tierOrder] ?? 2
          if (expected > actual) {
            const recommended = tierModels[tier] ?? []
            await seen("delegation.model_mismatch", {
              agent: item.agent,
              expected_tier: tier,
              actual_tier: currentTier,
              model: modelId,
              provider,
              recommended: recommended.slice(0, 3),
            })
            // User-visible advisory via stderr injection is not available in chat.params,
            // so we log to state for compacting context to pick up
            await mark({
              last_model_mismatch: `${item.agent} (${tier}-tier) running on ${modelId} (${currentTier}-tier). Recommended: ${recommended.slice(0, 3).join(", ")}`,
            })
          }
          // Cost waste detection: low-tier agent using high-tier model
          if (expected < actual && tier === "low" && currentTier === "high") {
            await seen("delegation.cost_waste", {
              agent: item.agent,
              tier,
              model: modelId,
              provider,
            })
          }
        }
        // Provider-tier recommendation: suggest optimal providers per tier
        const providerTiers: Record<string, string[]> = {
          high: ["zai-coding-plan", "openai"],
          standard: ["zai-coding-plan", "openai", "openrouter"],
          low: ["openrouter", "zai-coding-plan"],
        }
        const recommendedProviders = providerTiers[tier] ?? []
        if (recommendedProviders.length > 0 && !recommendedProviders.includes(provider)) {
          await seen("delegation.provider_suboptimal", {
            agent: item.agent,
            tier,
            current_provider: provider,
            recommended_providers: recommendedProviders,
          })
        }
      }

      // Per-provider cost tracking: count LLM invocations by provider (OpenCode multi-model tracking)
      const data = await stash(state)
      const llmCalls = num(data.llm_call_count) + 1
      const providerCalls = json(data.llm_calls_by_provider)
      providerCalls[provider] = (providerCalls[provider] ?? 0) + 1
      const sessionProviders = list(data.session_providers)
      const updatedProviders = sessionProviders.includes(provider) ? sessionProviders : [...sessionProviders, provider]
      await mark({
        llm_call_count: llmCalls,
        llm_calls_by_provider: providerCalls,
        session_providers: updatedProviders,
        last_provider: provider,
        last_model: modelId,
        last_agent: item.agent,
      })
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
          `Active tasks: ${num(data.active_task_count)} (Map entries: ${Object.keys(json(data.active_tasks)).length}).`,
          `LLM calls: ${num(data.llm_call_count)} (by provider: ${JSON.stringify(json(data.llm_calls_by_provider))}).`,
          `Providers used: ${list(data.session_providers).join(", ") || "none"}.`,
          `Last model mismatch: ${str(data.last_model_mismatch) || "none"}.`,
          `Consecutive failures: ${num(data.consecutive_failures)}.`,
        ].join(" "),
      )
    },
  }
}
