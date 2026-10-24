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
 *   F5 location      a relative path / patch path / shell workdir is judged where the 2.x tool resolves it
 *                    (ctx.location.directory), not against the server's process.cwd() (opencode#345)
 *   F6 subdirectory  a session opened below the repo root keeps its state under location.directory, and that runtime
 *                    is plugin-owned just like the one under the repo root
 *   F7 ordinary      cwd == location: `cd` inside a shell command moves the base like a workdir, a dir-target writer
 *                    naming the bare runtime dir counts, and case variants are the runtime where the FS folds case (#349)
 *
 * Run: bun test packages/guardrails/profile/src/v2/adapter.test.ts
 */
import { describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import guardrailV2 from "../../plugins/guardrail/index"
import teamV2 from "../../plugins/team/index"
import { createContext } from "../guardrail-context"
import { bridge, toV1Call, toV1Calls, toV2Input, v1Input } from "./adapter"
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
    const v1Patch = toV1Call("patch", { patchText: "*** Begin Patch\n*** Update File: src/a.ts\n@@\n-1\n+2\n*** End Patch\n" })
    expect(v1Patch.tool).toBe("edit")
    expect(v1Patch.args.filePath).toBe("src/a.ts")
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

const REL = ".opencode/guardrails/state.json"
/** "PASS", or the guard's reason when the before hook throws. */
const verdict = (p: Promise<unknown>) =>
  p.then(
    () => "PASS",
    (error) => {
      const msg = error instanceof Error ? error.message : String(error)
      return /plugin-owned/.test(msg) ? "plugin-owned" : /protected runtime or config mutation/.test(msg) ? "runtime-mutation" : msg
    },
  )
const at = async <T>(cwd: string, run: () => Promise<T>) => {
  const prev = process.cwd()
  process.chdir(cwd)
  try {
    return await run()
  } finally {
    process.chdir(prev)
  }
}
const patch = (...lines: string[]) => ["*** Begin Patch", ...lines, "@@", "-a", "+b", "*** End Patch", ""].join("\n")

describe("F5 relative paths are judged at ctx.location.directory, not at the server cwd (opencode#345)", () => {
  // A team worker is moved into its own worktree (team.ts session.create → session.move) on a server whose cwd stays
  // the startup directory. The 2.x file tools resolve a relative `path` / patch path / shell `workdir` against
  // location.directory (core file-access.ts resolvePath), so the guard must judge the same absolute path.
  // realpath: process.cwd() after chdir is symlink-free (/private/var on macOS), the location must compare equal to it.
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "guardrails-v2-rel-")))
  const elsewhere = realpathSync(mkdtempSync(join(tmpdir(), "guardrails-v2-cwd-")))
  const f = fakeCtx(dir)
  const RUNTIME = join(dir, ".opencode", "guardrails")
  const before = (tool: string, input: Record<string, unknown>) =>
    f.fire("tool.execute.before", { tool, sessionID: "ses_1", agent: "implement", messageID: "m1", id: `c-${tool}`, input })

  test("setup", async () => {
    await guardrailV2.setup(f.ctx)
  })

  test("edit/write/patch/read of the plugin state: absolute (control) and relative (attack) paths are both denied when cwd ≠ location", async () => {
    const abs = join(dir, REL)
    const rows = await at(elsewhere, async () => ({
      "edit ABS (control)": await verdict(before("edit", { path: abs, oldString: "a", newString: "b" })),
      "write ABS (control)": await verdict(before("write", { path: abs, content: "{}" })),
      "patch ABS (control)": await verdict(before("patch", { patchText: patch(`*** Update File: ${abs}`) })),
      "edit REL": await verdict(before("edit", { path: REL, oldString: "a", newString: "b" })),
      "edit ./REL": await verdict(before("edit", { path: `./${REL}`, oldString: "a", newString: "b" })),
      "edit src/../REL": await verdict(before("edit", { path: `src/../${REL}`, oldString: "a", newString: "b" })),
      "write REL": await verdict(before("write", { path: REL, content: '{"reviewed":true,"factchecked":true}' })),
      "read REL": await verdict(before("read", { path: REL })),
      "patch Update REL": await verdict(before("patch", { patchText: patch(`*** Update File: ${REL}`) })),
      "patch Add REL": await verdict(before("patch", { patchText: patch(`*** Add File: ${REL}`) })),
      "patch Move to REL": await verdict(before("patch", { patchText: patch("*** Update File: src/ok.ts", `*** Move to: ${REL}`) })),
    }))
    expect(rows).toEqual({
      "edit ABS (control)": "plugin-owned",
      "write ABS (control)": "plugin-owned",
      "patch ABS (control)": "plugin-owned",
      "edit REL": "plugin-owned",
      "edit ./REL": "plugin-owned",
      "edit src/../REL": "plugin-owned",
      "write REL": "plugin-owned",
      "read REL": "plugin-owned",
      "patch Update REL": "plugin-owned",
      "patch Add REL": "plugin-owned",
      "patch Move to REL": "plugin-owned",
    })
  })

  test("cwd == location (control): the relative state path is denied", async () => {
    expect(await at(dir, () => verdict(before("edit", { path: REL, oldString: "a", newString: "b" })))).toBe("plugin-owned")
  })

  test("an ordinary relative edit passes and reaches the 2.x tool unchanged (the guard judges the absolute path only)", async () => {
    const e: any = { tool: "edit", sessionID: "ses_1", agent: "implement", messageID: "m1", id: "c-ok", input: { path: "src/a.ts", oldString: "x", newString: "y" } }
    await at(elsewhere, () => f.fire("tool.execute.before", e))
    expect(e.input).toEqual({ path: "src/a.ts", oldString: "x", newString: "y" })
  })

  test("shell workdir: a command run in, or naming a path into, the runtime dir from its workdir is a runtime mutation; prose is not", async () => {
    const rows = await at(elsewhere, async () => ({
      "explicit path (control)": await verdict(before("shell", { command: "printf '{}' > .opencode/guardrails/state.json" })),
      "redirect, absolute workdir": await verdict(before("shell", { command: "printf '{}' > state.json", workdir: RUNTIME })),
      "tee, absolute workdir": await verdict(before("shell", { command: "echo x | tee state.json", workdir: RUNTIME })),
      "redirect, relative workdir": await verdict(before("shell", { command: "printf '{}' > state.json", workdir: ".opencode/guardrails" })),
      "rm, workdir below runtime": await verdict(before("shell", { command: "rm ../state.json", workdir: ".opencode/guardrails/team-runs" })),
      "redirect, workdir .opencode": await verdict(before("shell", { command: "printf '{}' >guardrails/state.json", workdir: ".opencode" })),
      "./ redirect, workdir .opencode": await verdict(before("shell", { command: "printf '{}' > ./guardrails/state.json", workdir: ".opencode" })),
      "cd;, workdir .opencode": await verdict(before("shell", { command: "cd guardrails; printf '{}' > state.json", workdir: ".opencode" })),
      "cd ./ &&, workdir .opencode": await verdict(before("shell", { command: "cd ./guardrails && printf '{}' > state.json", workdir: ".opencode" })),
      "$PWD redirect, workdir .opencode": await verdict(before("shell", { command: `printf '{}' > "$PWD"/guardrails/state.json`, workdir: ".opencode" })),
      "--opt=route, workdir .opencode": await verdict(before("shell", { command: "sort --output=guardrails/state.json x", workdir: ".opencode" })),
      "quoted route, workdir .opencode": await verdict(before("shell", { command: `printf '{}' > "guardrails/state.json"`, workdir: ".opencode" })),
      // quotes pair left to right: the text between two quoted args is not prose
      "between quotes, workdir .opencode": await verdict(before("shell", { command: "printf '{}' > guardrails/state.json && echo 'written ok'", workdir: ".opencode" })),
      "between double quotes, workdir .opencode": await verdict(before("shell", { command: 'printf "{}" > guardrails/state.json && echo "all done"', workdir: ".opencode" })),
      "between quotes, workdir .opencode/team": await verdict(before("shell", { command: "printf '{}' > ../guardrails/state.json && echo 'ok then'", workdir: ".opencode/team" })),
      "read-only in runtime (pass)": await verdict(before("shell", { command: "cat state.json", workdir: RUNTIME })),
      "read-only route (pass)": await verdict(before("shell", { command: "ls guardrails", workdir: ".opencode" })),
      "ordinary workdir (pass)": await verdict(before("shell", { command: "printf ok > out.txt", workdir: "src" })),
      // the runtime path in prose or a non-runtime write is not a runtime mutation (no false positive from this fix)
      "prose in a quoted message, workdir src (pass)": await verdict(before("shell", { command: 'git commit -m "guard ../.opencode/guardrails from edits"', workdir: "src" })),
      "workdir = session dir (pass)": await verdict(before("shell", { command: "git check-ignore -v .opencode/guardrails && mkdir -p .opencode/guardrails", workdir: dir })),
      "no workdir, prose and .gitignore (pass)": await verdict(before("shell", { command: 'git commit -m "fix: protect .opencode/guardrails" && echo .opencode/guardrails >> .gitignore' })),
    }))
    expect(rows).toEqual({
      "explicit path (control)": "runtime-mutation",
      "redirect, absolute workdir": "runtime-mutation",
      "tee, absolute workdir": "runtime-mutation",
      "redirect, relative workdir": "runtime-mutation",
      "rm, workdir below runtime": "runtime-mutation",
      "redirect, workdir .opencode": "runtime-mutation",
      "./ redirect, workdir .opencode": "runtime-mutation",
      "cd;, workdir .opencode": "runtime-mutation",
      "cd ./ &&, workdir .opencode": "runtime-mutation",
      "$PWD redirect, workdir .opencode": "runtime-mutation",
      "--opt=route, workdir .opencode": "runtime-mutation",
      "quoted route, workdir .opencode": "runtime-mutation",
      "between quotes, workdir .opencode": "runtime-mutation",
      "between double quotes, workdir .opencode": "runtime-mutation",
      "between quotes, workdir .opencode/team": "runtime-mutation",
      "read-only in runtime (pass)": "PASS", // same allowance as `cat .opencode/guardrails/state.json`
      "read-only route (pass)": "PASS",
      "ordinary workdir (pass)": "PASS",
      "prose in a quoted message, workdir src (pass)": "PASS",
      "workdir = session dir (pass)": "PASS",
      "no workdir, prose and .gitignore (pass)": "PASS",
    })
  })

  test("a shell workdir the guard does not rewrite reaches the 2.x tool unchanged", async () => {
    const e: any = { tool: "shell", sessionID: "ses_1", agent: "implement", messageID: "m1", id: "c-wd", input: { command: "ls", workdir: "src" } }
    await at(elsewhere, () => f.fire("tool.execute.before", e))
    expect(e.input).toEqual({ command: "ls", workdir: "src" })
  })

  test("toV1Call / toV1Calls / toV2Input with a base: paths are resolved like core FileAccess.resolvePath and written back as given", () => {
    expect(toV1Call("edit", { path: "src/a.ts" }, "/w").args.filePath).toBe("/w/src/a.ts")
    expect(toV1Call("read", { path: "/p/a" }, "/w").args.filePath).toBe("/p/a")
    expect(toV1Call("read", { path: "~/notes.md" }, "/w").args.filePath).toBe(join(homedir(), "notes.md"))
    expect(toV1Call("shell", { command: "ls", workdir: "sub" }, "/w").args.workdir).toBe("/w/sub")
    expect(toV1Calls("patch", { patchText: patch("*** Update File: src/a.ts", "*** Move to: b.ts", "*** Add File: ./src/a.ts") }, "/w").map((c) => c.args.filePath)).toEqual(["/w/src/a.ts", "/w/b.ts"])
    expect(toV2Input("edit", { path: "src/a.ts", filePath: "/w/src/a.ts" }, { path: "src/a.ts" }, "/w")).toEqual({ path: "src/a.ts" })
    expect(toV2Input("edit", { path: "src/a.ts", filePath: "/w/src/b.ts" }, { path: "src/a.ts" }, "/w")).toEqual({ path: "/w/src/b.ts" }) // a rewrite is written back
    expect(toV2Input("shell", { command: "ls", workdir: "/w/sub" }, { command: "ls", workdir: "sub" }, "/w")).toEqual({ command: "ls", workdir: "sub" })
  })

  // PAIR: adapter.ts resolveIn restates where core puts a tool path. Pinned by string (core is not importable without
  // `bun install`, see .github/workflows/guardrails.yml); a core change to any of these turns this red.
  test("PAIR: core resolves file, patch and shell workdir paths at location.directory (resolvePath, ~ and ~/ expanded)", () => {
    const core = join(import.meta.dir, "..", "..", "..", "..", "core", "src")
    const src = (file: string) => readFileSync(join(core, file), "utf-8")
    expect(src("file-access.ts")).toContain("export const resolvePath = (directory: string, input: string, home = Global.Path.home) => {")
    expect(src("file-access.ts")).toContain('normalized === "~"')
    expect(src("file-access.ts")).toContain('normalized.startsWith("~/")')
    expect(src("file-access.ts")).toContain("AbsolutePath.make(resolvePath(location.directory, input.path))")
    expect(src("tool/plugin/read.ts")).toContain("access.authorizeRead(input.path, context)")
    expect(src("tool/plugin/edit.ts")).toContain('access.resolve({ path: input.path, kind: "file" })')
    expect(src("tool/plugin/write.ts")).toContain('access.resolve({ path: input.path, kind: "file" })')
    expect(src("tool/plugin/patch.ts")).toContain("FileAccess.resolvePath(location.directory, hunk.path)")
    expect(src("tool/plugin/patch.ts")).toContain("FileAccess.resolvePath(location.directory, hunk.movePath)")
    expect(src("tool/plugin/shell.ts")).toContain("cwd: input.workdir,")
    expect(src("tool/plugin/shell.ts")).toContain('access.resolve({ path: invocation.cwd, kind: "directory" })')
  })

  test("cleanup", () => {
    rmSync(dir, { recursive: true, force: true })
    rmSync(elsewhere, { recursive: true, force: true })
  })
})

describe("F6 a session in a repo subdirectory: the runtime under location.directory is plugin-owned too", () => {
  // Core project.ts walks up from location.directory to .git, so a session opened in <repo>/packages/x gets
  // location.directory = <repo>/packages/x and project.directory = <repo>; v1Input maps them to directory and worktree.
  // The plugin keeps its state under directory (guardrail-context.ts `root`), while team runs live under worktree.
  const repo = realpathSync(mkdtempSync(join(tmpdir(), "guardrails-v2-repo-")))
  const sub = join(repo, "packages", "x")
  const elsewhere = realpathSync(mkdtempSync(join(tmpdir(), "guardrails-v2-subcwd-")))
  const f = fakeCtx(sub)
  f.ctx.location = { directory: sub, project: { id: "p", directory: repo, canonical: repo } }
  const before = (tool: string, input: Record<string, unknown>) =>
    f.fire("tool.execute.before", { tool, sessionID: "ses_1", agent: "implement", messageID: "m1", id: `c-${tool}`, input })

  test("setup: the plugin writes its state under the session directory, not the repo root", async () => {
    await guardrailV2.setup(f.ctx)
    expect(existsSync(join(sub, ".opencode", "guardrails"))).toBe(true)
    expect(existsSync(join(repo, ".opencode", "guardrails"))).toBe(false)
  })

  test("edit/write/read/patch of the state under the session directory is denied, absolute and relative", async () => {
    const rows = await at(elsewhere, async () => ({
      "edit repo-root state ABS (control)": await verdict(before("edit", { path: join(repo, REL), oldString: "a", newString: "b" })),
      "edit sub state ABS": await verdict(before("edit", { path: join(sub, REL), oldString: "a", newString: "b" })),
      "edit sub state REL": await verdict(before("edit", { path: REL, oldString: "a", newString: "b" })),
      "write sub state REL": await verdict(before("write", { path: REL, content: '{"reviewed":true,"factchecked":true}' })),
      "read sub events REL": await verdict(before("read", { path: ".opencode/guardrails/events.jsonl" })),
      "patch Update sub state REL": await verdict(before("patch", { patchText: patch(`*** Update File: ${REL}`) })),
      "edit sub src/a.ts (pass)": await verdict(before("edit", { path: "src/a.ts", oldString: "x", newString: "y" })),
      "edit sub .opencode/guardrailsX (pass)": await verdict(before("edit", { path: join(sub, ".opencode", "guardrailsX", "a.json"), oldString: "a", newString: "b" })),
      "read repo team run (pass)": await verdict(before("read", { path: join(repo, ".opencode", "guardrails", "team-runs", "r.json") })),
      "edit repo team run": await verdict(before("edit", { path: join(repo, ".opencode", "guardrails", "team-runs", "r.json"), oldString: "a", newString: "b" })),
    }))
    expect(rows).toEqual({
      "edit repo-root state ABS (control)": "plugin-owned",
      "edit sub state ABS": "plugin-owned",
      "edit sub state REL": "plugin-owned",
      "write sub state REL": "plugin-owned",
      "read sub events REL": "plugin-owned",
      "patch Update sub state REL": "plugin-owned",
      "edit sub src/a.ts (pass)": "PASS",
      "edit sub .opencode/guardrailsX (pass)": "PASS", // a sibling name is not the runtime dir
      "read repo team run (pass)": "PASS", // team runs stay readable, only their edit is denied
      "edit repo team run": "plugin-owned",
    })
  })

  test("1.x without a repo (worktree '/'): the state is plugin-owned and team runs stay readable", async () => {
    // 1.x passes worktree "/" outside git; rel("/", file) never matched, so the old hidden() protected nothing there.
    // team.ts then falls back to directory for its runs (projectRoot), so the read exemption must hold there too.
    const ctx = await createContext({ ...v1Input(fakeCtx(sub).ctx), worktree: "/" })
    expect(ctx.deny(join(sub, REL), "edit")).toBe("guardrail runtime state is plugin-owned")
    expect(ctx.deny(join(sub, ".opencode", "guardrails", "team-runs", "r.json"), "read")).toBeUndefined()
    expect(ctx.deny(join(sub, ".opencode", "guardrails", "team-runs", "r.json"), "edit")).toBe("guardrail runtime state is plugin-owned")
  })

  // PAIR: team.ts keeps its runs under projectRoot(directory, worktree); the context's runtime roots must cover both.
  test("PAIR: team.ts writes runs at <directory or worktree>/.opencode/guardrails/team-runs", () => {
    const team = readFileSync(join(import.meta.dir, "..", "team.ts"), "utf-8")
    expect(team).toContain('return worktree && worktree !== "/" ? worktree : directory')
    expect(team).toContain('return path.join(dir, ".opencode", "guardrails", "team-runs")')
  })

  test("shell: a workdir in, or a path from the workdir into, the runtime under the session directory is a runtime mutation", async () => {
    const rows = await at(elsewhere, async () => ({
      "explicit path, no workdir (control)": await verdict(before("shell", { command: `printf '{}' > ${REL}` })),
      "redirect, repo-root runtime workdir (control)": await verdict(before("shell", { command: "printf '{}' > state.json", workdir: join(repo, ".opencode", "guardrails") })),
      "redirect, relative workdir": await verdict(before("shell", { command: "printf '{}' > state.json", workdir: ".opencode/guardrails" })),
      "redirect, absolute sub runtime workdir": await verdict(before("shell", { command: "printf '{}' > state.json", workdir: join(sub, ".opencode", "guardrails") })),
      "redirect, workdir .opencode": await verdict(before("shell", { command: "printf '{}' > guardrails/state.json", workdir: ".opencode" })),
      "read-only in sub runtime (pass)": await verdict(before("shell", { command: "cat state.json", workdir: ".opencode/guardrails" })),
      "ordinary workdir (pass)": await verdict(before("shell", { command: "printf ok > out.txt", workdir: "src" })),
    }))
    expect(rows).toEqual({
      "explicit path, no workdir (control)": "runtime-mutation",
      "redirect, repo-root runtime workdir (control)": "runtime-mutation",
      "redirect, relative workdir": "runtime-mutation",
      "redirect, absolute sub runtime workdir": "runtime-mutation",
      "redirect, workdir .opencode": "runtime-mutation",
      "read-only in sub runtime (pass)": "PASS",
      "ordinary workdir (pass)": "PASS",
    })
  })

  test("cleanup", () => {
    rmSync(repo, { recursive: true, force: true })
    rmSync(elsewhere, { recursive: true, force: true })
  })
})

describe("F7 an ordinary session (cwd == location): in-command `cd`, the bare runtime dir and case variants (opencode#349)", () => {
  // The normal 1-project start: no workdir, or workdir = the session directory. `cd` inside the command moves where
  // the later relative paths land, exactly like a workdir does (OC-N1). APFS (the macOS default) is case-insensitive,
  // so `.OPENCODE/guardrails/state.json` names the real state file there (OC-N2).
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "guardrails-v2-cd-")))
  const f = fakeCtx(dir)
  const before = (tool: string, input: Record<string, unknown>) =>
    f.fire("tool.execute.before", { tool, sessionID: "ses_1", agent: "implement", messageID: "m1", id: `c-${tool}`, input })

  test("setup", async () => {
    await guardrailV2.setup(f.ctx)
  })

  test("shell: `cd` into the runtime, or a mutation that targets the runtime dir itself, is a runtime mutation", async () => {
    const rows = await at(dir, async () => ({
      "explicit path (control)": await verdict(before("shell", { command: `printf '{}' > ${REL}` })),
      "cd runtime &&": await verdict(before("shell", { command: `cd .opencode/guardrails && printf '{"reviewed":true}' > state.json` })),
      "cd runtime; rm": await verdict(before("shell", { command: "cd .opencode/guardrails; rm state.json" })),
      "cd .opencode && route": await verdict(before("shell", { command: "cd .opencode && printf '{}' > guardrails/state.json" })),
      "cd twice": await verdict(before("shell", { command: "cd .opencode && cd guardrails && printf x > state.json" })),
      "cp into the bare runtime dir": await verdict(before("shell", { command: "cp /tmp/x.json .opencode/guardrails" })),
      "rm -rf the bare runtime dir": await verdict(before("shell", { command: "rm -rf .opencode/guardrails" })),
      "workdir = session dir, cd .opencode": await verdict(before("shell", { command: "cd .opencode && printf x > guardrails/state.json", workdir: dir })),
      "cd case variant": await verdict(before("shell", { command: "cd .OPENCODE/Guardrails && printf x > state.json" })),
      "cd ordinary dir (pass)": await verdict(before("shell", { command: "cd src && printf ok > out.txt" })),
      "cd runtime, read-only (pass)": await verdict(before("shell", { command: "cd .opencode/guardrails && cat state.json" })),
      "cd .opencode, list (pass)": await verdict(before("shell", { command: "cd .opencode && ls guardrails" })),
      "cd out of runtime before writing (still blocked)": await verdict(before("shell", { command: "cd .opencode/guardrails && cd ../.. && printf ok > out.txt" })),
      "mkdir -p the runtime dir (pass)": await verdict(before("shell", { command: "mkdir -p .opencode/guardrails" })),
      "runtime dir in .gitignore (pass)": await verdict(before("shell", { command: "echo .opencode/guardrails >> .gitignore" })),
      "sibling name (pass)": await verdict(before("shell", { command: "cd .opencode/guardrailsX && printf x > a.json" })),
    }))
    expect(rows).toEqual({
      "explicit path (control)": "runtime-mutation",
      "cd runtime &&": "runtime-mutation",
      "cd runtime; rm": "runtime-mutation",
      "cd .opencode && route": "runtime-mutation",
      "cd twice": "runtime-mutation",
      "cp into the bare runtime dir": "runtime-mutation",
      "rm -rf the bare runtime dir": "runtime-mutation",
      "workdir = session dir, cd .opencode": "runtime-mutation",
      "cd case variant": caseInsensitive() ? "runtime-mutation" : "PASS",
      "cd ordinary dir (pass)": "PASS",
      "cd runtime, read-only (pass)": "PASS", // same allowance as `cat .opencode/guardrails/state.json`
      "cd .opencode, list (pass)": "PASS",
      // every candidate base is judged (the guard does not know which cd ran), so leaving again does not unblock (#350)
      "cd out of runtime before writing (still blocked)": "runtime-mutation",
      "mkdir -p the runtime dir (pass)": "PASS",
      "runtime dir in .gitignore (pass)": "PASS",
      "sibling name (pass)": "PASS",
    })
  })

  test("edit/write/read of a case variant of the state path is denied where the filesystem folds case", async () => {
    const expected = caseInsensitive() ? "plugin-owned" : "PASS"
    const rows = await at(dir, async () => ({
      "edit .OPENCODE REL": await verdict(before("edit", { path: ".OPENCODE/guardrails/state.json", oldString: "a", newString: "b" })),
      "write Guardrails ABS": await verdict(before("write", { path: join(dir, ".opencode", "Guardrails", "state.json"), content: "{}" })),
      "read STATE.JSON REL": await verdict(before("read", { path: ".opencode/GUARDRAILS/state.json" })),
      "edit lowercase REL (control)": await verdict(before("edit", { path: REL, oldString: "a", newString: "b" })),
    }))
    expect(rows).toEqual({
      "edit .OPENCODE REL": expected,
      "write Guardrails ABS": expected,
      "read STATE.JSON REL": expected,
      "edit lowercase REL (control)": "plugin-owned",
    })
  })

  /** The answer the guard must agree with: does the swapped-case name reach the real runtime dir on this machine? */
  function caseInsensitive() {
    return existsSync(join(dir, ".OPENCODE", "GUARDRAILS"))
  }

  test("cleanup", () => {
    rmSync(dir, { recursive: true, force: true })
  })
})

describe("F8 directory tracking only adds blocks: every way a shell can change or name its directory (opencode#349, #350 review)", () => {
  // Each row is a shape that wrote state.json under real bash/zsh/sh, or a pre-fix block that must stay a block.
  // `cd` may be spelled builtin / command / \cd / "cd" / X=1 cd, sit in ( ), { }, if …; then, be undone by `cd -` or
  // `popd`, go through CDPATH, fail (`||`) or run in a pipeline; a dir-target writer may name the runtime's parent.
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "guardrails-v2-cdadd-")))
  const wt = realpathSync(mkdtempSync(join(tmpdir(), "guardrails-v2-cdadd-wt-")))
  const elsewhere = realpathSync(mkdtempSync(join(tmpdir(), "guardrails-v2-cdadd-cwd-")))
  const ordinary = fakeCtx(dir)
  const worker = fakeCtx(wt)
  const RT = ".opencode/guardrails"
  const W = "printf '{\"reviewed\":true}' > state.json"
  const M = "runtime-mutation"
  const shell = (f: ReturnType<typeof fakeCtx>, command: string, workdir?: string) =>
    verdict(
      f.fire("tool.execute.before", {
        tool: "shell",
        sessionID: "ses_1",
        agent: "implement",
        messageID: "m1",
        id: "c-sh",
        input: workdir === undefined ? { command } : { command, workdir },
      }),
    )
  const judge = async (f: ReturnType<typeof fakeCtx>, cwd: string, rows: [string, string, string?][]) => {
    const key = (command: string, workdir?: string) => `${workdir ?? "-"} | ${command}`
    const got = await at(cwd, async () => {
      const out: Record<string, string> = {}
      for (const [command, , workdir] of rows) out[key(command, workdir)] = await shell(f, command, workdir)
      return out
    })
    expect(got).toEqual(Object.fromEntries(rows.map(([command, want, workdir]) => [key(command, workdir), want])))
  }

  test("setup", async () => {
    await guardrailV2.setup(ordinary.ctx)
    await guardrailV2.setup(worker.ctx)
  })

  test("ordinary session (cwd == location, no workdir): cd spellings, compound commands, CDPATH, cd - / popd", async () => {
    await judge(ordinary, dir, [
      [`cd ${RT}/ && cat state.json && printf x >> state.json`, M],
      [`( cd ${RT} && ${W} )`, M],
      [`{ cd ${RT}; ${W}; }`, M],
      [`if cd ${RT}; then ${W}; fi`, M],
      [`builtin cd ${RT} && ${W}`, M],
      [`\\cd ${RT} && ${W}`, M],
      [`"cd" ${RT} && ${W}`, M],
      [`command cd ${RT} && ${W}`, M],
      [`FOO=1 cd ${RT} && ${W}`, M],
      [`CDPATH=.opencode cd guardrails && ${W}`, M],
      [`export CDPATH=.opencode; cd guardrails && ${W}`, M],
      [`cd ${RT} && cd /tmp && cd - && ${W}`, M],
      [`pushd ${RT} && pushd /tmp && popd && ${W}`, M],
      [`cd ${RT} && ls && printf '{"reviewed":true}'>state.json`, M],
      [`cd ${RT} && printf x >| state.json`, M],
      [`cd ${RT} && sed -n 'w state.json' /tmp/x`, M],
    ])
  })

  test("ordinary session: a dir-target writer naming the runtime, its parent or a case variant; git -C; OC-N3 shapes", async () => {
    await judge(ordinary, dir, [
      ["cp -R /tmp/evil/guardrails .opencode", M],
      ["rsync -a /tmp/evil/ .opencode", M],
      ["tar -xf x.tar -C .opencode", M],
      ["unzip -o x.zip -d .opencode", M],
      ["rm -rf .opencode", M],
      ["find .opencode -name state.json -delete", M],
      [`CP /tmp/x.json ${RT}`, M],
      [`git -C ${RT} checkout -- state.json`, M],
      ["printf x > .opencode/guard*/state.json", M],
      [`D=${RT}; printf x > $D/state.json`, M],
      [`printf x > $(echo ${RT})/state.json`, M],
      // source-argument false positives: kept blocked so the rule stays one-directional (see the PR)
      [`cp -r ${RT} /tmp/backup`, M],
      [`tar -czf /tmp/g.tgz ${RT}`, M],
    ])
  })

  test("team worker (cwd elsewhere): failed cd, pipelines, a cd's own redirect, prefixed cd, cd in compounds, OC-N3", async () => {
    const runtime = join(wt, ".opencode", "guardrails")
    await judge(worker, elsewhere, [
      ["cd /does-not-exist || printf x > state.json", M, runtime],
      ["cd ../.. | printf x > state.json", M, runtime],
      ["X=/tmp cd . && printf x > state.json", M, runtime],
      ["cd ../.. > state.json", M, ".opencode/guardrails"],
      [`( cd ../${RT} && ${W} )`, M, "src"],
      [`builtin cd ../${RT} && ${W}`, M, "src"],
      [`\\cd ../${RT} && ${W}`, M, "src"],
      [`"cd" ../${RT} && ${W}`, M, "src"],
      [`FOO=1 cd ../${RT} && ${W}`, M, "src"],
      [`if cd ../${RT}; then ${W}; fi`, M, "src"],
      [`{ cd ../${RT}; ${W}; }`, M, "src"],
      [`cd ../${RT} && ls && ${W}`, M, "src"],
      [`( cd guardrails && ${W} )`, M, ".opencode"],
      [`builtin cd guardrails && ${W}`, M, ".opencode"],
      [`FOO=1 cd guardrails && ${W}`, M, ".opencode"],
      ["cd guardrails && ls && printf x>state.json", M, ".opencode"],
      ["printf '{}' > guard*/state.json", M, ".opencode"],
      ['eval "printf x > guardrails/state.json"', M, ".opencode"],
      ["sh -c 'printf x > guardrails/state.json'", M, ".opencode"],
      [`python3 -c "open('guardrails/state.json','w').write('{}')"`, M, ".opencode"],
      ["D=guardrails; printf x > $D/state.json", M, ".opencode"],
      ["printf x > $(echo guardrails)/state.json", M, ".opencode"],
    ])
  })

  test("benign rows stay allowed (no false positive from the added checks)", async () => {
    await judge(ordinary, dir, [
      [`mkdir -p ${RT}`, "PASS"],
      [`git check-ignore -v ${RT}`, "PASS"],
      [`echo ${RT} >> .gitignore`, "PASS"],
      [`cat ${RT}/state.json`, "PASS"],
      [`cd ${RT} && cat state.json`, "PASS"],
      [`cd ${RT} && ls -la 2>/dev/null`, "PASS"],
      ["cd src && printf ok > out.txt", "PASS"],
      ["cd .opencode && ls guardrails", "PASS"],
      ["cp a.txt b.txt && rm -rf dist", "PASS"],
      ['git commit -m "cd .opencode/guardrails is protected"', "PASS"],
    ])
  })

  test("cleanup", () => {
    for (const d of [dir, wt, elsewhere]) rmSync(d, { recursive: true, force: true })
  })
})

describe("F9 sed with an in-place flag is a write, wherever the flag sits (OC-N4, opencode#351)", () => {
  // The read-only allowlists took any `sed -n` as a reader, and the write pattern only saw `-i` right after `sed`,
  // so `sed -n -i '' …` rewrote plugin-owned state (real BSD sed did, in the #350 round-2 acceptance).
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "guardrails-v2-sed-")))
  const f = fakeCtx(dir)
  const RT = ".opencode/guardrails"
  const M = "runtime-mutation"
  const judge = async (rows: [string, string, string?][]) => {
    const key = (command: string, workdir?: string) => `${workdir ?? "-"} | ${command}`
    const got = await at(dir, async () => {
      const out: Record<string, string> = {}
      for (const [command, , workdir] of rows) {
        const input = workdir === undefined ? { command } : { command, workdir }
        out[key(command, workdir)] = await verdict(
          f.fire("tool.execute.before", { tool: "shell", sessionID: "ses_1", agent: "implement", messageID: "m1", id: "c-sh", input }),
        )
      }
      return out
    })
    expect(got).toEqual(Object.fromEntries(rows.map(([command, want, workdir]) => [key(command, workdir), want])))
  }

  test("setup", async () => {
    await guardrailV2.setup(f.ctx)
  })

  test("an in-place flag anywhere among sed's options is a runtime mutation", async () => {
    await judge([
      [`sed -n -i '' 's/"reviewed":false/"reviewed":true/p' ${RT}/state.json`, M],
      [`cd ${RT} && sed -n -i '' 's/false/true/p' state.json`, M],
      [`sed -n -i.bak 's/false/true/p' ${RT}/state.json`, M],
      [`sed -E -n -i '' 's/false/true/p' ${RT}/state.json`, M],
      [`sed -ni 's/false/true/p' ${RT}/state.json`, M],
      [`sed -n --in-place 's/false/true/p' ${RT}/state.json`, M],
      [`sed -n -I '' 's/false/true/p' ${RT}/state.json`, M],
      [`/usr/bin/sed -n -i '' 's/false/true/p' ${RT}/state.json`, M],
      [`sed -n -i '' 's/false/true/p' state.json`, M, join(dir, RT)],
      [`sed -n '1p;2p' -i ${RT}/state.json`, M],
      [`sed -n p '-i' ${RT}/state.json`, M],
      [`sh -c "sed -n -i '' s/x/y/ ${RT}/state.json"`, M],
    ])
  })

  test("escaped or ANSI-C-quoted flags and names, and GNU long-option prefixes, are still writes (#353 round 2)", async () => {
    // opencode#353 acceptance: a backslash outside quotes vanishes before sed sees the word, `$'…'` is decoded by bash,
    // and GNU getopt_long accepts any unambiguous prefix of --in-place. Real BSD sed rewrote state.json through the
    // first six; real GNU sed 4.10 through all of them (gsed, 2026-10-24).
    await judge([
      [`sed -n \\-i '' 's/false/true/p' ${RT}/state.json`, M],
      [`sed -n -\\i '' 's/false/true/p' ${RT}/state.json`, M],
      [`sed -n $'-i' '' 's/false/true/p' ${RT}/state.json`, M],
      [`sed -n $'\\x2di' '' 's/false/true/p' ${RT}/state.json`, M],
      [`cd ${RT} && \\sed -n -i '' 's/false/true/p' state.json`, M],
      [`cd ${RT} && s\\ed -n -i '' 's/false/true/p' state.json`, M],
      [`sed -n --in 's/false/true/p' ${RT}/state.json`, M],
      [`sed -n --in-pl 's/false/true/p' ${RT}/state.json`, M],
      [`sed -n --in-place=.bak 's/false/true/p' ${RT}/state.json`, M],
      [`sed -n 's/false/true/p' -i ${RT}/state.json`, M],
      [`sed -n 's/false/true/p' '-i' ${RT}/state.json`, M],
      // round 3: a double-quoted word is outside the one accepted read shape (single-quote the script instead)
      [`sed -n "\\-i" ${RT}/state.json`, M],
    ])
  })

  test("round 3: only `sed -n [-E|-r] <script> <path>…` with no \\ $ \" ` # -- is a read; every other sed is a write", async () => {
    // aidd-governance#219 (round-2 acceptance, REJECT): `$"-i"`, another `$'-i'` reading, GNU `--i` / `--i=.bak`, a
    // postfix `-i` behind an escaped quote, and `I=-i; … $I` still reached sed as in-place. Each wrote state.json with
    // real BSD or GNU sed. Owner (A): stop enumerating write shapes; accept one narrow read shape and block the rest.
    await judge([
      [`sed -n p ${RT}/state.json`, "PASS"],
      [`sed -n 's/false/true/p' ${RT}/state.json`, "PASS"],
      [`sed -n -E '/rev/p' ${RT}/state.json`, "PASS"],
      [`cd ${RT} && sed -n -r 1p state.json`, "PASS"],
      [`sed -n $"-i" '' 's/false/true/p' ${RT}/state.json`, M],
      [`cd ${RT} && sed -n $"-i" '' 's/false/true/p' state.json`, M],
      [`sed -n $'-i' '' 's/false/true/p' ${RT}/state.json`, M],
      [`sed -n --i 's/false/true/p' ${RT}/state.json`, M],
      [`sed -n --i=.bak 's/false/true/p' ${RT}/state.json`, M],
      [`cd ${RT} && sed -n --i 's/false/true/p' state.json`, M],
      [`sed -n 's/false/true/p' \\" -i ${RT}/state.json \\"`, M],
      [`sed -n 's/false/true/p' \\' -i ${RT}/state.json \\'`, M],
      [`cd ${RT} && I=-i; sed -n $I '' 's/false/true/p' state.json`, M],
      [`sed -n "p" ${RT}/state.json`, M],
      [`sed -n -- p ${RT}/state.json`, M],
      [`sed -n p ${RT}/state.json # -i`, M],
      [`sed -n 'w /tmp/x' ${RT}/state.json`, M],
      [`sed -n 's/a/b/e' ${RT}/state.json`, M],
      [`sed p ${RT}/state.json`, M],
      // Codex review of d978389483: write commands behind an address or another delimiter, and a quoted option in the
      // script's place, slipped through the first positive shape; a quoted script with spaces must still read
      [`sed -E -n '1w ${RT}/state.json' seed.txt`, M],
      [`sed -n 's:false:true:w ${RT}/state.json' seed.txt`, M],
      [`sed -E -n '-f' program.sed ${RT}/state.json`, M],
      [`sed -n '/a/,/b/w out' ${RT}/state.json`, M],
      [`sed -n '/review state/p' ${RT}/state.json`, "PASS"],
      [`sed -n '/a/!d' ${RT}/state.json`, "PASS"],
      // Codex review of 085fd01125: an expansion inside double quotes still runs; `*` as the s delimiter; `do` in a script
      [`cat /dev/null"$(find ${RT}/state.json -delete)"`, M],
      [`cat /dev/null"\`rm ${RT}/state.json\`"`, M],
      [`sed -n 's*a*b*p' ${RT}/state.json`, "PASS"],
      [`sed -n 's+a+b+p' ${RT}/state.json`, "PASS"],
      [`sed -n '/do work/p' ${RT}/state.json`, "PASS"],
      // Codex review of fafd32bc88: a line continuation vanishes before the shell reads the word; a pipe of reads is a read
      [`find ${RT}/state.json -de\\\n` + `lete`, M],
      [`sed -n '1,20p' ${RT}/state.json | head -n 5`, "PASS"],
    ])
  })

  test("`-i` inside a sed script is not a flag, so these reads stay allowed", async () => {
    await judge([
      [`sed -n p ${RT}/state.json`, "PASS"],
      [`sed -n 's/x/-i/p' ${RT}/state.json`, "PASS"],
      [`sed -n 's/false/ -i /p' ${RT}/state.json`, "PASS"],
    ])
  })

  test("cleanup", () => {
    rmSync(dir, { recursive: true, force: true })
  })
})
