// 1.x SDK-shaped client over the 2.x plugin context.
//
// team.ts drives worker sessions through the 1.x `@opencode-ai/sdk` surface (`client.session.create({ body, query })`,
// `promptAsync`, `messages`, `status`, `abort`). The 2.x promise plugin context exposes `ctx.session.*` operations
// with flat inputs and no message listing or status call in the plugin domain, so this shim maps each 1.x call:
//
//   1.x client.session.*                     2.x ctx.session.*
//   create({body:{parentID,title,permission}}) create({parentID,title,location,permissions})   (rule shape mapped)
//   promptAsync({body:{agent,model,parts}})    switchAgent / switchModel, then prompt({text})  (inbox enqueue = async)
//   prompt({body:{parts}})                     prompt({text}) then wait({sessionID})
//   messages({path:{id}})                      context({sessionID}) → 1.x {info, parts} rows
//   status({query})                            derived from session.status / session.execution.* events
//   abort({path:{id}})                         interrupt({sessionID})
//   event.subscribe()                          ctx.event.subscribe() with {type, data} → {type, properties}
//
// `body.tools` (per-prompt tool allow-list) and `body.variant` have no 2.x per-prompt equivalent: variant travels in
// Model.Ref, the tool list is dropped (worker agents are already restricted by their agent definition / permissions).
import type { EventStore } from "./events"

export type Rule1 = { permission: string; pattern: string; action: "allow" | "deny" | "ask" }

type Ctx = {
  session: {
    create(input: Record<string, unknown>): Promise<{ id: string; permissions?: unknown }>
    get(input: { sessionID: string }): Promise<{ id: string; permissions?: unknown }>
    prompt(input: Record<string, unknown>): Promise<unknown>
    wait(input: { sessionID: string }): Promise<unknown>
    interrupt(input: { sessionID: string }): Promise<unknown>
    switchAgent(input: { sessionID: string; agent: string }): Promise<unknown>
    switchModel(input: { sessionID: string; model: Record<string, unknown> }): Promise<unknown>
    context(input: { sessionID: string }): Promise<ReadonlyArray<Record<string, any>>>
  }
  event: { subscribe(): AsyncIterable<unknown> }
}

function millis(value: unknown): number | undefined {
  if (typeof value === "number") return value
  if (value instanceof Date) return value.getTime()
  if (typeof value === "string") {
    const t = Date.parse(value)
    return Number.isNaN(t) ? undefined : t
  }
  if (value && typeof value === "object" && "epochMillis" in value) return Number((value as { epochMillis: unknown }).epochMillis)
  return undefined
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content
    .map((c) => (c && typeof c === "object" && (c as { type?: string }).type === "text" ? String((c as { text?: string }).text ?? "") : ""))
    .filter(Boolean)
    .join("\n")
}

/** One 2.x `SessionMessage.Info` → the 1.x `{ info, parts }` row team.ts reads (role, finish, time.completed, error, parts). */
export function toV1Message(msg: Record<string, any>) {
  const type = String(msg.type ?? "")
  const created = millis(msg.time?.created)
  if (type === "assistant") {
    const content: Record<string, any>[] = Array.isArray(msg.content) ? msg.content : []
    const parts = content.map((c) =>
      c.type === "tool"
        ? {
            id: c.id,
            type: "tool",
            tool: c.name,
            state: {
              status: c.state?.status,
              input: c.state?.input,
              output: contentText(c.state?.content),
            },
          }
        : { type: c.type, text: String(c.text ?? "") },
    )
    const last = content[content.length - 1]
    const completed = millis(msg.time?.completed)
    return {
      info: {
        id: msg.id,
        role: "assistant",
        finish: last?.type === "tool" ? "tool-calls" : completed !== undefined ? "stop" : undefined,
        time: { created, completed },
        error: msg.error ? { data: { message: String(msg.error.message ?? msg.error._tag ?? "error") } } : undefined,
      },
      parts,
    }
  }
  const text = typeof msg.text === "string" ? msg.text : contentText(msg.content)
  return {
    info: { id: msg.id, role: type === "user" ? "user" : type || "system", time: { created, completed: created } },
    parts: text ? [{ type: "text", text }] : [],
  }
}

export function toV2Rules(rules: unknown) {
  if (!Array.isArray(rules)) return undefined
  return rules
    .filter((r): r is Rule1 => !!r && typeof r === "object" && "permission" in r)
    .map((r) => ({ action: r.permission, resource: r.pattern, effect: r.action }))
}

function partsText(parts: unknown): string {
  if (!Array.isArray(parts)) return ""
  return parts
    .map((p) => (p && typeof p === "object" && (p as { type?: string }).type === "text" ? String((p as { text?: string }).text ?? "") : ""))
    .filter(Boolean)
    .join("\n")
}

export function createClient(ctx: Ctx, events: EventStore) {
  const session = {
    async get(input: { path: { id: string } }) {
      const info = await ctx.session.get({ sessionID: input.path.id })
      return { data: { ...info, permission: info.permissions } }
    },
    async create(input: { body: { parentID?: string; title?: string; permission?: Rule1[] }; query: { directory: string } }) {
      const permissions = toV2Rules(input.body.permission)
      const info = await ctx.session.create({
        parentID: input.body.parentID,
        title: input.body.title,
        location: { directory: input.query.directory },
        ...(permissions?.length ? { permissions } : {}),
      })
      events.busy(info.id) // the first status event may trail the prompt; never report a fresh worker as idle
      return { data: { id: info.id } }
    },
    async promptAsync(input: {
      path: { id: string }
      body: { agent?: string; model?: { providerID: string; modelID: string }; variant?: string; parts: { type: string; text: string }[] }
    }) {
      const sessionID = input.path.id
      if (input.body.agent) await ctx.session.switchAgent({ sessionID, agent: input.body.agent })
      if (input.body.model)
        await ctx.session.switchModel({
          sessionID,
          model: { providerID: input.body.model.providerID, id: input.body.model.modelID, ...(input.body.variant ? { variant: input.body.variant } : {}) },
        })
      events.busy(sessionID)
      return ctx.session.prompt({ sessionID, text: partsText(input.body.parts) })
    },
    async prompt(input: { path: { id: string }; body: { parts: { type: string; text: string }[] } }) {
      const sessionID = input.path.id
      events.busy(sessionID)
      await ctx.session.prompt({ sessionID, text: partsText(input.body.parts) })
      await ctx.session.wait({ sessionID })
      events.idle(sessionID)
      return {}
    },
    async status(_input?: { query: { directory: string } }) {
      return { data: events.statuses() }
    },
    async messages(input: { path: { id: string } }) {
      const list = await ctx.session.context({ sessionID: input.path.id })
      return { data: list.map((m) => toV1Message(m)) }
    },
    async abort(input: { path: { id: string } }) {
      return ctx.session.interrupt({ sessionID: input.path.id })
    },
  }
  const event = {
    async subscribe() {
      const source = ctx.event.subscribe()
      const stream = (async function* () {
        for await (const ev of source) {
          const e = ev as { type?: string; data?: Record<string, unknown>; properties?: Record<string, unknown> }
          yield { type: e?.type, properties: e?.data ?? e?.properties ?? {} }
        }
      })()
      return { stream }
    },
  }
  return { session, event }
}

export type V1Client = ReturnType<typeof createClient>
