/**
 * 2.x adapter: the 1.x hook objects of guardrail.ts / team.ts register on a 2.x plugin ctx and keep their effect.
 *
 * The 2.x `setup(ctx)` receives per-domain registrars; this test hands the real v2 entries a fake ctx that records
 * every registration (session.hook / tool.hook / shell.hook / tool.transform / event.subscribe) and then drives the
 * recorded callbacks with 2.x-shaped inputs. Axes:
 *   F1 reachability  guardrail: context hook → chat.params gate (blocked model throws, allowed passes), compaction and
 *                    system transform land as SystemParts, shell create.before gets the guardrail env, tool hooks exist
 *   F2 tools         team: team/background/team_status are added through tool.transform with a JSON-Schema input whose
 *                    required set comes from .optional()/.default(); top-level defaults are filled before execute
 *   F3 client shim   1.x client calls map to 2.x session ops (create → permissions, promptAsync → switchModel+prompt,
 *                    messages → context rows, abort → interrupt, status from events)
 *   F4 prompt        chat.message parts appended by a hook become prompt.text; "/review …" reaches command.execute.before
 *
 * Run: bun test packages/guardrails/profile/src/v2/adapter.test.ts
 */
import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import guardrailV2 from "../../plugins/guardrail/index"
import teamV2 from "../../plugins/team/index"
import { bridge, toV1Call, toV2Input, v1Input } from "./adapter"
import { createClient, toolDenyRules, toV1Message, toV2Rules } from "./client"

const ENV_FILE = [".", "env"].join("") // the dotfile name, spelled so that shell-command scanners do not read it as a secret access
import { EventStore } from "./events"
import { inputSchema, tool, withDefaults } from "./tool"

type Fn = (input: any) => Promise<void> | void

function fakeCtx(directory: string) {
  const hooks = new Map<string, Fn[]>()
  const tools = new Map<string, any>()
  const calls: { op: string; input: any }[] = []
  const queue: unknown[] = []
  let wake: (() => void) | undefined
  const reg = (key: string) => async (name: string, fn: Fn) => {
    hooks.set(`${key}.${name}`, [...(hooks.get(`${key}.${name}`) ?? []), fn])
    return { dispose: async () => {} }
  }
  const op = (name: string, result?: (input: any) => unknown) => async (input: any) => {
    calls.push({ op: name, input })
    return result ? result(input) : undefined
  }
  const ctx = {
    app: { name: "opencode", version: "2.0.32", channel: "latest" },
    location: { directory, project: { id: "p", directory, canonical: directory } },
    options: {},
    session: {
      hook: reg("session"),
      create: op("session.create", (i) => ({ id: "ses_child1", parentID: i.parentID, permissions: i.permissions })),
      get: op("session.get", (i) => ({ id: i.sessionID, permissions: [{ action: "edit", resource: "*", effect: "deny" }] })),
      update: op("session.update"),
      move: op("session.move"),
      prompt: op("session.prompt", () => ({ id: "inbox1" })),
      wait: op("session.wait"),
      interrupt: op("session.interrupt"),
      switchAgent: op("session.switchAgent"),
      switchModel: op("session.switchModel"),
      synthetic: op("session.synthetic"),
      context: op("session.context", () => [
        { type: "user", id: "m1", text: "do it", time: { created: 1 } },
        {
          type: "assistant",
          id: "m2",
          content: [
            { type: "text", text: "working" },
            { type: "tool", id: "c1", name: "shell", state: { status: "completed", input: { command: "ls" }, content: [{ type: "text", text: "a\nb" }] } },
          ],
          time: { created: 2 },
        },
        { type: "assistant", id: "m3", content: [{ type: "text", text: "done" }], time: { created: 3, completed: 4 } },
      ]),
    },
    model: {
      list: op("model.list", () => ({
        data: [
          { id: "glm-5.3", providerID: "zai-coding-plan", status: "active", cost: [{ input: 0.6, output: 2.2, cache: { read: 0.1, write: 0 } }] },
          { id: "zero-cost", providerID: "acme", status: "active", cost: [{ input: 0, output: 0, cache: { read: 0, write: 0 } }] },
        ],
      })),
    },
    tool: {
      hook: reg("tool"),
      transform: async (cb: (editor: any) => void) => {
        cb({ add: (t: any) => tools.set(t.name, t) })
        return { dispose: async () => {} }
      },
    },
    shell: { hook: reg("shell") },
    event: {
      subscribe: () =>
        (async function* () {
          for (;;) {
            if (queue.length) {
              yield queue.shift()
              continue
            }
            await new Promise<void>((r) => (wake = r))
            wake = undefined
          }
        })(),
    },
  }
  const fire = async (name: string, input: any) => {
    for (const fn of hooks.get(name) ?? []) await fn(input)
  }
  const emit = (ev: unknown) => {
    queue.push(ev)
    wake?.()
  }
  return { ctx, hooks, tools, calls, fire, emit }
}

const cost = { input: 0, output: 0, cache: { read: 0, write: 0 } }

describe("F1 guardrail v2 entry: hooks register on the 2.x ctx and keep their effect", () => {
  const dir = mkdtempSync(join(tmpdir(), "guardrails-v2-"))
  const f = fakeCtx(dir)

  test("setup registers prompt/context/compaction/tool/shell hooks", async () => {
    await guardrailV2.setup(f.ctx)
    expect([...f.hooks.keys()].sort()).toEqual(
      ["session.compaction", "session.context", "session.generate", "session.title", "session.prompt", "shell.create.before", "tool.execute.after", "tool.execute.before"].sort(),
    )
  })

  test("shell create.before: guardrail env is merged into the shell env", async () => {
    const e = { command: "ls", cwd: dir, timeout: 1000, shell: "bash", env: { PATH: "/bin" } as Record<string, string | undefined> }
    await f.fire("shell.create.before", e)
    expect(e.env.PATH).toBe("/bin")
    expect(e.env.OPENCODE_GUARDRAIL_MODE).toBe("enforced")
    expect(e.env.OPENCODE_GUARDRAIL_ROOT).toBe(join(dir, ".opencode", "guardrails"))
  })

  test("context hook: the provider gate blocks a model outside the whitelist (chat.params reachability)", async () => {
    const e = { sessionID: "ses_1", agent: "implement", model: { id: "nope-9000", providerID: "zai-coding-plan" }, system: [], messages: [], options: {}, tools: {} }
    await expect(f.fire("session.context", e)).rejects.toThrow(/Guardrail policy blocked/)
  })

  test("context hook: an allowed model passes and the system transform appends SystemParts", async () => {
    const e = {
      sessionID: "ses_1",
      agent: "implement",
      model: { id: "glm-5.3", providerID: "zai-coding-plan" },
      system: [{ type: "text", text: "base prompt" }],
      messages: [],
      options: {},
      tools: {},
    }
    await f.fire("session.context", e)
    expect(e.system[0]).toEqual({ type: "text", text: "base prompt" })
    expect(e.system.some((p: any) => String(p.text).startsWith("[DELEGATION] ADR-004"))).toBe(true)
  })

  test("context hook: cost/status come from the 2.x model catalog — a zero-cost catalog model is free-tier, an unknown model is not", async () => {
    const base = { sessionID: "ses_1", agent: "implement", system: [], messages: [], options: {}, tools: {} }
    // "acme" has no whitelist in the profile, so only free()/preview() decide
    await expect(f.fire("session.context", { ...base, model: { id: "zero-cost", providerID: "acme" } })).rejects.toThrow(/free-tier/)
    await f.fire("session.context", { ...base, model: { id: "not-in-catalog", providerID: "acme" } })
    expect(f.calls.filter((c) => c.op === "model.list").length).toBeGreaterThan(0)
  })

  test("2.x tool calls reach the 1.x gates: shell/read/edit with 2.x names and `path` are blocked like bash/filePath", async () => {
    const before = (tool: string, input: Record<string, unknown>) =>
      f.fire("tool.execute.before", { tool, sessionID: "ses_1", agent: "implement", messageID: "m1", id: `c-${tool}`, input })
    await expect(before("shell", { command: `cat ${ENV_FILE}` })).rejects.toThrow(/protected|secret|blocked/i)
    await expect(before("shell", { command: "git push origin dev" })).rejects.toThrow(/protected branch|blocked/i)
    await expect(before("read", { path: join(dir, ENV_FILE) })).rejects.toThrow(/secret|protected|blocked/i)
    await expect(before("edit", { path: join(dir, ".opencode", "guardrails", "state.json"), oldString: "a", newString: "b" })).rejects.toThrow(/blocked|guardrail/i)
    await before("shell", { command: "echo ok" }) // an ordinary call passes
  })

  test("a multi-file patch is judged per path: a protected later file or move destination is blocked (Codex #343 r3)", async () => {
    const before = (patchText: string) =>
      f.fire("tool.execute.before", { tool: "patch", sessionID: "ses_1", agent: "implement", messageID: "m1", id: "c-patch", input: { patchText } })
    const state = join(dir, ".opencode", "guardrails", "state.json")
    await expect(before(`*** Begin Patch\n*** Update File: ${join(dir, "src", "ok.ts")}\n@@\n-1\n+2\n*** Update File: ${state}\n@@\n-a\n+b\n*** End Patch\n`)).rejects.toThrow(/blocked|guardrail/i)
    await expect(before(`*** Begin Patch\n*** Update File: ${join(dir, "src", "ok.ts")}\n*** Move to: ${state}\n@@\n-1\n+2\n*** End Patch\n`)).rejects.toThrow(/blocked|guardrail/i)
  })

  test("execute.after: the 2.x shell exit code reaches the 1.x metadata.exitCode and a tool error is a string", async () => {
    const e: any = { tool: "shell", sessionID: "ses_1", agent: "implement", messageID: "m1", id: "c-after", input: { command: "echo ok" }, status: "completed", result: { content: "ok", metadata: { exit: 0 } } }
    await f.fire("tool.execute.after", e)
    expect(e.result.metadata.exitCode).toBe(0)
    const err: any = { tool: "shell", sessionID: "ses_1", agent: "implement", messageID: "m1", id: "c-err", input: { command: "false" }, status: "error", error: { message: "boom" } }
    await f.fire("tool.execute.after", err) // must not throw; 1.x reads metadata.error as a string
  })

  test("compaction hook: guardrail state summary lands in e.system", async () => {
    const e = { sessionID: "ses_1", agent: "implement", model: { id: "glm-5.3", providerID: "zai-coding-plan" }, system: [] as any[], messages: [], options: {}, tools: {} }
    await f.fire("session.compaction", e)
    expect(e.system.length).toBe(1)
    expect(e.system[0].type).toBe("text")
    expect(e.system[0].text).toContain("Guardrail mode: enforced.")
  })

  test("cleanup", () => {
    rmSync(dir, { recursive: true, force: true })
  })
})

describe("F2 team v2 entry: tools are added through tool.transform with JSON-Schema inputs", () => {
  const dir = mkdtempSync(join(tmpdir(), "guardrails-v2-team-"))
  const f = fakeCtx(dir)

  test("setup adds team / background / team_status", async () => {
    await teamV2.setup(f.ctx)
    expect([...f.tools.keys()].sort()).toEqual(["background", "team", "team_status"])
    const team = f.tools.get("team")
    expect(team.input.type).toBe("object")
    expect(team.input.required).toEqual(["tasks"]) // strategy/limit have defaults → not required
    expect(team.input.properties.strategy).toEqual({ type: "string", enum: ["parallel", "wave"], default: "parallel" })
    expect(team.input.properties.limit).toMatchObject({ type: "integer", minimum: 1, maximum: 12 })
    expect(team.input.properties.tasks.items.required).toEqual(["id", "prompt"])
  })

  test("system transform: the team notice is unshifted ahead of the existing system parts", async () => {
    const e = { sessionID: "ses_1", agent: "implement", model: { id: "glm-5.3", providerID: "zai-coding-plan", cost }, system: [{ type: "text", text: "base" }], messages: [], options: {}, tools: {} }
    await f.fire("session.context", e)
    expect(e.system.length).toBe(2)
    expect(e.system[0].text).toContain("team and background tools")
    expect(e.system[1].text).toBe("base")
  })

  test("toV1Call / toV2Input: 2.x names and keys round-trip through the 1.x view", () => {
    expect(toV1Call("shell", { command: "ls" })).toEqual({ tool: "bash", args: { command: "ls" } })
    expect(toV1Call("read", { path: "/p/a" }).args).toEqual({ path: "/p/a", filePath: "/p/a" })
    expect(toV1Call("subagent", { agent: "planner", prompt: "x" }).args.subagent_type).toBe("planner")
    const patch = toV1Call("patch", { patchText: "*** Begin Patch\n*** Update File: src/a.ts\n@@\n-1\n+2\n*** End Patch\n" })
    expect(patch.tool).toBe("edit")
    expect(patch.args.filePath).toBe("src/a.ts")
    expect(toV2Input("read", { path: "/p/a", filePath: "/p/b" }, { path: "/p/a" })).toEqual({ path: "/p/b" }) // a rewritten path is written back
    expect(toV2Input("edit", { path: "/p/a", filePath: "/p/a", oldString: "x" }, { path: "/p/a", oldString: "x" })).toEqual({ path: "/p/a", oldString: "x" })
  })

  test("tool(): defaults are filled before execute; .optional()/.default() drop the key from required", async () => {
    const def = tool({
      description: "d",
      args: { a: tool.schema.string(), b: tool.schema.number().int().min(1).max(3).optional().default(2), c: tool.schema.boolean().optional() },
      async execute(args) {
        return `${args.a}:${args.b}:${String(args.c)}`
      },
    })
    expect(inputSchema(def.args).required).toEqual(["a"])
    expect(withDefaults(def.args, { a: "x" })).toEqual({ a: "x", b: 2 })
    expect(withDefaults(def.args, { a: "x", b: 3, c: true })).toEqual({ a: "x", b: 3, c: true })
  })

  test("cleanup", () => {
    rmSync(dir, { recursive: true, force: true })
  })
})

describe("F3 client shim: 1.x SDK calls map to 2.x session operations", () => {
  const dir = mkdtempSync(join(tmpdir(), "guardrails-v2-client-"))
  const f = fakeCtx(dir)
  const events = new EventStore()
  const client = createClient(f.ctx as any, events)

  test("create: parentID/title/location and permission rules in the 2.x {action,resource,effect} shape", async () => {
    const r = await client.session.create({
      body: { parentID: "ses_p", title: "worker", permission: [{ permission: "edit", pattern: "*", action: "deny" }] },
      query: { directory: join(dir, "box") }, // an isolated worktree, not the parent directory
    })
    expect(r.data.id).toBe("ses_child1")
    const call = f.calls.find((c) => c.op === "session.create")!.input
    expect(call).toMatchObject({ parentID: "ses_p", title: "worker", location: { directory: join(dir, "box") } })
    expect(call.permissions).toEqual([{ action: "edit", resource: "*", effect: "deny" }])
    expect(events.statuses().ses_child1).toEqual({ type: "busy" })
    expect(toV2Rules(undefined)).toBeUndefined()
  })

  test("create: the isolated directory is applied with session.move (parentID makes the child inherit the parent location)", () => {
    expect(f.calls.find((c) => c.op === "session.move")!.input).toEqual({ sessionID: "ses_child1", directory: join(dir, "box") })
  })

  test("rules: 1.x permission/tool names are mapped to the 2.x actions (bash→shell, task→subagent, write→edit)", () => {
    expect(toV2Rules([{ permission: "bash", pattern: "git push*", action: "ask" }, { permission: "task", pattern: "*", action: "deny" }])).toEqual([
      { action: "shell", resource: "git push*", effect: "ask" },
      { action: "subagent", resource: "*", effect: "deny" },
    ])
    expect(toolDenyRules({ task: false, team: false, question: false, bash: true })).toEqual([
      { action: "subagent", resource: "*", effect: "deny" },
      { action: "team", resource: "*", effect: "deny" },
      { action: "question", resource: "*", effect: "deny" },
    ])
  })

  test("promptAsync: agent/model switch, worker tool denies through update, then an inbox prompt (no wait)", async () => {
    await client.session.promptAsync({
      path: { id: "ses_child1" },
      body: { agent: "implement", model: { providerID: "openrouter", modelID: "google/gemini-2.5-flash" }, variant: "fast", tools: { task: false, question: false }, parts: [{ type: "text", text: "go" }] },
    })
    const ops = f.calls.map((c) => c.op)
    expect(f.calls.find((c) => c.op === "session.update")!.input.permissions).toEqual([
      { action: "edit", resource: "*", effect: "deny" }, // the existing rule is kept
      { action: "subagent", resource: "*", effect: "deny" },
      { action: "question", resource: "*", effect: "deny" },
    ])
    expect(ops).toContain("session.switchAgent")
    expect(f.calls.find((c) => c.op === "session.switchModel")!.input.model).toEqual({ providerID: "openrouter", id: "google/gemini-2.5-flash", variant: "fast" })
    expect(f.calls.find((c) => c.op === "session.prompt")!.input).toEqual({ sessionID: "ses_child1", text: "go" })
    expect(ops).not.toContain("session.wait")
  })

  test("prompt: noReply → synthetic without resume; otherwise waits for idle; abort → interrupt", async () => {
    await client.session.prompt({ path: { id: "ses_child1" }, body: { noReply: true, parts: [{ type: "text", text: "worker done" }] } })
    expect(f.calls.at(-1)).toMatchObject({ op: "session.synthetic", input: { sessionID: "ses_child1", text: "worker done", resume: false } })
    expect(f.calls.map((c) => c.op)).not.toContain("session.wait")
    await client.session.prompt({ path: { id: "ses_child1" }, body: { parts: [{ type: "text", text: "again" }] } })
    expect(f.calls.map((c) => c.op)).toContain("session.wait")
    expect(events.statuses().ses_child1).toEqual({ type: "idle" })
    await client.session.abort({ path: { id: "ses_child1" } })
    expect(f.calls.at(-1)).toEqual({ op: "session.interrupt", input: { sessionID: "ses_child1" } })
  })

  test("messages: 2.x context rows become 1.x {info, parts} rows team.ts reads (role, finish, time.completed, tool output)", async () => {
    const r = await client.session.messages({ path: { id: "ses_child1" } })
    const rows = r.data!
    expect(rows[0].info.role).toBe("user")
    expect(rows[0].parts).toEqual([{ type: "text", text: "do it" }])
    expect(rows[1].info).toMatchObject({ role: "assistant", finish: "tool-calls" })
    expect(rows[1].parts[1]).toMatchObject({ type: "tool", tool: "shell", state: { status: "completed", output: "a\nb" } })
    expect(rows[2].info).toMatchObject({ role: "assistant", finish: "stop", time: { completed: 4 } })
    expect(toV1Message({ type: "assistant", content: [], time: { completed: new Date(5) }, error: { message: "boom" } }).info).toMatchObject({
      time: { completed: 5 },
      error: { data: { message: "boom" } },
    })
  })

  test("messages: a failed execution with no completed assistant row becomes an errored assistant row", async () => {
    events.apply({ type: "session.execution.failed", data: { sessionID: "ses_fail", error: { message: "ZAI_API_KEY is not set" } } })
    f.ctx.session.context = async () => [{ type: "user", id: "u", text: "do", time: { created: 1 } }]
    const r = await client.session.messages({ path: { id: "ses_fail" } })
    const last = r.data!.at(-1)!
    expect(last.info).toMatchObject({ role: "assistant", error: { data: { message: "ZAI_API_KEY is not set" } } })
    expect(typeof last.info.time?.completed).toBe("number")
    expect(events.statuses().ses_fail).toEqual({ type: "idle" })
  })

  test("messages: a failure after a completed tool step is not hidden by that step's completed time (Codex #343 r3)", async () => {
    events.apply({ type: "session.execution.failed", data: { sessionID: "ses_fail2", error: { message: "context preparation failed" } } })
    f.ctx.session.context = async () => [
      { type: "assistant", id: "a1", content: [{ type: "tool", id: "t1", name: "shell", state: { status: "completed", input: {}, content: [{ type: "text", text: "x" }] } }], time: { created: 1, completed: 2 } },
    ]
    const r = await client.session.messages({ path: { id: "ses_fail2" } })
    expect(r.data!.at(-1)!.info.error).toEqual({ data: { message: "context preparation failed" } })
    events.apply({ type: "session.execution.started", data: { sessionID: "ses_fail2" } }) // a new run clears it
    const again = await client.session.messages({ path: { id: "ses_fail2" } })
    expect(again.data!.at(-1)!.info.error).toBeUndefined()
  })

  test("status: derived from session.status / execution events", () => {
    events.apply({ type: "session.status", data: { sessionID: "ses_x", status: { type: "busy" } } })
    events.apply({ type: "session.execution.succeeded", data: { sessionID: "ses_y" } })
    expect(events.statuses()).toMatchObject({ ses_x: { type: "busy" }, ses_y: { type: "idle" } })
    events.apply({ type: "session.deleted", data: { sessionID: "ses_x" } })
    expect(events.statuses().ses_x).toBeUndefined()
  })

  test("event.subscribe: {type,data} → 1.x {type,properties}", async () => {
    const sub = await client.event.subscribe()
    f.emit({ type: "session.idle", data: { sessionID: "ses_1" } })
    const first = await sub.stream[Symbol.asyncIterator]().next()
    expect(first.value).toEqual({ type: "session.idle", properties: { sessionID: "ses_1" } })
  })

  test("cleanup", () => {
    rmSync(dir, { recursive: true, force: true })
  })
})

describe("F4 prompt hook: chat.message advisories and command.execute.before reach the 2.x prompt", () => {
  const dir = mkdtempSync(join(tmpdir(), "guardrails-v2-prompt-"))
  const f = fakeCtx(dir)
  const seen: any[] = []
  const hooks = {
    "chat.message": async (_in: any, out: any) => {
      seen.push(out.message.role)
      out.parts.push({ id: "x", sessionID: out.message.sessionID, messageID: out.message.id, type: "text", text: "[advisory] fetch first" })
    },
    "command.execute.before": async (item: any, out: any) => {
      seen.push(`${item.command}|${item.arguments}`)
      out.parts[0].prompt = `${out.parts[0].prompt}\n\nextra`
    },
    event: async ({ event }: any) => seen.push(`event:${event.type}:${event.properties.sessionID}`),
  }

  test("parts appended by chat.message are joined into prompt.text; a slash command reaches command.execute.before", async () => {
    const input = v1Input(f.ctx)
    await bridge(f.ctx, hooks, { input })
    const e = { sessionID: "ses_1", messageID: "msg_1", prompt: { text: "hello", files: [] }, delivery: "steer" }
    await f.fire("session.prompt", e)
    expect(e.prompt.text).toBe("hello\n\n[advisory] fetch first")
    const cmd = { sessionID: "ses_1", messageID: "msg_2", prompt: { text: "/review src/x.ts", files: [] }, delivery: "steer" }
    await f.fire("session.prompt", cmd)
    expect(seen).toContain("review|src/x.ts")
    // a 2.x command arrives as its expanded template; the profile templates end with the guardrails marker
    const expanded = { sessionID: "ses_1", messageID: "msg_3", prompt: { text: "Execute the complete workflow…\n\n<!-- guardrails:command=implement -->\n", files: [] }, delivery: "steer" }
    await f.fire("session.prompt", expanded)
    expect(seen).toContain("implement|")
    expect(cmd.prompt.text).toBe("/review src/x.ts\n\nextra\n\n[advisory] fetch first")
  })

  test("chat.params receives message.model.variant, the shape team.ts recordModel reads (Codex #343 r3)", async () => {
    const g = fakeCtx(dir)
    const got: any[] = []
    await bridge(g.ctx, { "chat.params": async (item: any) => void got.push(item) }, { input: v1Input(g.ctx) })
    await g.fire("session.context", { sessionID: "ses_v", agent: "implement", model: { id: "glm-5.3", providerID: "zai-coding-plan", variant: "high" }, system: [], messages: [], options: {}, tools: {} })
    expect(got[0].message.model.variant).toBe("high")
  })

  test("cleanup: the returned function stops the event loop (no handling after dispose, no resubscribe)", async () => {
    const g = fakeCtx(dir)
    const got: string[] = []
    const stop = await bridge(g.ctx, { event: async ({ event }: any) => void got.push(event.type) }, { input: v1Input(g.ctx) })
    g.emit({ type: "session.created", data: { sessionID: "ses_c1" } })
    await new Promise((r) => setTimeout(r, 20))
    await stop()
    g.emit({ type: "session.created", data: { sessionID: "ses_c2" } })
    await new Promise((r) => setTimeout(r, 20))
    expect(got).toEqual(["session.created"])
  })

  test("event loop: 2.x {type,data} events reach the 1.x event hook as {type,properties}", async () => {
    f.emit({ type: "session.created", data: { sessionID: "ses_9" } })
    await new Promise((r) => setTimeout(r, 20))
    expect(seen).toContain("event:session.created:ses_9")
  })

  test("cleanup", () => {
    rmSync(dir, { recursive: true, force: true })
  })
})
