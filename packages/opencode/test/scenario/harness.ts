import { NodeFileSystem } from "@effect/platform-node"
import { expect } from "bun:test"
import fs from "fs/promises"
import { Effect, Layer } from "effect"
import path from "path"
import { Agent as AgentSvc } from "../../src/agent/agent"
import { Auth } from "../../src/auth"
import { Bus } from "../../src/bus"
import { Command } from "../../src/command"
import { Config } from "../../src/config/config"
import { Env } from "../../src/env"
import { FileTime } from "../../src/file/time"
import { AppFileSystem } from "../../src/filesystem"
import { LSP } from "../../src/lsp"
import { MCP } from "../../src/mcp"
import { Permission } from "../../src/permission"
import { Plugin } from "../../src/plugin"
import { Provider as ProviderSvc } from "../../src/provider/provider"
import { Session } from "../../src/session"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionCompaction } from "../../src/session/compaction"
import { Instruction } from "../../src/session/instruction"
import { LLM } from "../../src/session/llm"
import { SessionProcessor } from "../../src/session/processor"
import { SessionPrompt } from "../../src/session/prompt"
import { SessionStatus } from "../../src/session/status"
import { Snapshot } from "../../src/snapshot"
import { ToolRegistry } from "../../src/tool/registry"
import { Truncate } from "../../src/tool/truncate"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"
import { Instance } from "../../src/project/instance"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { TestLLMServer } from "../lib/llm-server"
import type { Replay } from "./replay"

const profile = path.resolve(import.meta.dir, "../../../guardrails/profile")

const mcp = Layer.succeed(
  MCP.Service,
  MCP.Service.of({
    status: () => Effect.succeed({}),
    clients: () => Effect.succeed({}),
    tools: () => Effect.succeed({}),
    prompts: () => Effect.succeed({}),
    resources: () => Effect.succeed({}),
    add: () => Effect.succeed({ status: { status: "disabled" as const } }),
    connect: () => Effect.void,
    disconnect: () => Effect.void,
    getPrompt: () => Effect.succeed(undefined),
    readResource: () => Effect.succeed(undefined),
    startAuth: () => Effect.die("unexpected MCP auth in scenario tests"),
    authenticate: () => Effect.die("unexpected MCP auth in scenario tests"),
    finishAuth: () => Effect.die("unexpected MCP auth in scenario tests"),
    removeAuth: () => Effect.void,
    supportsOAuth: () => Effect.succeed(false),
    hasStoredTokens: () => Effect.succeed(false),
    getAuthStatus: () => Effect.succeed("not_authenticated" as const),
  }),
)

const lsp = Layer.succeed(
  LSP.Service,
  LSP.Service.of({
    init: () => Effect.void,
    status: () => Effect.succeed([]),
    hasClients: () => Effect.succeed(false),
    touchFile: () => Effect.void,
    diagnostics: () => Effect.succeed({}),
    hover: () => Effect.succeed(undefined),
    definition: () => Effect.succeed([]),
    references: () => Effect.succeed([]),
    implementation: () => Effect.succeed([]),
    documentSymbol: () => Effect.succeed([]),
    workspaceSymbol: () => Effect.succeed([]),
    prepareCallHierarchy: () => Effect.succeed([]),
    incomingCalls: () => Effect.succeed([]),
    outgoingCalls: () => Effect.succeed([]),
  }),
)

const filetime = Layer.succeed(
  FileTime.Service,
  FileTime.Service.of({
    read: () => Effect.void,
    get: () => Effect.succeed(undefined),
    assert: () => Effect.void,
    withLock: (_file, fn) => Effect.promise(fn),
  }),
)

const status = SessionStatus.layer.pipe(Layer.provideMerge(Bus.layer))
const infra = Layer.mergeAll(NodeFileSystem.layer, CrossSpawnSpawner.defaultLayer)

function make() {
  const deps = Layer.mergeAll(
    Session.defaultLayer,
    Snapshot.defaultLayer,
    LLM.defaultLayer,
    AgentSvc.defaultLayer,
    Command.defaultLayer,
    Permission.defaultLayer,
    Plugin.defaultLayer,
    Config.defaultLayer,
    ProviderSvc.defaultLayer,
    filetime,
    lsp,
    mcp,
    AppFileSystem.defaultLayer,
    status,
  ).pipe(Layer.provideMerge(infra))
  const reg = ToolRegistry.layer.pipe(Layer.provideMerge(deps))
  const trunc = Truncate.layer.pipe(Layer.provideMerge(deps))
  const proc = SessionProcessor.layer.pipe(Layer.provideMerge(deps))
  const compact = SessionCompaction.layer.pipe(Layer.provideMerge(proc), Layer.provideMerge(deps))
  return Layer.mergeAll(
    TestLLMServer.layer,
    SessionPrompt.layer.pipe(
      Layer.provideMerge(compact),
      Layer.provideMerge(proc),
      Layer.provideMerge(reg),
      Layer.provideMerge(trunc),
      Layer.provide(Instruction.defaultLayer),
      Layer.provideMerge(deps),
    ),
  )
}

export const it = testEffect(make())

function root(dir: string) {
  return path.join(dir, ".opencode", "guardrails")
}

function withProfile<A, E, R>(fx: Effect.Effect<A, E, R>) {
  return Effect.acquireUseRelease(
    Effect.sync(() => {
      const prev = process.env.OPENCODE_CONFIG_DIR
      process.env.OPENCODE_CONFIG_DIR = profile
      return prev
    }),
    () => fx,
    (prev) =>
      Effect.sync(() => {
        if (prev === undefined) delete process.env.OPENCODE_CONFIG_DIR
        else process.env.OPENCODE_CONFIG_DIR = prev
      }),
  )
}

function queue(llm: TestLLMServer["Service"], replay: Replay) {
  return Effect.forEach(replay.steps, (step) => {
    if (step.kind === "text") return llm.text(step.text)
    return llm.tool(step.name, step.input)
  }).pipe(Effect.asVoid)
}

export function run(replay: Replay) {
  return withProfile(
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          const llm = yield* TestLLMServer
          const prompt = yield* SessionPrompt.Service

          yield* Effect.promise(() => Auth.remove("openai"))
          yield* Effect.promise(() => Auth.remove("openrouter"))
          yield* Effect.promise(() => Auth.remove("zai"))

          Env.set("OPENCODE_E2E_LLM_URL", llm.url)
          Env.set("ZHIPU_API_KEY", "test-zai-key")
          Env.set("OPENAI_API_KEY", "test-openai-key")
          Env.set("OPENROUTER_API_KEY", "test-openrouter-key")

          if (replay.state) {
            yield* Effect.promise(() => fs.mkdir(root(dir), { recursive: true }))
            yield* Effect.promise(() =>
              Bun.write(path.join(root(dir), "state.json"), JSON.stringify(replay.state, null, 2) + "\n"),
            )
          }

          yield* queue(llm, replay)

          const chat = yield* Effect.promise(() => Session.create({ title: replay.name }))
          const out = yield* prompt.command({
            sessionID: chat.id,
            command: replay.command,
            arguments: replay.args,
            model: replay.model,
          })
          const msgs = yield* MessageV2.filterCompactedEffect(chat.id)
          const hits = yield* llm.hits
          const log = yield* Effect.promise(() => Bun.file(path.join(root(dir), "events.jsonl")).text().catch(() => ""))
          const state = yield* Effect.promise<Record<string, unknown>>(() =>
            Bun.file(path.join(root(dir), "state.json"))
              .json()
              .catch(() => ({})),
          )

          return { chat, dir, hits, log, msgs, out, state }
        }),
      {
        git: true,
        config: {
          model: replay.model,
          share: "auto",
        },
      },
    ),
  )
}

export function hitModels(hits: { body: Record<string, unknown> }[]) {
  return hits
    .filter((hit) => !JSON.stringify(hit.body).includes("Generate a title for this conversation"))
    .map((hit) => hit.body.model)
    .filter((item): item is string => typeof item === "string")
}

export function userText(msgs: MessageV2.WithParts[]) {
  const msg = msgs.find((item) => item.info.role === "user")
  const part = msg?.parts.find((item): item is MessageV2.TextPart => item.type === "text")
  return part?.text
}

export function userTask(msgs: MessageV2.WithParts[]) {
  const msg = msgs.find((item) => item.info.role === "user")
  return msg?.parts.find((item): item is MessageV2.SubtaskPart => item.type === "subtask")
}

export function toolMsg(msgs: MessageV2.WithParts[], agent: string) {
  return msgs.find((item) => item.info.role === "assistant" && item.info.agent === agent)
}

export function assertReplay(
  replay: Replay,
  data: {
    hits: { body: Record<string, unknown> }[]
    log: string
    msgs: MessageV2.WithParts[]
    out: MessageV2.WithParts
    state: Record<string, unknown>
  },
) {
  const models = hitModels(data.hits)
  expect(models.length).toBeGreaterThan(0)
  if (replay.command === "provider-eval") {
    expect(models).toContain("gpt-5.4-mini")
    expect(models).toContain("openai/gpt-5.4-mini")
  } else {
    expect(models.every((item) => item === replay.models[0])).toBe(true)
  }

  if (replay.mode === "primary") {
    const text = userText(data.msgs) ?? ""
    for (const item of replay.prompt) expect(text).toContain(item)
    expect(text).toContain(replay.args)
    expect(data.out.parts.some((item) => item.type === "text" && item.text.includes(replay.result))).toBe(true)
    return
  }

  const task = userTask(data.msgs)
  expect(task?.agent).toBe(replay.agent)
  for (const item of replay.prompt) expect(task?.prompt ?? "").toContain(item)
  for (const item of replay.guard ?? []) expect(task?.prompt ?? "").toContain(item)

  const msg = toolMsg(data.msgs, replay.agent)
  expect(msg?.info.role).toBe("assistant")
  const part = msg?.parts.find((item): item is MessageV2.ToolPart => item.type === "tool")
  expect(part?.state.status).toBe("completed")
  if (!part || part.state.status !== "completed") return
  expect(part.state.output).toContain("<task_result>")
  expect(part.state.output).toContain(replay.result)
  expect(part.state.input.command).toBe(replay.command)

  if (replay.command === "provider-eval") {
    expect(part.state.metadata?.model).toEqual({
      providerID: "openrouter",
      modelID: "openai/gpt-5.4-mini",
    })
  }
}

export async function clean() {
  await Instance.disposeAll()
  await Config.invalidate(true)
}
