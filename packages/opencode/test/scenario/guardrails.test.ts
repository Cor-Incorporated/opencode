import { afterEach, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Agent } from "../../src/agent/agent"
import { Command } from "../../src/command"
import { Config } from "../../src/config/config"
import { Env } from "../../src/env"
import { Permission } from "../../src/permission"
import { Plugin } from "../../src/plugin"
import { Instance } from "../../src/project/instance"
import { Provider } from "../../src/provider/provider"
import { ProviderID } from "../../src/provider/schema"
import { Skill } from "../../src/skill"
import { Filesystem } from "../../src/util/filesystem"
import { tmpdir } from "../fixture/fixture"

const managed = process.env.OPENCODE_TEST_MANAGED_CONFIG_DIR!
const profile = path.resolve(import.meta.dir, "../../../guardrails/profile")

afterEach(async () => {
  await Instance.disposeAll()
  await fs.rm(managed, { force: true, recursive: true }).catch(() => {})
  await Config.invalidate(true)
})

async function write(dir: string, file: string, data: object) {
  await Filesystem.write(path.join(dir, file), JSON.stringify(data, null, 2))
}

async function managedConfig(data: object) {
  await fs.mkdir(managed, { recursive: true })
  await write(managed, "opencode.json", data)
}

async function withProfile<T>(fn: () => Promise<T>) {
  const prev = process.env.OPENCODE_CONFIG_DIR
  process.env.OPENCODE_CONFIG_DIR = profile
  try {
    return await fn()
  } finally {
    if (prev === undefined) delete process.env.OPENCODE_CONFIG_DIR
    else process.env.OPENCODE_CONFIG_DIR = prev
  }
}

function guard(dir: string) {
  const root = path.join(dir, ".opencode", "guardrails")
  return {
    root,
    log: path.join(root, "events.jsonl"),
    state: path.join(root, "state.json"),
  }
}

function wait(ms = 50) {
  return new Promise((done) => setTimeout(done, ms))
}

function perm(agent: Agent.Info | undefined, key: string, pattern = "*") {
  if (!agent) return undefined
  return Permission.evaluate(key, pattern, agent.permission).action
}

test("managed config overrides weaker project defaults", async () => {
  await using tmp = await tmpdir({
    git: true,
    init: async (dir) => {
      await write(dir, "opencode.json", {
        $schema: "https://opencode.ai/config.json",
        share: "auto",
        server: {
          hostname: "0.0.0.0",
          mdns: true,
        },
      })
    },
  })

  await managedConfig({
    $schema: "https://opencode.ai/config.json",
    share: "disabled",
    server: {
      hostname: "127.0.0.1",
      mdns: false,
    },
  })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const cfg = await Config.get()
      expect(cfg.share).toBe("disabled")
      expect(cfg.server?.hostname).toBe("127.0.0.1")
      expect(cfg.server?.mdns).toBe(false)
    },
  })
})

test("guardrails package pins the runtime to the packaged opencode version", async () => {
  const guardrails = await Bun.file(path.resolve(import.meta.dir, "../../../guardrails/package.json")).json()
  const opencode = await Bun.file(path.resolve(import.meta.dir, "../../package.json")).json()

  expect(guardrails.dependencies.opencode).toBe(opencode.version)
})

test("claude-compatible skills remain discoverable and command-addressable", async () => {
  await using tmp = await tmpdir({
    git: true,
    init: async (dir) => {
      await Bun.write(
        path.join(dir, ".claude", "skills", "review-loop", "SKILL.md"),
        `---
name: review-loop
description: Review loop from Claude-compatible assets.
---

# Review Loop
`,
      )
      await Bun.write(
        path.join(dir, ".opencode", "skills", "ship-gate", "SKILL.md"),
        `---
name: ship-gate
description: Internal ship gate skill.
---

# Ship Gate
`,
      )
    },
  })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const skills = await Skill.all()
      const cmds = await Command.list()

      expect(skills.map((item) => item.name).sort()).toEqual(["review-loop", "ship-gate"])
      expect(cmds.some((item) => item.name === "review-loop" && item.source === "skill")).toBe(true)
      expect(cmds.some((item) => item.name === "ship-gate" && item.source === "skill")).toBe(true)
    },
  })
})

test("guardrail profile keeps defaults while allowing project-local commands, agents, and skills", async () => {
  await withProfile(async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        await write(dir, "opencode.json", {
          $schema: "https://opencode.ai/config.json",
          share: "auto",
        })
        await Bun.write(
          path.join(dir, ".opencode", "commands", "project-local.md"),
          `---
description: Project-local workflow.
---

Use the project-local command.
`,
        )
        await Bun.write(
          path.join(dir, ".opencode", "agents", "project-review.md"),
          `---
description: Project-local review helper.
mode: subagent
permission:
  "*": deny
  read: allow
---

Review local project context only.
`,
        )
        await Bun.write(
          path.join(dir, ".opencode", "skills", "project-skill", "SKILL.md"),
          `---
name: project-skill
description: Project-local skill.
---

# Project Skill
`,
        )
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const cfg = await Config.get()
        const cmds = await Command.list()
        const skills = await Skill.all()
        const agents = await Agent.list()

        expect(cfg.share).toBe("disabled")
        expect(cfg.server?.hostname).toBe("127.0.0.1")
        expect(cfg.server?.mdns).toBe(false)
        expect(cmds.some((item) => item.name === "project-local")).toBe(true)
        expect(skills.some((item) => item.name === "project-skill")).toBe(true)
        expect(agents.some((item) => item.name === "project-review")).toBe(true)
      },
    })
  })
})

test("guardrail profile ships safe agents and workflow commands", async () => {
  await withProfile(async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        await write(dir, "opencode.json", {
          $schema: "https://opencode.ai/config.json",
          share: "auto",
        })
        await Bun.write(
          path.join(dir, ".opencode", "commands", "project-local.md"),
          `---
description: Project-local workflow.
---

Use the project-local command.
`,
        )
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const cfg = await Config.get()
        const cmds = await Command.list()
        const impl = await Agent.get("implement")
        const review = await Agent.get("review")

        expect(cfg.default_agent).toBe("implement")
        expect(await Agent.defaultAgent()).toBe("implement")
        expect(impl?.mode).toBe("primary")
        expect(review?.mode).toBe("subagent")
        expect(perm(impl, "question")).toBe("allow")
        expect(perm(impl, "plan_enter")).toBe("allow")
        expect(perm(impl, "edit")).toBe("ask")
        expect(perm(impl, "bash", "git reset --hard HEAD")).toBe("deny")
        expect(perm(impl, "bash", "git push origin --force-with-lease")).toBe("deny")
        expect(perm(review, "edit")).toBe("deny")
        expect(perm(review, "read")).toBe("allow")
        expect(perm(review, "bash", "git diff HEAD")).toBe("allow")
        expect(perm(review, "bash", "bun test")).toBe("deny")

        const map = Object.fromEntries(cmds.map((item) => [item.name, item]))
        expect(map.implement?.agent).toBe("implement")
        expect(map.review?.agent).toBe("review")
        expect(map.review?.subtask).toBe(true)
        expect(map.ship?.agent).toBe("review")
        expect(map.ship?.subtask).toBe(true)
        expect(map.handoff?.agent).toBe("review")
        expect(map.handoff?.subtask).toBe(true)
        expect(map["project-local"]?.name).toBe("project-local")
      },
    })
  })
})

test("guardrail profile enforces provider admission lanes", async () => {
  await withProfile(async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        await write(dir, "opencode.json", {
          $schema: "https://opencode.ai/config.json",
          share: "auto",
        })
      },
    })

    await Instance.provide({
      directory: tmp.path,
      init: async () => {
        Env.set("ZHIPU_API_KEY", "test-zai-key")
        Env.set("OPENAI_API_KEY", "test-openai-key")
        Env.set("OPENROUTER_API_KEY", "test-openrouter-key")
      },
      fn: async () => {
        const cfg = await Config.get()
        const providers = await Provider.list()
        const cmds = await Command.list()
        const evalAgent = await Agent.get("provider-eval")
        const openrouter = providers[ProviderID.openrouter]
        const zai = providers[ProviderID.make("zai")]
        const openai = providers[ProviderID.openai]

        expect(cfg.enabled_providers).toEqual(["zai", "openai", "openrouter"])
        expect(zai).toBeDefined()
        expect(openai).toBeDefined()
        expect(openrouter).toBeDefined()
        expect(Object.keys(zai.models).sort()).toEqual(["glm-4.5", "glm-4.5-air", "glm-5"])
        expect(Object.keys(openai.models).sort()).toEqual(["gpt-4.1", "gpt-5", "gpt-5-mini", "gpt-5-nano"])
        expect(Object.keys(openrouter.models).sort()).toEqual([
          "anthropic/claude-sonnet-4.5",
          "google/gemini-2.5-pro",
          "openai/gpt-5",
          "openai/gpt-5-mini",
        ])
        expect(evalAgent?.mode).toBe("subagent")
        expect(cmds.some((item) => item.name === "provider-eval" && item.agent === "provider-eval")).toBe(true)

        const evalModel = openrouter.models["openai/gpt-5-mini"]

        await expect(
          Plugin.trigger(
            "chat.params",
            {
              sessionID: "session_test",
              agent: "implement",
              model: evalModel,
            },
            { temperature: undefined, topP: undefined, topK: undefined, options: {} },
          ),
        ).rejects.toThrow("evaluation-only")

        await expect(
          Plugin.trigger(
            "chat.params",
            {
              sessionID: "session_test",
              agent: "provider-eval",
              model: openai.models["gpt-5-mini"],
            },
            { temperature: undefined, topP: undefined, topK: undefined, options: {} },
          ),
        ).rejects.toThrow("reserved for evaluation-lane providers")

        await expect(
          Plugin.trigger(
            "chat.params",
            {
              sessionID: "session_test",
              agent: "provider-eval",
              model: {
                ...evalModel,
                id: "deepseek/deepseek-r1:free" as typeof evalModel.id,
                cost: {
                  ...evalModel.cost,
                  input: 0,
                  output: 0,
                  cache: {
                    read: 0,
                    write: 0,
                  },
                },
              },
            },
            { temperature: undefined, topP: undefined, topK: undefined, options: {} },
          ),
        ).rejects.toThrow("not admitted")

        await expect(
          Plugin.trigger(
            "chat.params",
            {
              sessionID: "session_test",
              agent: "provider-eval",
              model: evalModel,
            },
            { temperature: undefined, topP: undefined, topK: undefined, options: {} },
          ),
        ).resolves.toEqual({ temperature: undefined, topP: undefined, topK: undefined, options: {} })
      },
    })
  })
})

test("guardrail profile plugin injects shell env and blocks protected files", async () => {
  await withProfile(async () => {
    await using tmp = await tmpdir({ git: true })
    const files = guard(tmp.path)

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const cfg = await Config.get()
        const env = await Plugin.trigger(
          "shell.env",
          { cwd: tmp.path, sessionID: "session_test", callID: "call_test" },
          { env: {} },
        )
        const vars = env.env as Record<string, string>

        expect(cfg.plugin_origins?.some((item) => String(Array.isArray(item.spec) ? item.spec[0] : item.spec).includes("/plugins/guardrail.ts"))).toBe(true)
        expect(vars.OPENCODE_GUARDRAIL_MODE).toBe("enforced")
        expect(vars.OPENCODE_GUARDRAIL_ROOT).toBe(files.root)
        expect(vars.OPENCODE_GUARDRAIL_STATE).toBe(files.state)

        await expect(
          Plugin.trigger(
            "tool.execute.before",
            { tool: "read", sessionID: "session_test", callID: "call_test" },
            { args: { filePath: path.join(tmp.path, ".env") } },
          ),
        ).rejects.toThrow("secret material")

        await expect(
          Plugin.trigger(
            "tool.execute.before",
            { tool: "write", sessionID: "session_test", callID: "call_test" },
            { args: { filePath: path.join(tmp.path, "eslint.config.js"), content: "export default []" } },
          ),
        ).rejects.toThrow("policy-protected")
      },
    })
  })
})

test("guardrail profile plugin records lifecycle events and compaction context", async () => {
  await withProfile(async () => {
    await using tmp = await tmpdir({ git: true })
    const files = guard(tmp.path)

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const hook = (await Plugin.list()).find((item) => typeof item.event === "function")
        expect(hook?.event).toBeDefined()

        await hook?.event?.({
          event: {
            type: "session.created",
            properties: {
              sessionID: "session_test",
            },
          },
        } as any)
        await hook?.event?.({
          event: {
            type: "permission.asked",
            properties: {
              sessionID: "session_test",
              permission: "bash",
              patterns: ["cat .env"],
            },
          },
        } as any)
        await hook?.event?.({
          event: {
            type: "session.idle",
            properties: {
              sessionID: "session_test",
            },
          },
        } as any)
        await wait()

        const log = await Bun.file(files.log).text()
        const state = await Bun.file(files.state).json()
        const compact = await Plugin.trigger(
          "experimental.session.compacting",
          { sessionID: "session_test" },
          { context: [], prompt: undefined },
        )

        expect(log).toContain("\"type\":\"session.created\"")
        expect(log).toContain("\"type\":\"permission.asked\"")
        expect(log).toContain("\"type\":\"session.idle\"")
        expect(state.last_session).toBe("session_test")
        expect(state.last_permission).toBe("bash")
        expect(compact.context.join("\n")).toContain("Guardrail mode: enforced.")
        expect(compact.context.join("\n")).toContain(".opencode/guardrails/state.json")
      },
    })
  })
})
