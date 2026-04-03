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

export default async function guardrail(input: {
  directory: string
  worktree: string
}, opts?: Record<string, unknown>) {
  const mode = typeof opts?.mode === "string" ? opts.mode : "enforced"
  const root = path.join(input.directory, ".opencode", "guardrails")
  const log = path.join(root, "events.jsonl")
  const state = path.join(root, "state.json")

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
      sessionID: typeof props?.sessionID === "string" ? props.sessionID : undefined,
      permission: typeof props?.permission === "string" ? props.permission : undefined,
      patterns: Array.isArray(props?.patterns) ? props.patterns : undefined,
    }
  }

  function hidden(file: string) {
    return rel(input.worktree, file).startsWith(".opencode/guardrails/")
  }

  function deny(file: string, kind: "read" | "edit") {
    const item = rel(input.worktree, file)
    if (kind === "read" && has(item, sec)) return "secret material is outside the allowed read surface"
    if (hidden(file)) return "guardrail runtime state is plugin-owned"
    if (kind === "edit" && has(item, cfg)) return "linter or formatter configuration is policy-protected"
  }

  return {
    event: async ({ event }: { event: { type?: string; properties?: Record<string, unknown> } }) => {
      if (!event.type) return
      if (!["session.created", "permission.asked", "session.idle", "session.compacted"].includes(event.type)) return
      await seen(event.type, note(event.properties))
      if (event.type === "session.created") {
        await mark({
          last_session: event.properties?.sessionID,
          last_event: event.type,
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
    "tool.execute.before": async (
      item: { tool: string; args?: unknown },
      out: { args: Record<string, unknown> },
    ) => {
      const file = pick(out.args ?? item.args)
      if (file && (item.tool === "read" || item.tool === "edit" || item.tool === "write")) {
        const err = deny(file, item.tool === "read" ? "read" : "edit")
        if (!err) return
        await mark({ last_block: item.tool, last_file: rel(input.worktree, file), last_reason: err })
        throw new Error(text(err))
      }
      if (item.tool === "bash") {
        const cmd = typeof out.args?.command === "string" ? out.args.command : ""
        const file = cmd.replaceAll("\\", "/")
        if (!cmd) return
        if (has(file, sec) || file.includes(".opencode/guardrails/")) {
          await mark({ last_block: "bash", last_command: cmd, last_reason: "shell access to protected files" })
          throw new Error(text("shell access to protected files"))
        }
        if (!bash(cmd)) return
        if (!cfg.some((rule) => rule.test(file)) && !file.includes(".opencode/guardrails/")) return
        await mark({ last_block: "bash", last_command: cmd, last_reason: "protected runtime or config mutation" })
        throw new Error(text("protected runtime or config mutation"))
      }
    },
    "shell.env": async (_item: { cwd: string }, out: { env: Record<string, string> }) => {
      out.env.OPENCODE_GUARDRAIL_MODE = mode
      out.env.OPENCODE_GUARDRAIL_ROOT = root
      out.env.OPENCODE_GUARDRAIL_STATE = state
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
          `Last guardrail event: ${typeof data.last_event === "string" ? data.last_event : "none"}.`,
          `Last guardrail block: ${typeof data.last_block === "string" ? data.last_block : "none"}.`,
        ].join(" "),
      )
    },
  }
}
