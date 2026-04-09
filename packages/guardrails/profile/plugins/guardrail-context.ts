import { mkdir } from "fs/promises"
import path from "path"
import {
  cmp,
  ext,
  flag,
  free,
  has,
  line,
  list,
  num,
  pick,
  preview,
  rel,
  save,
  src,
  stash,
  str,
  cfg,
  sec,
  vers,
} from "./guardrail-patterns"

export type Client = {
  session: {
    create(input: { body: { parentID: string; title: string }; query: { directory: string } }): Promise<{ data: { id: string } }>
    promptAsync(input: {
      path: { id: string }
      query: { directory: string }
      body: {
        agent?: string
        model?: { providerID: string; modelID: string }
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
    status(input: { query: { directory: string } }): Promise<{ data?: Record<string, { type: string }> }>
    messages(input: { path: { id: string }; query: { directory: string } }): Promise<{ data?: Array<{ info: { role: string; error?: { data?: { message?: string } } }; parts: Array<{ type?: string; text?: string }> }> }>
    abort(input: { path: { id: string }; query: { directory: string } }): Promise<unknown>
  }
}

export type GuardrailInput = {
  client: Client
  directory: string
  worktree: string
}

export type GuardrailContext = {
  input: GuardrailInput
  mode: string
  root: string
  log: string
  state: string
  allow: Record<string, Set<string>>
  hasCodexMcp: boolean
  maxParallelTasks: number
  maxSessionCost: number
  agentModelTier: Record<string, "high" | "standard" | "low">
  tierModels: Record<string, string[]>
  domainDirs: Record<string, RegExp>
  mark(data: Record<string, unknown>): Promise<void>
  seen(type: string, data: Record<string, unknown>): Promise<void>
  note(props: Record<string, unknown> | undefined): {
    sessionID: string | undefined
    permission: string | undefined
    patterns: unknown[] | undefined
  }
  hidden(file: string): boolean
  code(file: string): boolean
  fact(file: string): boolean
  stale(data: Record<string, unknown>, key: "edit_count_since_check" | "edits_since_review"): boolean
  factLine(data: Record<string, unknown>): string
  reviewLine(data: Record<string, unknown>): string
  compact(data: Record<string, unknown>): string
  deny(file: string, kind: "read" | "edit"): string | undefined
  baseline(old: string, next: string): string | undefined
  version(args: Record<string, unknown>): Promise<string | undefined>
  budget(): Promise<number>
  gate(data: {
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
  }): string | undefined
}

export async function createContext(input: GuardrailInput, opts?: Record<string, unknown>) {
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

  const maxParallelTasks = 5
  const maxSessionCost = 10.0
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
    const glm = str(data.review_glm_state) === "done" ? "done" : "pending"
    const codex = str(data.review_codex_state) === "done" ? "done" : "pending"
    const staleSuffix = stale(data, "edits_since_review")
      ? ` (stale: ${num(data.edits_since_review)} edit(s) since last review)`
      : ""
    return `GLM: ${glm}, Codex: ${codex}${staleSuffix}`
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
    input,
    mode,
    root,
    log,
    state,
    allow,
    hasCodexMcp: false,
    maxParallelTasks,
    maxSessionCost,
    agentModelTier,
    tierModels,
    domainDirs,
    mark,
    seen,
    note,
    hidden,
    code,
    fact,
    stale,
    factLine,
    reviewLine,
    compact,
    deny,
    baseline,
    version,
    budget,
    gate,
  } satisfies GuardrailContext
}

export default {
  id: "guardrail-context",
  server: async () => ({}),
}
