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
//   command.execute.before                ctx.session.hook("prompt") on "/<cmd> …"     2.x CommandEditor has no wrap;
//                                                                                     best effort on slash-command text
//   tool.execute.before(in, {args})       ctx.tool.hook("execute.before")             out.args written back to e.input
//   tool.execute.after(in, {output,…})    ctx.tool.hook("execute.after")              content/metadata written back
//   shell.env(in, {env})                  ctx.shell.hook("create.before")             keys merged into e.env
//   chat.params(item, params)             ctx.session.hook("context")                 params = e.options (mutable)
//   experimental.chat.system.transform    ctx.session.hook("context")                 strings → SystemPart {type:"text"}
//   experimental.session.compacting       ctx.session.hook("compaction")              context[] → e.system parts
//   tool: { name: tool({...}) }           ctx.tool.transform(editor.add(...))         JSON-Schema input, defaults filled
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

const COMMANDS = /^\/(implement|auto|review|ship|handoff)\b[ \t]*([\s\S]*)$/

export async function bridge(ctx: Ctx, hooks: V1Hooks, opts: { input: V1Input & { events: EventStore }; config?: unknown }) {
  const { events, directory, worktree } = opts.input

  if (typeof hooks.config === "function" && opts.config && typeof opts.config === "object") {
    await hooks.config(opts.config)
  }

  if (typeof hooks["chat.message"] === "function" || typeof hooks["command.execute.before"] === "function") {
    await ctx.session.hook("prompt", async (e: any) => {
      const sessionID = String(e?.sessionID ?? "")
      if (!e?.prompt || typeof e.prompt.text !== "string") return
      const cmd = COMMANDS.exec(e.prompt.text.trimStart())
      if (cmd && typeof hooks["command.execute.before"] === "function") {
        const out = { parts: [{ type: "subtask", prompt: e.prompt.text }] }
        await hooks["command.execute.before"]({ command: cmd[1], sessionID, arguments: cmd[2] ?? "" }, out)
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
      const out = { args: (e?.input && typeof e.input === "object" ? e.input : {}) as Record<string, unknown> }
      await hooks["tool.execute.before"]({ tool: e?.tool, sessionID: e?.sessionID, callID: e?.id }, out)
      e.input = out.args
    })
  }

  if (typeof hooks["tool.execute.after"] === "function" || typeof hooks["tool.execute.error"] === "function") {
    await ctx.tool.hook("execute.after", async (e: any) => {
      const ok = e?.status === "completed"
      if (!ok && typeof hooks["tool.execute.error"] === "function") {
        // fork-specific 1.x hook: a failed call reports through status:"error" in 2.x
        await hooks["tool.execute.error"]({ tool: e?.tool, sessionID: e?.sessionID, callID: e?.id }, { error: e?.error })
      }
      if (typeof hooks["tool.execute.after"] !== "function") return
      const text = ok ? resultText(e.result) : String(e?.error?.message ?? "")
      const out = { title: "", output: text, metadata: { ...(ok ? e.result?.metadata ?? {} : { error: true }) } as Record<string, unknown> }
      await hooks["tool.execute.after"]({ tool: e?.tool, sessionID: e?.sessionID, callID: e?.id, args: e?.input ?? {} }, out)
      if (!ok) return
      const next = { ...(e.result ?? {}) }
      if (out.output !== text) next.content = out.output
      if (out.title || Object.keys(out.metadata).length) next.metadata = { ...out.metadata, ...(out.title ? { title: out.title } : {}) }
      e.result = next
    })
  }

  if (typeof hooks["shell.env"] === "function") {
    await ctx.shell.hook("create.before", async (e: any) => {
      const out = { env: {} as Record<string, string> }
      await hooks["shell.env"]({ cwd: e?.cwd, sessionID: e?.sessionID }, out)
      Object.assign(e.env, out.env)
    })
  }

  // 2.x hands the context hook a Model.Ref ({ id, providerID, variant? }) while the 1.x chat.params gate judged a
  // Model.Info (status + cost: free()/preview()). The catalog is read from ctx.model.list() and cached; a model that is
  // not in the catalog keeps cost undefined — unknown cost is not evidence of a free tier (guardrail-patterns free()).
  const catalog = new Map<string, any>()
  const modelInfo = async (providerID: string, id: string) => {
    const key = `${providerID}/${id}`
    if (!catalog.has(key) && typeof ctx.model?.list === "function") {
      try {
        const res = await ctx.model.list()
        for (const m of res?.data ?? []) catalog.set(`${m.providerID}/${m.id}`, m)
      } catch (error) {
        warn("model.list", error)
      }
    }
    return catalog.get(key)
  }

  if (typeof hooks["chat.params"] === "function" || typeof hooks["experimental.chat.system.transform"] === "function") {
    await ctx.session.hook("context", async (e: any) => {
      if (typeof hooks["chat.params"] === "function") {
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
              status: info?.status ?? "active",
              cost: cost ? { input: cost.input, output: cost.output, cache: { read: cost.cache?.read, write: cost.cache?.write } } : undefined,
            },
            provider: { id: ref.providerID },
            message: {},
          },
          e.options ?? (e.options = {}),
        )
      }
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

  if (typeof hooks["experimental.session.compacting"] === "function") {
    await ctx.session.hook("compaction", async (e: any) => {
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
  // not end the subscription, so each event is isolated.
  void (async () => {
    try {
      for await (const ev of ctx.event.subscribe()) {
        events.apply(ev)
        if (typeof hooks.event !== "function") continue
        const e = ev as { type?: string; data?: Record<string, unknown>; properties?: Record<string, unknown> }
        try {
          await hooks.event({ event: { type: e?.type, properties: e?.data ?? e?.properties ?? {} } })
        } catch (error) {
          warn(`event ${e?.type}`, error)
        }
      }
    } catch (error) {
      warn("event stream", error)
    }
  })()
}
