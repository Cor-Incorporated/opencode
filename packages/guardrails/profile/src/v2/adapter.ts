// 1.x hook object → 2.x plugin context bridge.
//
// guardrail.ts and team.ts are written against the fork's 1.x plugin API: `server(input) → hooks object` whose keys are
// hook names with `(input, output)` mutation signatures. Upstream 2.x (`@opencode/plugin` promise API) replaces that
// with `setup(ctx)` and per-domain registrations. This adapter keeps the two factories untouched and registers their
// hooks on a 2.x ctx:
//
//   1.x hook                              2.x registration                          notes
//   config(cfg)                           called once with the profile opencode.json  (no config hook in 2.x)
//   event({event:{type,properties}})      ctx.event.subscribe() loop                  {type,data} → {type,properties}
//   chat.message(in, {message,parts})     ctx.session.hook("prompt")                  appended parts → prompt.text
//   command.execute.before                ctx.session.hook("prompt")                  2.x expands a command into a plain
//                                                                                     prompt; the profile's command
//                                                                                     templates end with a marker
//                                                                                     `<!-- guardrails:command=NAME -->`
//   tool.execute.before(in, {args})       ctx.tool.hook("execute.before")             2.x names/keys → 1.x, written back
//   tool.execute.after(in, {output,…})    ctx.tool.hook("execute.after")              content/metadata written back
//   shell.env(in, {env})                  ctx.shell.hook("create.before")             keys merged into e.env
//   chat.params(item, params)             ctx.session.hook("context" | "compaction" | "generate" | "title")
//   experimental.chat.system.transform    ctx.session.hook("context")                 strings → SystemPart {type:"text"}
//   experimental.session.compacting       ctx.session.hook("compaction")              context[] → e.system parts
//   tool: { name: tool({...}) }           ctx.tool.transform(editor.add(...))         JSON-Schema input, defaults filled
//
// Tool vocabulary: 2.x renamed the built-in tools and their argument keys (packages/core/src/v1/config/migrate.ts
// `normalizeAction`: bash→shell, task→subagent, write/patch→edit; file tools take `path`, the subagent tool takes
// `agent`, the shell result carries `metadata.exit`). The 1.x guards compare against the old names, so every tool call
// is translated to the 1.x shape before the hook and back to the 2.x shape after it (`toV1Call` / `toV2Input`).
//
// Throwing from a 1.x hook keeps its meaning: a thrown Error in execute.before denies the tool call (Tool.Error), in
// the context hook it aborts the model request (the provider gate).
import { createClient, type V1Client } from "./client"
import { EventStore } from "./events"
import { inputSchema, withDefaults, type ToolContext, type ToolDefinition } from "./tool"

export type V1Hooks = Record<string, any>

export type V1Input = { client: V1Client; directory: string; worktree: string }

type Part = { type: "text"; text: string }
const part = (text: string): Part => ({ type: "text", text })

type Ctx = any

/** 2.x tool name → the 1.x name the guards compare against. */
const TOOL_V1: Record<string, string> = { shell: "bash", subagent: "task" }
const TOOL_V2: Record<string, string> = { bash: "shell", task: "subagent" }

/** The 1.x view of a 2.x tool call: renamed tool, `filePath` / `subagent_type` keys, a patch as an edit of its first file. */
export function toV1Call(tool: string, input: unknown): { tool: string; args: Record<string, unknown> } {
  const raw = (input && typeof input === "object" ? input : {}) as Record<string, unknown>
  if (tool === "patch" && typeof raw.patchText === "string") {
    const files = [...raw.patchText.matchAll(/^\*\*\* (?:Update|Add|Delete) File: (.+)$/gm)].map((m) => m[1].trim())
    return { tool: "edit", args: { ...raw, filePath: files[0] ?? "", content: raw.patchText, patchFiles: files } }
  }
  const args: Record<string, unknown> = { ...raw }
  if (typeof raw.path === "string" && raw.filePath === undefined) args.filePath = raw.path
  if (tool === "subagent" && typeof raw.agent === "string" && raw.subagent_type === undefined) args.subagent_type = raw.agent
  return { tool: TOOL_V1[tool] ?? tool, args }
}

/** Write a (possibly mutated) 1.x args object back into the 2.x input shape. */
export function toV2Input(tool: string, args: Record<string, unknown>, original: unknown): unknown {
  const raw = (original && typeof original === "object" ? original : {}) as Record<string, unknown>
  if (tool === "patch") return raw // the guards only read a patch; its text is never rewritten
  const out: Record<string, unknown> = { ...args }
  if ("filePath" in out && typeof raw.path === "string") {
    if (out.filePath !== raw.path) out.path = out.filePath
    delete out.filePath
  }
  if (tool === "subagent" && "subagent_type" in out) {
    if (out.subagent_type !== raw.agent) out.agent = out.subagent_type
    delete out.subagent_type
  }
  return out
}

/** The 1.x `server(input)` argument built from a 2.x ctx; `events` must be fed by `bridge` (shared store). */
export function v1Input(ctx: Ctx, events = new EventStore()): V1Input & { events: EventStore } {
  const directory = String(ctx.location?.directory ?? process.cwd())
  const worktree = String(ctx.location?.project?.directory ?? directory)
  return { client: createClient(ctx, events), directory, worktree, events }
}

function resultText(result: unknown): string {
  if (!result || typeof result !== "object") return ""
  const r = result as { content?: unknown; output?: unknown }
  if (typeof r.content === "string") return r.content
  if (Array.isArray(r.content))
    return r.content
      .map((c) => (c && typeof c === "object" && (c as { type?: string }).type === "text" ? String((c as { text?: string }).text ?? "") : ""))
      .filter(Boolean)
      .join("\n")
  return typeof r.output === "string" ? r.output : ""
}

function warn(where: string, error: unknown) {
  process.stderr.write(`[guardrails/v2] ${where}: ${error instanceof Error ? error.message : String(error)}\n`)
}

const COMMANDS = ["implement", "auto", "review", "ship", "handoff"]
const SLASH = new RegExp(`^/(${COMMANDS.join("|")})\\b[ \\t]*([\\s\\S]*)$`)
const MARKER = new RegExp(`<!--\\s*guardrails:command=(${COMMANDS.join("|")})\\s*-->`)

/** Which packaged command produced this prompt: 2.x metadata, the template marker, or a literal slash command. */
function commandOf(e: any): { command: string; args: string } | undefined {
  const text = String(e?.prompt?.text ?? "")
  const meta = e?.metadata?.command ?? e?.prompt?.metadata?.command
  if (typeof meta === "string" && COMMANDS.includes(meta)) return { command: meta, args: "" }
  const marker = MARKER.exec(text)
  if (marker) return { command: marker[1], args: "" }
  const slash = SLASH.exec(text.trimStart())
  if (slash) return { command: slash[1], args: slash[2] ?? "" }
  return undefined
}

const CATALOG_TTL_MS = 60_000

export async function bridge(ctx: Ctx, hooks: V1Hooks, opts: { input: V1Input & { events: EventStore }; config?: unknown }) {
  const { events, directory, worktree } = opts.input

  if (typeof hooks.config === "function" && opts.config && typeof opts.config === "object") {
    await hooks.config(opts.config)
  }

  if (typeof hooks["chat.message"] === "function" || typeof hooks["command.execute.before"] === "function") {
    await ctx.session.hook("prompt", async (e: any) => {
      const sessionID = String(e?.sessionID ?? "")
      if (!e?.prompt || typeof e.prompt.text !== "string") return
      const cmd = commandOf(e)
      if (cmd && typeof hooks["command.execute.before"] === "function") {
        const out = { parts: [{ type: "subtask", prompt: e.prompt.text }] }
        await hooks["command.execute.before"]({ command: cmd.command, sessionID, arguments: cmd.args }, out)
        e.prompt.text = out.parts[0]?.prompt ?? e.prompt.text
      }
      if (typeof hooks["chat.message"] !== "function") return
      const messageID = String(e.messageID ?? "")
      const out = {
        message: { id: messageID, sessionID, role: "user" },
        parts: [{ id: `${messageID}-0`, sessionID, messageID, type: "text", text: e.prompt.text }],
      }
      await hooks["chat.message"]({ sessionID }, out)
      const texts = out.parts.filter((p) => p.type === "text" && p.text).map((p) => p.text)
      if (texts.length) e.prompt.text = texts.join("\n\n")
    })
  }

  if (typeof hooks["tool.execute.before"] === "function") {
    await ctx.tool.hook("execute.before", async (e: any) => {
      const tool = String(e?.tool ?? "")
      const call = toV1Call(tool, e?.input)
      const out = { args: call.args }
      await hooks["tool.execute.before"]({ tool: call.tool, sessionID: e?.sessionID, callID: e?.id }, out)
      e.input = toV2Input(tool, out.args, e?.input)
    })
  }

  if (typeof hooks["tool.execute.after"] === "function" || typeof hooks["tool.execute.error"] === "function") {
    await ctx.tool.hook("execute.after", async (e: any) => {
      const tool = String(e?.tool ?? "")
      const call = toV1Call(tool, e?.input)
      const ok = e?.status === "completed"
      if (!ok && typeof hooks["tool.execute.error"] === "function") {
        // fork-specific 1.x hook: a failed call reports through status:"error" in 2.x
        await hooks["tool.execute.error"]({ tool: call.tool, sessionID: e?.sessionID, callID: e?.id }, { error: e?.error })
      }
      if (typeof hooks["tool.execute.after"] !== "function") return
      const text = ok ? resultText(e.result) : String(e?.error?.message ?? "")
      const meta: Record<string, unknown> = ok ? { ...(e.result?.metadata ?? {}) } : {}
      if (typeof meta.exit === "number" && meta.exitCode === undefined) meta.exitCode = meta.exit // 1.x shell metadata key
      if (!ok) meta.error = String(e?.error?.message ?? "error") // 1.x: a non-empty string marks a tool error
      const out = { title: ok ? "" : "Error", output: text, metadata: meta }
      await hooks["tool.execute.after"]({ tool: call.tool, sessionID: e?.sessionID, callID: e?.id, args: call.args }, out)
      if (!ok) return
      const next = { ...(e.result ?? {}) }
      if (out.output !== text) next.content = out.output // e.g. secret redaction of shell output
      next.metadata = { ...(e.result?.metadata ?? {}), ...out.metadata, ...(out.title ? { title: out.title } : {}) }
      e.result = next
    })
  }

  if (typeof hooks["shell.env"] === "function") {
    await ctx.shell.hook("create.before", async (e: any) => {
      const out = { env: {} as Record<string, string> }
      await hooks["shell.env"]({ cwd: e?.cwd }, out)
      Object.assign(e.env, out.env)
    })
  }

  // 2.x hands the model hooks a Model.Ref ({ id, providerID, variant? }) while the 1.x chat.params gate judged a
  // Model.Info (status + cost: free()/preview()). The catalog is read from ctx.model.list() and cached (misses too,
  // for CATALOG_TTL_MS); a model that is not in the catalog keeps cost undefined — unknown cost is not evidence of a
  // free tier (guardrail-patterns free()).
  const catalog = new Map<string, any>()
  let catalogAt = 0
  const modelInfo = async (providerID: string, id: string) => {
    const key = `${providerID}/${id}`
    if (!catalog.has(key) && Date.now() - catalogAt > CATALOG_TTL_MS && typeof ctx.model?.list === "function") {
      catalogAt = Date.now()
      try {
        const res = await ctx.model.list()
        for (const m of res?.data ?? []) catalog.set(`${m.providerID}/${m.id}`, m)
      } catch (error) {
        warn("model.list", error)
      }
    }
    return catalog.get(key)
  }
  const gate = async (e: any) => {
    const ref = e?.model ?? {}
    const id = String(ref.id ?? ref.modelID ?? "")
    const info = await modelInfo(String(ref.providerID ?? ""), id)
    const cost = Array.isArray(info?.cost) ? info.cost[0] : info?.cost
    await hooks["chat.params"](
      {
        sessionID: e?.sessionID,
        agent: e?.agent,
        model: {
          id,
          providerID: ref.providerID,
          variant: ref.variant,
          status: info?.status ?? "active",
          cost: cost ? { input: cost.input, output: cost.output, cache: { read: cost.cache?.read, write: cost.cache?.write } } : undefined,
        },
        provider: { id: ref.providerID },
        message: { variant: ref.variant },
      },
      e.options ?? (e.options = {}),
    )
  }

  if (typeof hooks["chat.params"] === "function" || typeof hooks["experimental.chat.system.transform"] === "function") {
    await ctx.session.hook("context", async (e: any) => {
      if (typeof hooks["chat.params"] === "function") await gate(e)
      if (typeof hooks["experimental.chat.system.transform"] !== "function") return
      const system: Array<{ type?: string; text?: string }> = Array.isArray(e?.system) ? e.system : (e.system = [])
      const original = system.map((p) => String(p?.text ?? ""))
      const out = { system: original.slice() }
      await hooks["experimental.chat.system.transform"]({ sessionID: e?.sessionID }, out)
      // keep the original SystemParts (they may carry provider options); map unshift/push positions of new strings
      const first = original.length ? out.system.indexOf(original[0]) : out.system.length
      const head = out.system.slice(0, Math.max(first, 0)).filter((s) => !original.includes(s))
      const tail = out.system.slice(Math.max(first, 0)).filter((s) => !original.includes(s))
      system.unshift(...head.map(part))
      system.push(...tail.map(part))
    })
  }

  if (typeof hooks["chat.params"] === "function") {
    // the 1.x gate ran on every model request; auxiliary 2.x requests have their own hooks
    for (const name of ["generate", "title"]) await ctx.session.hook(name, gate)
  }

  if (typeof hooks["experimental.session.compacting"] === "function" || typeof hooks["chat.params"] === "function") {
    await ctx.session.hook("compaction", async (e: any) => {
      if (typeof hooks["chat.params"] === "function") await gate(e)
      if (typeof hooks["experimental.session.compacting"] !== "function") return
      const out = { context: [] as string[], prompt: undefined as string | undefined }
      await hooks["experimental.session.compacting"]({ sessionID: e?.sessionID }, out)
      if (!Array.isArray(e.system)) e.system = []
      e.system.push(...out.context.map(part))
    })
  }

  const tools = hooks.tool && typeof hooks.tool === "object" ? (hooks.tool as Record<string, ToolDefinition>) : undefined
  if (tools && Object.keys(tools).length) {
    await ctx.tool.transform((editor: any) => {
      for (const [name, def] of Object.entries(tools)) {
        editor.add({
          name,
          description: def.description,
          input: inputSchema(def.args),
          execute: async (input: unknown, tctx: any) => {
            const context: ToolContext = {
              sessionID: String(tctx?.sessionID ?? ""),
              messageID: String(tctx?.messageID ?? ""),
              agent: String(tctx?.agent ?? ""),
              directory,
              worktree,
              abort: tctx?.signal ?? new AbortController().signal,
              metadata: (m) => {
                const update = { ...(m.metadata ?? {}), ...(m.title ? { title: m.title } : {}) }
                void Promise.resolve(tctx?.progress?.(update)).catch((error) => warn(`${name}.progress`, error))
              },
              // 1.x ask() opened a permission prompt; the 2.x tool context has no equivalent and team.ts never calls it
              ask: async () => {},
              permission: undefined,
            }
            const r = await def.execute(withDefaults(def.args, input) as never, context)
            if (typeof r === "string") return { content: r }
            return { content: r.output, metadata: { ...(r.metadata ?? {}), ...(r.title ? { title: r.title } : {}) } }
          },
        })
      }
    })
  }

  // Event loop: feeds the status store (client.session.status) and the 1.x `event` hook. One failing handler must
  // not end the subscription (each event is isolated) and a dropped stream is re-subscribed with backoff.
  void (async () => {
    for (let attempt = 0; ; attempt++) {
      try {
        for await (const ev of ctx.event.subscribe()) {
          attempt = 0
          events.apply(ev)
          if (typeof hooks.event !== "function") continue
          const e = ev as { type?: string; data?: Record<string, unknown>; properties?: Record<string, unknown> }
          const data = e?.data ?? e?.properties ?? {}
          // 2.x permission.asked carries action/resources; the 1.x handlers read permission/patterns
          const properties = e?.type === "permission.asked" ? { ...data, permission: data.action, patterns: data.resources } : data
          try {
            await hooks.event({ event: { type: e?.type, properties } })
          } catch (error) {
            warn(`event ${e?.type}`, error)
          }
        }
        warn("event stream", "ended; resubscribing")
      } catch (error) {
        warn("event stream", error)
      }
      await new Promise((r) => setTimeout(r, Math.min(30_000, 1_000 * 2 ** Math.min(attempt, 5))))
    }
  })()
}
