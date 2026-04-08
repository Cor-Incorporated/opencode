import { afterEach, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Effect } from "effect"
import { Agent } from "../../src/agent/agent"
import { Auth } from "../../src/auth"
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
import { assertReplay, it, run } from "./harness"
import { replays } from "./replay"

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

test("guardrails package depends on opencode workspace package", async () => {
  const guardrails = await Bun.file(path.resolve(import.meta.dir, "../../../guardrails/package.json")).json()

  expect(guardrails.dependencies.opencode).toBe("workspace:*")
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
        expect(map.ship?.agent).toBe("ship")
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
        const plan = providers[ProviderID.make("zai-coding-plan")]
        const openai = providers[ProviderID.openai]
        const zaiModels = Object.keys(zai.models).sort()
        const planModels = Object.keys(plan.models).sort()
        const openaiModels = Object.keys(openai.models).sort()

        expect(cfg.enabled_providers).toEqual(["zai", "zai-coding-plan", "openai", "openrouter"])
        expect(zai).toBeDefined()
        expect(plan).toBeDefined()
        expect(openai).toBeDefined()
        expect(openrouter).toBeDefined()
        expect(zaiModels).toEqual(["glm-4.5", "glm-4.5-air", "glm-5"])
        for (const item of [
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
        ]) {
          expect(planModels).toContain(item)
        }
        expect(openaiModels).toEqual(
          expect.arrayContaining([
            "gpt-4.1",
            "gpt-5",
            "gpt-5-mini",
            "gpt-5-nano",
            "gpt-5.1-codex",
            "gpt-5.1-codex-max",
            "gpt-5.1-codex-mini",
            "gpt-5.2",
            "gpt-5.2-codex",
            "gpt-5.3-codex",
            "gpt-5.4",
          ]),
        )
        expect(Object.keys(openrouter.models).sort()).toEqual([
          "anthropic/claude-haiku-4.5",
          "anthropic/claude-opus-4.5",
          "anthropic/claude-opus-4.6",
          "anthropic/claude-sonnet-4.5",
          "anthropic/claude-sonnet-4.6",
          "google/gemini-2.5-flash",
          "google/gemini-2.5-pro",
          "minimax/minimax-m2.1",
          "minimax/minimax-m2.5",
          "moonshotai/kimi-k2.5",
          "openai/gpt-5.2",
          "openai/gpt-5.2-codex",
          "openai/gpt-5.3-codex",
          "openai/gpt-5.4",
          "openai/gpt-5.4-mini",
          "qwen/qwen3-coder",
        ])
        expect(plan.models["glm-5.1"]?.api.id).toBe("glm-5.1")
        expect(plan.models["glm-5.1"]?.api.url).toBe("https://api.z.ai/api/coding/paas/v4")
        expect(evalAgent?.mode).toBe("subagent")
        expect(cmds.some((item) => item.name === "provider-eval" && item.agent === "provider-eval")).toBe(true)

        await expect(
          Plugin.trigger(
            "chat.params",
            {
              sessionID: "session_test",
              agent: "implement",
              model: plan.models["glm-5.1"],
            },
            { temperature: undefined, topP: undefined, topK: undefined, options: {} },
          ),
        ).resolves.toEqual({ temperature: undefined, topP: undefined, topK: undefined, options: {} })

        const evalModel = openrouter.models["openai/gpt-5.4-mini"]

        // With evals set empty, openrouter is NOT evaluation-only, so implement can use it
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
        ).resolves.toEqual({ temperature: undefined, topP: undefined, topK: undefined, options: {} })

        // With evals set empty, provider-eval is open to any provider
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
        ).resolves.toEqual({ temperature: undefined, topP: undefined, topK: undefined, options: {} })

        // Whitelist-based admission still blocks unadmitted models on openrouter
        await expect(
          Plugin.trigger(
            "chat.params",
            {
              sessionID: "session_test",
              agent: "provider-eval",
              model: {
                ...evalModel,
                  id: "google/gemini-3-pro-preview" as typeof evalModel.id,
                  cost: {
                    ...evalModel.cost,
                    input: 0.1,
                    output: 0.2,
                    cache: { read: 0, write: 0 },
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
}, 15000)

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

test("guardrail profile keeps OpenAI OAuth Codex models visible", async () => {
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
        await Auth.set(
          "openai",
          new Auth.Oauth({
            type: "oauth",
            access: "test-openai-access",
            refresh: "test-openai-refresh",
            expires: Date.now() + 60_000,
          }),
        )
      },
      fn: async () => {
        const providers = await Provider.list()
        const openai = providers[ProviderID.openai]
        const models = Object.keys(openai.models).sort()

        expect(openai).toBeDefined()
        expect(models).toEqual(
          expect.arrayContaining([
            "gpt-5.1-codex",
            "gpt-5.1-codex-max",
            "gpt-5.1-codex-mini",
            "gpt-5.2",
            "gpt-5.2-codex",
            "gpt-5.3-codex",
            "gpt-5.4",
          ]),
        )
        expect(openai.models["gpt-5.4"]?.cost.input).toBe(0)
        await expect(
          Plugin.trigger(
            "chat.params",
            {
              sessionID: "session_test",
              agent: "implement",
              model: openai.models["gpt-5.4"],
            },
            { temperature: undefined, topP: undefined, topK: undefined, options: {} },
          ),
        ).resolves.toEqual({ temperature: undefined, topP: undefined, topK: undefined, options: {} })
      },
    })
  })
})

test("guardrail profile plugin enforces version baselines and context budget", async () => {
  await withProfile(async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        await fs.mkdir(path.join(dir, "src"), { recursive: true })
        await Bun.write(path.join(dir, "package.json"), JSON.stringify({ version: "1.2.3" }, null, 2))
        await Bun.write(path.join(dir, "Dockerfile"), "FROM app:latest\n")
        await Bun.write(path.join(dir, "src", "a.ts"), "export const a = 1\n")
        await Bun.write(path.join(dir, "src", "b.ts"), "export const b = 1\n")
        await Bun.write(path.join(dir, "src", "c.ts"), "export const c = 1\n")
        await Bun.write(path.join(dir, "src", "d.ts"), "export const d = 1\n")
        await Bun.write(path.join(dir, "src", "e.ts"), "export const e = 1\n")
      },
    })
    const files = guard(tmp.path)

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const hook = (await Plugin.list()).find((item) => typeof item.event === "function")
        await hook?.event?.({
          event: {
            type: "session.created",
            properties: {
              sessionID: "session_test",
            },
          },
        } as any)

        await expect(
          Plugin.trigger(
            "tool.execute.before",
            { tool: "edit", sessionID: "session_test", callID: "call_ver" },
            {
              args: {
                filePath: path.join(tmp.path, "package.json"),
                oldString: `"version": "1.2.3"`,
                newString: `"version": "1.1.9"`,
              },
            },
          ),
        ).rejects.toThrow("version baseline regression")

        await expect(
          Plugin.trigger(
            "tool.execute.before",
            { tool: "edit", sessionID: "session_test", callID: "call_latest" },
            {
              args: {
                filePath: path.join(tmp.path, "Dockerfile"),
                oldString: "FROM app:latest",
                newString: "FROM app:v1.2.3",
              },
            },
          ),
        ).rejects.toThrow("ADR-backed compatibility verification")

        for (const file of ["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts"]) {
          await Plugin.trigger(
            "tool.execute.after",
            { tool: "read", sessionID: "session_test", callID: file, args: { filePath: path.join(tmp.path, file) } },
            { title: "read", output: "", metadata: {} },
          )
        }

        const state = await Bun.file(files.state).json()
        expect(state.read_count).toBe(4)
        expect(state.read_files).toEqual(["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts"])

        await expect(
          Plugin.trigger(
            "tool.execute.before",
            { tool: "edit", sessionID: "session_test", callID: "call_budget" },
            {
              args: {
                filePath: path.join(tmp.path, "src", "e.ts"),
                oldString: "export const e = 1",
                newString: "export const e = 2",
              },
            },
          ),
        ).rejects.toThrow("context budget exceeded")
      },
    })
  })
})

test("guardrail profile plugin records factcheck and review freshness state", async () => {
  await withProfile(async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        await fs.mkdir(path.join(dir, "docs"), { recursive: true })
        await fs.mkdir(path.join(dir, "src"), { recursive: true })
        await Bun.write(path.join(dir, "docs", "plan.md"), "# plan\n")
        await Bun.write(path.join(dir, "src", "flow.ts"), "export const flow = 1\n")
      },
    })
    const files = guard(tmp.path)

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const hook = (await Plugin.list()).find((item) => typeof item.event === "function")
        await hook?.event?.({
          event: {
            type: "session.created",
            properties: {
              sessionID: "session_test",
            },
          },
        } as any)

        await Plugin.trigger(
          "tool.execute.after",
          {
            tool: "read",
            sessionID: "session_test",
            callID: "call_doc",
            args: { filePath: path.join(tmp.path, "docs", "plan.md") },
          },
          { title: "read", output: "", metadata: {} },
        )
        await Plugin.trigger(
          "tool.execute.after",
          {
            tool: "write",
            sessionID: "session_test",
            callID: "call_write",
            args: { filePath: path.join(tmp.path, "src", "flow.ts"), content: "export const flow = 2\n" },
          },
          { title: "write", output: "", metadata: {} },
        )
        await Plugin.trigger(
          "tool.execute.after",
          {
            tool: "task",
            sessionID: "session_test",
            callID: "call_review",
            args: {
              command: "review",
              subagent_type: "review",
            },
          },
          { title: "review", output: "", metadata: {} },
        )
        await Plugin.trigger(
          "tool.execute.after",
          {
            tool: "edit",
            sessionID: "session_test",
            callID: "call_edit",
            args: {
              filePath: path.join(tmp.path, "src", "flow.ts"),
              oldString: "export const flow = 2",
              newString: "export const flow = 3",
            },
          },
          { title: "edit", output: "", metadata: {} },
        )

        const state = await Bun.file(files.state).json()
        const compact = await Plugin.trigger(
          "experimental.session.compacting",
          { sessionID: "session_test" },
          { context: [], prompt: undefined },
        )

        expect(state.factchecked).toBe(true)
        expect(state.factcheck_source).toBe("DocRead")
        expect(state.edit_count).toBe(2)
        expect(state.edit_count_since_check).toBe(2)
        expect(state.reviewed).toBe(true)
        expect(state.edits_since_review).toBe(1)
        expect(compact.context.join("\n")).toContain("Fact-check state: stale after 2 edit(s)")
        expect(compact.context.join("\n")).toContain("Review state: stale after 1 edit(s)")
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
        expect(state.read_count).toBe(0)
        expect(state.factchecked).toBe(false)
        expect(state.reviewed).toBe(false)
        expect(state.last_permission).toBe("bash")
        expect(compact.context.join("\n")).toContain("Guardrail mode: enforced.")
        expect(compact.context.join("\n")).toContain(".opencode/guardrails/state.json")
      },
    })
  })
})

test("team plugin allows fd-only bash redirection while still blocking file redirects", async () => {
  await withProfile(async () => {
    await using tmp = await tmpdir({ git: true })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const text =
          "Implement the following multi-file refactoring across packages/a, packages/b, and packages/c:\n" +
          "- 1. Extract shared types into a common module\n" +
          "- 2. Update all imports across the three packages\n" +
          "- 3. Add barrel exports for the new module\n" +
          "- 4. Fix downstream consumers\n" +
          "This is a large plan that touches multiple packages."

        const parts: { id?: string; sessionID?: string; messageID?: string; type?: string; text?: string }[] = [
          { type: "text", text },
        ]

        await Plugin.trigger(
          "chat.message",
          {
            sessionID: "session_team_bash",
            agent: "implement",
          },
          {
            message: {
              id: "msg_team_bash",
              sessionID: "session_team_bash",
              role: "user",
            },
            parts,
          },
        )

        await expect(
          Plugin.trigger(
            "tool.execute.before",
            { tool: "bash", sessionID: "session_team_bash", callID: "call_team_fd" },
            {
              args: {
                command: "gcloud secrets list --format=json 2>&1",
              },
            },
          ),
        ).resolves.toEqual({
          args: {
            command: "gcloud secrets list --format=json 2>&1",
          },
        })

        await expect(
          Plugin.trigger(
            "tool.execute.before",
            { tool: "bash", sessionID: "session_team_bash", callID: "call_team_file" },
            {
              args: {
                command: "echo test > output.txt",
              },
            },
          ),
        ).rejects.toThrow("Call the team tool before mutating the worktree")
      },
    })
  })
})

test("team plugin skips parallel enforcement on HEAD-less repos", async () => {
  await withProfile(async () => {
    await using tmp = await tmpdir({
      git: false,
      init: async (dir) => {
        const $ = Bun.$
        await $`git init`.cwd(dir).quiet()
        await $`git config core.fsmonitor false`.cwd(dir).quiet()
        await $`git config user.email "test@opencode.test"`.cwd(dir).quiet()
        await $`git config user.name "Test"`.cwd(dir).quiet()
        // Intentionally NO initial commit — HEAD does not exist
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const bigRequest =
          "Implement the following multi-file refactoring across packages/a, packages/b, and packages/c:\n" +
          "- 1. Extract shared types into a common module\n" +
          "- 2. Update all imports across the three packages\n" +
          "- 3. Add barrel exports for the new module\n" +
          "- 4. Fix downstream consumers\n" +
          "This is a large plan that touches multiple packages."

        const parts: { id?: string; sessionID?: string; messageID?: string; type?: string; text?: string }[] = [
          { type: "text", text: bigRequest },
        ]

        await Plugin.trigger(
          "chat.message",
          {
            sessionID: "session_headless",
            agent: "implement",
          },
          {
            message: {
              id: "msg_headless",
              sessionID: "session_headless",
              role: "user",
            },
            parts,
          },
        )

        const injected = parts.find(
          (item) => item.type === "text" && typeof item.text === "string" && item.text.includes("Bootstrap mode"),
        )
        expect(injected).toBeDefined()
        expect(injected!.text).toContain("Parallel implementation policy is suspended")

        const parallelInjected = parts.find(
          (item) => item.type === "text" && typeof item.text === "string" && item.text.includes("Parallel implementation policy is active"),
        )
        expect(parallelInjected).toBeUndefined()

        // Mutations should NOT be blocked — no need gate was set
        await expect(
          Plugin.trigger(
            "tool.execute.before",
            { tool: "edit", sessionID: "session_headless", callID: "call_headless_edit" },
            {
              args: {
                filePath: path.join(tmp.path, "src", "index.ts"),
                oldString: "const a = 1",
                newString: "const a = 2",
              },
            },
          ),
        ).resolves.toBeDefined()
      },
    })
  })
})

test("guardrail delegation gates and quality hooks fire correctly", async () => {
  await withProfile(async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        await fs.mkdir(path.join(dir, "src", "ui"), { recursive: true })
        await fs.mkdir(path.join(dir, "src", "api"), { recursive: true })
        await Bun.write(path.join(dir, "src", "app.ts"), "export const main = 1\n")
      },
    })
    const files = guard(tmp.path)

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        // Initialize session to set up state
        const hook = (await Plugin.list()).find((item) => typeof item.event === "function")
        await hook?.event?.({
          event: {
            type: "session.created",
            properties: { sessionID: "session_delegation_test" },
          },
        } as any)
        await wait()

        // 1. Verify delegation state fields are initialized
        let state = await Bun.file(files.state).json()
        expect(state.active_task_count).toBe(0)
        expect(state.llm_call_count).toBe(0)
        expect(state.consecutive_failures).toBe(0)
        expect(state.consecutive_fix_prs).toBe(0)
        expect(state.issue_verification_done).toBe(false)
        expect(state.edits_since_doc_reminder).toBe(0)

        // 2. Parallel execution gate: task tool increments active count
        await Plugin.trigger(
          "tool.execute.before",
          { tool: "task", sessionID: "session_delegation_test", callID: "call_task_1" },
          { args: { subagent_type: "explore", prompt: "test" } },
        )
        state = await Bun.file(files.state).json()
        expect(state.active_task_count).toBe(1)

        // 3. Task completion decrements active count and tracks delegation
        await Plugin.trigger(
          "tool.execute.after",
          { tool: "task", sessionID: "session_delegation_test", callID: "call_task_1", args: { subagent_type: "explore", command: "" } },
          { title: "task", output: "Result text here with enough content to pass", metadata: {} },
        )
        state = await Bun.file(files.state).json()
        expect(state.active_task_count).toBe(0)
        expect(state.delegation_explore).toBe(1)

        // 4. Verify agent output check: short output triggers advisory
        const shortOut = { title: "task", output: "", metadata: {} }
        await Plugin.trigger(
          "tool.execute.after",
          { tool: "task", sessionID: "session_delegation_test", callID: "call_task_2", args: { subagent_type: "review", command: "" } },
          shortOut,
        )
        expect(shortOut.output).toContain("Agent output appears empty")

        // 5. Parallel execution gate: block at max
        for (let i = 0; i < 5; i++) {
          await Plugin.trigger(
            "tool.execute.before",
            { tool: "task", sessionID: "session_delegation_test", callID: `call_flood_${i}` },
            { args: { subagent_type: "explore", prompt: "test" } },
          )
        }
        state = await Bun.file(files.state).json()
        expect(state.active_task_count).toBe(5)
        await expect(
          Plugin.trigger(
            "tool.execute.before",
            { tool: "task", sessionID: "session_delegation_test", callID: "call_flood_6" },
            { args: { subagent_type: "explore", prompt: "test" } },
          ),
        ).rejects.toThrow("parallel task limit reached")

        // 6. Domain naming advisory: write to src/ui/ with non-PascalCase triggers event
        await Plugin.trigger(
          "tool.execute.before",
          { tool: "write", sessionID: "session_delegation_test", callID: "call_domain" },
          { args: { filePath: path.join(tmp.path, "src", "ui", "bad_name.tsx"), content: "export default function Bad() {}" } },
        )
        const log = await Bun.file(files.log).text()
        expect(log).toContain("domain_naming.mismatch")

        // 7. Endpoint dataflow advisory on API file edit
        const endpointOut = { title: "edit", output: "", metadata: {} }
        await Plugin.trigger(
          "tool.execute.after",
          { tool: "edit", sessionID: "session_delegation_test", callID: "call_endpoint", args: { filePath: path.join(tmp.path, "src", "api", "users.ts"), newString: "router.get('/users', handler)" } },
          endpointOut,
        )
        expect(endpointOut.output).toContain("Endpoint modification detected")

        // 8. Tool failure recovery: consecutive failures (uses exit code, not regex)
        for (let i = 0; i < 3; i++) {
          await Plugin.trigger(
            "tool.execute.after",
            { tool: "bash", sessionID: "session_delegation_test", callID: `call_fail_${i}`, args: { command: "npm build" } },
            { title: "bash", output: "build output", metadata: { exitCode: 1 } },
          )
        }
        state = await Bun.file(files.state).json()
        expect(state.consecutive_failures).toBe(3)

        // 9. Compaction context includes new delegation fields
        const compact = await Plugin.trigger(
          "experimental.session.compacting",
          { sessionID: "session_delegation_test" },
          { context: [], prompt: undefined },
        )
        const ctx = compact.context.join("\n")
        expect(ctx).toContain("Active tasks:")
        expect(ctx).toContain("LLM calls:")
        expect(ctx).toContain("Consecutive failures: 3")
      },
    })
  })
}, 15000)

test("guardrail plugin loads from profile config and fires session.created", async () => {
  await withProfile(async () => {
    await using tmp = await tmpdir({ git: true })
    const files = guard(tmp.path)

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        // 1. Verify plugin is loaded from config
        const plugins = await Plugin.list()
        const guardrailPlugin = plugins.find(
          (item) => typeof item.event === "function" && typeof item["tool.execute.before"] === "function",
        )
        expect(guardrailPlugin).toBeDefined()

        // 2. Verify config includes plugin field
        const cfg = await Config.get()
        expect(cfg.plugin).toBeDefined()
        expect(cfg.plugin!.some((p: unknown) => typeof p === "string" && String(p).includes("guardrail"))).toBe(true)

        // 3. Fire session.created and verify state file is written
        await guardrailPlugin!.event!({
          event: {
            type: "session.created",
            properties: { sessionID: "session_config_load_test" },
          },
        } as any)
        await wait()

        const state = await Bun.file(files.state).json()
        expect(state.mode).toBe("enforced")
        expect(state.active_tasks).toEqual({})
        expect(state.active_task_count).toBe(0)
        expect(state.llm_call_count).toBe(0)
        expect(state.llm_calls_by_provider).toEqual({})
        expect(state.session_providers).toEqual([])
        expect(state.consecutive_failures).toBe(0)
        expect(state.issue_verification_done).toBe(false)

        // 4. Verify events.jsonl was written
        const logText = await Bun.file(files.log).text()
        expect(logText).toContain("session.created")
        expect(logText).toContain("session_config_load_test")

        // 5. Fire tool.execute.before for secret file — verify hard block
        await expect(
          Plugin.trigger(
            "tool.execute.before",
            { tool: "read", sessionID: "session_config_load_test", callID: "call_secret" },
            { args: { filePath: path.join(tmp.path, ".env.production") } },
          ),
        ).rejects.toThrow("secret material")

        // 6. Fire tool.execute.after for bash — verify state tracking
        await Plugin.trigger(
          "tool.execute.after",
          { tool: "bash", sessionID: "session_config_load_test", callID: "call_test", args: { command: "bun test" } },
          { title: "bash", output: "19 pass", metadata: { exitCode: 0 } },
        )
        const updatedState = await Bun.file(files.state).json()
        expect(updatedState.tests_executed).toBe(true)

        // 7. Verify shell.env hook exposes guardrail env vars
        const envOut = { env: {} as Record<string, string> }
        await guardrailPlugin!["shell.env"]!({ cwd: tmp.path } as any, envOut as any)
        expect(envOut.env.OPENCODE_GUARDRAIL_MODE).toBe("enforced")
        expect(envOut.env.OPENCODE_GUARDRAIL_ROOT).toBeDefined()
        expect(envOut.env.OPENCODE_GUARDRAIL_STATE).toBeDefined()
      },
    })
  })
}, 15000)

test("merge gate regex does not block git merge-base or read-only merge commands", async () => {
  await withProfile(async () => {
    await using tmp = await tmpdir({ git: true })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const hook = (await Plugin.list()).find((item) => typeof item.event === "function")
        await hook?.event?.({
          event: {
            type: "session.created",
            properties: { sessionID: "session_merge_regex" },
          },
        } as any)

        // git merge-base should NOT be blocked (read-only)
        await expect(
          Plugin.trigger(
            "tool.execute.before",
            { tool: "bash", sessionID: "session_merge_regex", callID: "call_merge_base" },
            { args: { command: "git merge-base main HEAD" } },
          ),
        ).resolves.toBeDefined()

        // git merge (actual merge) should be blocked when review not done
        await expect(
          Plugin.trigger(
            "tool.execute.before",
            { tool: "bash", sessionID: "session_merge_regex", callID: "call_merge" },
            { args: { command: "git merge develop" } },
          ),
        ).rejects.toThrow("blocked")
      },
    })
  })
})

test("review_state resets on apply_patch and mutating bash", async () => {
  await withProfile(async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        await fs.mkdir(path.join(dir, "src"), { recursive: true })
        await Bun.write(path.join(dir, "src", "app.ts"), "export const app = 1\n")
      },
    })
    const files = guard(tmp.path)

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const hook = (await Plugin.list()).find((item) => typeof item.event === "function")
        await hook?.event?.({
          event: {
            type: "session.created",
            properties: { sessionID: "session_review_reset" },
          },
        } as any)

        // Set review to done via task
        await Plugin.trigger(
          "tool.execute.after",
          { tool: "task", sessionID: "session_review_reset", callID: "call_review_set", args: { command: "review", subagent_type: "review" } },
          { title: "review", output: "Review done with sufficient output content", metadata: {} },
        )
        let state = await Bun.file(files.state).json()
        expect(state.review_state).toBe("done")

        // apply_patch should reset review_state
        await Plugin.trigger(
          "tool.execute.after",
          { tool: "apply_patch", sessionID: "session_review_reset", callID: "call_apply_patch", args: { filePath: path.join(tmp.path, "src", "app.ts"), content: "patch" } },
          { title: "apply_patch", output: "", metadata: {} },
        )
        state = await Bun.file(files.state).json()
        expect(state.review_state).toBe("")
        expect(state.edits_since_review).toBe(1)

        // Set review back to done
        await Plugin.trigger(
          "tool.execute.after",
          { tool: "task", sessionID: "session_review_reset", callID: "call_review_set2", args: { command: "review", subagent_type: "review" } },
          { title: "review", output: "Review done with sufficient output content", metadata: {} },
        )
        state = await Bun.file(files.state).json()
        expect(state.review_state).toBe("done")

        // mutating bash (sed -i) should reset review_state
        await Plugin.trigger(
          "tool.execute.after",
          { tool: "bash", sessionID: "session_review_reset", callID: "call_sed", args: { command: "sed -i 's/old/new/' src/app.ts" } },
          { title: "bash", output: "", metadata: { exitCode: 0 } },
        )
        state = await Bun.file(files.state).json()
        expect(state.review_state).toBe("")
        expect(state.edits_since_review).toBeGreaterThanOrEqual(1)
      },
    })
  })
})

test("python test file detector matches subdirectory paths", async () => {
  await withProfile(async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        await fs.mkdir(path.join(dir, "tests"), { recursive: true })
        await Bun.write(path.join(dir, "tests", "test_auth.py"), "def test_login(): pass\n")
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const hook = (await Plugin.list()).find((item) => typeof item.event === "function")
        await hook?.event?.({
          event: {
            type: "session.created",
            properties: { sessionID: "session_py_test" },
          },
        } as any)

        const out = { title: "write", output: "", metadata: {} }
        await Plugin.trigger(
          "tool.execute.after",
          { tool: "write", sessionID: "session_py_test", callID: "call_py_test", args: { filePath: path.join(tmp.path, "tests", "test_auth.py"), content: "def test_login(): assert True\n" } },
          out,
        )
        expect(out.output).toContain("Test file modified")
        expect(out.output).toContain("test falsifiability")
      },
    })
  })
})

test("factcheck state machine transitions correctly across sources", async () => {
  await withProfile(async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        await fs.mkdir(path.join(dir, "docs"), { recursive: true })
        await fs.mkdir(path.join(dir, "src"), { recursive: true })
        await Bun.write(path.join(dir, "docs", "arch.md"), "# Arch\n")
        await Bun.write(path.join(dir, "src", "a.ts"), "export const a = 1\n")
        await Bun.write(path.join(dir, "src", "b.ts"), "export const b = 1\n")
      },
    })
    const files = guard(tmp.path)

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const hook = (await Plugin.list()).find((item) => typeof item.event === "function")
        await hook?.event?.({
          event: {
            type: "session.created",
            properties: { sessionID: "session_factcheck" },
          },
        } as any)

        // 1. Initial state: not factchecked
        let state = await Bun.file(files.state).json()
        expect(state.factchecked).toBe(false)

        // 2. DocRead sets factchecked
        await Plugin.trigger(
          "tool.execute.after",
          { tool: "read", sessionID: "session_factcheck", callID: "call_doc", args: { filePath: path.join(tmp.path, "docs", "arch.md") } },
          { title: "read", output: "", metadata: {} },
        )
        state = await Bun.file(files.state).json()
        expect(state.factchecked).toBe(true)
        expect(state.factcheck_source).toBe("DocRead")
        expect(state.edit_count_since_check).toBe(0)

        // 3. Edit increments edit_count_since_check
        await Plugin.trigger(
          "tool.execute.after",
          { tool: "edit", sessionID: "session_factcheck", callID: "call_edit1", args: { filePath: path.join(tmp.path, "src", "a.ts"), oldString: "export const a = 1", newString: "export const a = 2" } },
          { title: "edit", output: "", metadata: {} },
        )
        state = await Bun.file(files.state).json()
        expect(state.factchecked).toBe(true)
        expect(state.edit_count_since_check).toBe(1)

        // 4. WebFetch resets edit_count_since_check
        await Plugin.trigger(
          "tool.execute.after",
          { tool: "webfetch", sessionID: "session_factcheck", callID: "call_web", args: {} },
          { title: "webfetch", output: "", metadata: {} },
        )
        state = await Bun.file(files.state).json()
        expect(state.factchecked).toBe(true)
        expect(state.factcheck_source).toBe("WebFetch")
        expect(state.edit_count_since_check).toBe(0)

        // 5. Multiple edits make factcheck stale
        await Plugin.trigger(
          "tool.execute.after",
          { tool: "edit", sessionID: "session_factcheck", callID: "call_edit2", args: { filePath: path.join(tmp.path, "src", "b.ts"), oldString: "export const b = 1", newString: "export const b = 2" } },
          { title: "edit", output: "", metadata: {} },
        )
        state = await Bun.file(files.state).json()
        expect(state.edit_count_since_check).toBe(1)

        // 6. CLI command (gcloud) also resets factcheck
        await Plugin.trigger(
          "tool.execute.after",
          { tool: "bash", sessionID: "session_factcheck", callID: "call_cli", args: { command: "gcloud compute instances list" } },
          { title: "bash", output: "", metadata: { exitCode: 0 } },
        )
        state = await Bun.file(files.state).json()
        expect(state.factcheck_source).toBe("CLI")
        expect(state.edit_count_since_check).toBe(0)
      },
    })
  })
})

test("bash mutation detection blocks protected config files", async () => {
  await withProfile(async () => {
    await using tmp = await tmpdir({ git: true })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const hook = (await Plugin.list()).find((item) => typeof item.event === "function")
        await hook?.event?.({
          event: {
            type: "session.created",
            properties: { sessionID: "session_bash_mut" },
          },
        } as any)

        // sed -i on eslint config (with path prefix) should be blocked
        await expect(
          Plugin.trigger(
            "tool.execute.before",
            { tool: "bash", sessionID: "session_bash_mut", callID: "call_sed_eslint" },
            { args: { command: "sed -i 's/warn/off/' ./eslint.config.js" } },
          ),
        ).rejects.toThrow("protected runtime or config mutation")

        // sed -i on biome.json (with path prefix) should be blocked
        await expect(
          Plugin.trigger(
            "tool.execute.before",
            { tool: "bash", sessionID: "session_bash_mut", callID: "call_sed_biome" },
            { args: { command: "sed -i 's/warn/off/' ./biome.json" } },
          ),
        ).rejects.toThrow("protected runtime or config mutation")

        // cat (read-only) on eslint config should pass (not mutating)
        await expect(
          Plugin.trigger(
            "tool.execute.before",
            { tool: "bash", sessionID: "session_bash_mut", callID: "call_cat_eslint" },
            { args: { command: "cat eslint.config.js" } },
          ),
        ).resolves.toBeDefined()

        // any shell access to .opencode/guardrails/ should be blocked
        await expect(
          Plugin.trigger(
            "tool.execute.before",
            { tool: "bash", sessionID: "session_bash_mut", callID: "call_guardrail_state" },
            { args: { command: "echo test > .opencode/guardrails/state.json" } },
          ),
        ).rejects.toThrow("shell access to protected files")
      },
    })
  })
})

test("security patterns block secret material across tools", async () => {
  await withProfile(async () => {
    await using tmp = await tmpdir({ git: true })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        // .pem file read
        await expect(
          Plugin.trigger(
            "tool.execute.before",
            { tool: "read", sessionID: "session_sec", callID: "call_pem" },
            { args: { filePath: path.join(tmp.path, "certs", "server.pem") } },
          ),
        ).rejects.toThrow("secret material")

        // id_rsa read
        await expect(
          Plugin.trigger(
            "tool.execute.before",
            { tool: "read", sessionID: "session_sec", callID: "call_rsa" },
            { args: { filePath: path.join(tmp.path, ".ssh", "id_rsa") } },
          ),
        ).rejects.toThrow("secret material")

        // credentials.json read
        await expect(
          Plugin.trigger(
            "tool.execute.before",
            { tool: "read", sessionID: "session_sec", callID: "call_creds" },
            { args: { filePath: path.join(tmp.path, "credentials.json") } },
          ),
        ).rejects.toThrow("secret material")

        // .env.local read
        await expect(
          Plugin.trigger(
            "tool.execute.before",
            { tool: "read", sessionID: "session_sec", callID: "call_env_local" },
            { args: { filePath: path.join(tmp.path, ".env.local") } },
          ),
        ).rejects.toThrow("secret material")

        // id_ed25519 read
        await expect(
          Plugin.trigger(
            "tool.execute.before",
            { tool: "read", sessionID: "session_sec", callID: "call_ed25519" },
            { args: { filePath: path.join(tmp.path, ".ssh", "id_ed25519") } },
          ),
        ).rejects.toThrow("secret material")

        // Normal file should pass
        await expect(
          Plugin.trigger(
            "tool.execute.before",
            { tool: "read", sessionID: "session_sec", callID: "call_normal" },
            { args: { filePath: path.join(tmp.path, "src", "index.ts") } },
          ),
        ).resolves.toBeDefined()
      },
    })
  })
})

test("git fetch timeout does not block chat.message on slow networks", async () => {
  await withProfile(async () => {
    await using tmp = await tmpdir({ git: true })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const hook = (await Plugin.list()).find((item) => typeof item.event === "function")
        await hook?.event?.({
          event: {
            type: "session.created",
            properties: { sessionID: "session_fetch_timeout" },
          },
        } as any)

        // chat.message should complete even if git fetch fails
        const parts: { id?: string; sessionID?: string; messageID?: string; type?: string; text?: string }[] = [
          { type: "text", text: "Hello" },
        ]
        const start = Date.now()
        await Plugin.trigger(
          "chat.message",
          { sessionID: "session_fetch_timeout" },
          {
            message: { id: "msg_timeout", sessionID: "session_fetch_timeout", role: "user" },
            parts,
          },
        )
        const elapsed = Date.now() - start
        // Should not take more than 10 seconds (timeout is 5s + overhead)
        expect(elapsed).toBeLessThan(10000)
      },
    })
  })
})

test("version baseline regression blocks downgrades but allows upgrades", async () => {
  await withProfile(async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        await Bun.write(path.join(dir, "package.json"), JSON.stringify({ version: "2.0.0" }, null, 2))
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        // Downgrade should be blocked
        await expect(
          Plugin.trigger(
            "tool.execute.before",
            { tool: "edit", sessionID: "session_ver", callID: "call_down" },
            { args: { filePath: path.join(tmp.path, "package.json"), oldString: '"version": "2.0.0"', newString: '"version": "1.9.0"' } },
          ),
        ).rejects.toThrow("version baseline regression")

        // Upgrade should pass
        await expect(
          Plugin.trigger(
            "tool.execute.before",
            { tool: "edit", sessionID: "session_ver", callID: "call_up" },
            { args: { filePath: path.join(tmp.path, "package.json"), oldString: '"version": "2.0.0"', newString: '"version": "2.1.0"' } },
          ),
        ).resolves.toBeDefined()
      },
    })
  })
})

test("docker build-arg secret detection blocks leaked credentials", async () => {
  await withProfile(async () => {
    await using tmp = await tmpdir({ git: true })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const hook = (await Plugin.list()).find((item) => typeof item.event === "function")
        await hook?.event?.({
          event: {
            type: "session.created",
            properties: { sessionID: "session_docker" },
          },
        } as any)

        // AWS key in build-arg should be blocked
        await expect(
          Plugin.trigger(
            "tool.execute.before",
            { tool: "bash", sessionID: "session_docker", callID: "call_docker_aws" },
            { args: { command: "docker build --build-arg AWS_SECRET_KEY=AKIAIOSFODNN7EXAMPLE ." } },
          ),
        ).rejects.toThrow("docker build --build-arg contains secrets")

        // Safe build-arg should pass
        await expect(
          Plugin.trigger(
            "tool.execute.before",
            { tool: "bash", sessionID: "session_docker", callID: "call_docker_safe" },
            { args: { command: "docker build --build-arg NODE_ENV=production ." } },
          ),
        ).resolves.toBeDefined()
      },
    })
  })
})

test("protected branch push detection blocks direct push to main/develop", async () => {
  await withProfile(async () => {
    await using tmp = await tmpdir({ git: true })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        // Explicit push to main should be blocked
        await expect(
          Plugin.trigger(
            "tool.execute.before",
            { tool: "bash", sessionID: "session_branch", callID: "call_push_main" },
            { args: { command: "git push origin main" } },
          ),
        ).rejects.toThrow("protected branch blocked")

        // Push with HEAD: refspec should be blocked
        await expect(
          Plugin.trigger(
            "tool.execute.before",
            { tool: "bash", sessionID: "session_branch", callID: "call_push_head" },
            { args: { command: "git push origin HEAD:main" } },
          ),
        ).rejects.toThrow("protected branch blocked")
      },
    })
  })
})

test("team plugin skips parallel enforcement for read-only investigation requests", async () => {
  await withProfile(async () => {
    await using tmp = await tmpdir({ git: true })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        // Read-only investigation request should NOT trigger parallel enforcement
        const readOnlyText =
          "Investigate the following issues across packages/a, packages/b, and packages/c:\n" +
          "- 1. Check which modules import the deprecated API\n" +
          "- 2. Analyze the dependency graph between packages\n" +
          "- 3. Report which tests cover the shared module\n" +
          "- 4. Show the current state of the CI pipeline\n" +
          "This spans multiple packages for a thorough analysis."

        const readParts: { id?: string; sessionID?: string; messageID?: string; type?: string; text?: string }[] = [
          { type: "text", text: readOnlyText },
        ]

        await Plugin.trigger(
          "chat.message",
          { sessionID: "session_team_readonly", agent: "implement" },
          {
            message: { id: "msg_readonly", sessionID: "session_team_readonly", role: "user" },
            parts: readParts,
          },
        )

        // No parallel enforcement injection for read-only requests
        const parallelInjected = readParts.find(
          (item) => item.type === "text" && typeof item.text === "string" && item.text.includes("Parallel implementation policy is active"),
        )
        expect(parallelInjected).toBeUndefined()

        // Edits should NOT be blocked (no need gate set)
        await expect(
          Plugin.trigger(
            "tool.execute.before",
            { tool: "edit", sessionID: "session_team_readonly", callID: "call_readonly_edit" },
            { args: { filePath: path.join(tmp.path, "src", "index.ts"), oldString: "a", newString: "b" } },
          ),
        ).resolves.toBeDefined()
      },
    })
  })
})

test("team plugin enforces parallel policy for implementation requests", async () => {
  await withProfile(async () => {
    await using tmp = await tmpdir({ git: true })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        // Implementation request SHOULD trigger parallel enforcement
        const implText =
          "Implement the following features across packages/a, packages/b, and packages/c:\n" +
          "- 1. Add a new authentication middleware\n" +
          "- 2. Create database migration scripts\n" +
          "- 3. Build the user registration endpoint\n" +
          "- 4. Add integration tests for the flow\n" +
          "This is a large implementation plan."

        const implParts: { id?: string; sessionID?: string; messageID?: string; type?: string; text?: string }[] = [
          { type: "text", text: implText },
        ]

        await Plugin.trigger(
          "chat.message",
          { sessionID: "session_team_impl", agent: "implement" },
          {
            message: { id: "msg_impl", sessionID: "session_team_impl", role: "user" },
            parts: implParts,
          },
        )

        const parallelInjected = implParts.find(
          (item) => item.type === "text" && typeof item.text === "string" && item.text.includes("Parallel implementation policy is active"),
        )
        expect(parallelInjected).toBeDefined()

        // Direct edit should be blocked
        await expect(
          Plugin.trigger(
            "tool.execute.before",
            { tool: "edit", sessionID: "session_team_impl", callID: "call_impl_edit" },
            { args: { filePath: path.join(tmp.path, "src", "index.ts"), oldString: "a", newString: "b" } },
          ),
        ).rejects.toThrow("Parallel implementation is enforced")

        // Non-mutating bash should pass
        await expect(
          Plugin.trigger(
            "tool.execute.before",
            { tool: "bash", sessionID: "session_team_impl", callID: "call_impl_ls" },
            { args: { command: "ls -la" } },
          ),
        ).resolves.toBeDefined()
      },
    })
  })
})

test("team plugin allows review agent to skip parallel enforcement", async () => {
  await withProfile(async () => {
    await using tmp = await tmpdir({ git: true })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        // Implementation request from review agent should NOT trigger parallel enforcement
        const text =
          "Implement the following multi-file refactoring across packages/a, packages/b, and packages/c:\n" +
          "- 1. Extract shared types\n" +
          "- 2. Update imports\n" +
          "- 3. Add barrel exports\n" +
          "- 4. Fix consumers\n" +
          "This is a large plan."

        const parts: { id?: string; sessionID?: string; messageID?: string; type?: string; text?: string }[] = [
          { type: "text", text },
        ]

        await Plugin.trigger(
          "chat.message",
          { sessionID: "session_team_review", agent: "review" },
          {
            message: { id: "msg_review", sessionID: "session_team_review", role: "user" },
            parts,
          },
        )

        const parallelInjected = parts.find(
          (item) => item.type === "text" && typeof item.text === "string" && item.text.includes("Parallel implementation policy is active"),
        )
        expect(parallelInjected).toBeUndefined()
      },
    })
  })
})

test("team plugin resets need gate after team tool completes", async () => {
  await withProfile(async () => {
    await using tmp = await tmpdir({ git: true })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        // Set up parallel enforcement
        const text =
          "Implement the following across packages/a, packages/b, and packages/c:\n" +
          "- 1. Add new types\n" +
          "- 2. Update imports\n" +
          "- 3. Add tests\n" +
          "- 4. Fix consumers\n" +
          "Large multi-file implementation."

        const parts: { id?: string; sessionID?: string; messageID?: string; type?: string; text?: string }[] = [
          { type: "text", text },
        ]

        await Plugin.trigger(
          "chat.message",
          { sessionID: "session_team_reset", agent: "implement" },
          {
            message: { id: "msg_reset", sessionID: "session_team_reset", role: "user" },
            parts,
          },
        )

        // Edit is blocked before team tool
        await expect(
          Plugin.trigger(
            "tool.execute.before",
            { tool: "edit", sessionID: "session_team_reset", callID: "call_edit_pre" },
            { args: { filePath: path.join(tmp.path, "src", "a.ts"), oldString: "a", newString: "b" } },
          ),
        ).rejects.toThrow("Parallel implementation is enforced")

        // Simulate team tool completion via tool.execute.after
        await Plugin.trigger(
          "tool.execute.after",
          { tool: "team", sessionID: "session_team_reset", callID: "call_team_done" },
          { title: "team", output: "team completed", metadata: {} },
        )

        // Edit should now be allowed after team completes
        await expect(
          Plugin.trigger(
            "tool.execute.before",
            { tool: "edit", sessionID: "session_team_reset", callID: "call_edit_post" },
            { args: { filePath: path.join(tmp.path, "src", "a.ts"), oldString: "a", newString: "b" } },
          ),
        ).resolves.toBeDefined()
      },
    })
  })
})

for (const replay of Object.values(replays)) {
  it.live(`guardrail replay keeps ${replay.command} executable`, () =>
    run(replay).pipe(
      Effect.map((data) => {
        assertReplay(replay, data)
      }),
    ),
  )
}
