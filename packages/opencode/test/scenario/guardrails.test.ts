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
import TeamPlugin from "../../../guardrails/profile/plugins/team"

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
        expect(perm(impl, "webfetch", "https://example.com")).toBe("allow")
        expect(perm(impl, "edit")).toBe("allow")
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

        expect(
          cfg.plugin_origins?.some((item) =>
            String(Array.isArray(item.spec) ? item.spec[0] : item.spec).includes("/plugins/guardrail.ts"),
          ),
        ).toBe(true)
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
        ).rejects.toThrow("delegate with the team tool")
      },
    })
  })
})

test("guardrail profile blocks write-capable background workers until team runs", async () => {
  await withProfile(async () => {
    await using tmp = await tmpdir({ git: true })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const parts: { id?: string; sessionID?: string; messageID?: string; type?: string; text?: string }[] = [
          {
            type: "text",
            text:
              "Implement the following multi-file refactor across packages/a and packages/b.\n" +
              "1. Add a shared helper.\n" +
              "2. Update both packages.\n" +
              "3. Fix downstream imports.\n" +
              "This is a broad multi-file implementation.",
          },
        ]

        await Plugin.trigger(
          "chat.message",
          {
            sessionID: "session_team_gate",
            agent: "implement",
          },
          {
            message: {
              id: "msg_team_gate",
              sessionID: "session_team_gate",
              role: "user",
            },
            parts,
          },
        )

        await expect(
          Plugin.trigger(
            "tool.execute.before",
            { tool: "background", sessionID: "session_team_gate", callID: "call_bg_write" },
            {
              args: {
                prompt: "Edit src/a.ts to add the new helper",
                write: true,
              },
            },
          ),
        ).rejects.toThrow("Use the team tool with at least two tasks")

        await expect(
          Plugin.trigger(
            "tool.execute.before",
            { tool: "background", sessionID: "session_team_gate", callID: "call_bg_read" },
            {
              args: {
                prompt: "Inspect src/a.ts and summarize it",
                write: false,
              },
            },
          ),
        ).resolves.toEqual({
          args: {
            prompt: "Inspect src/a.ts and summarize it",
            write: false,
          },
        })
      },
    })
  })
})

test("project-specific bash allows beat profile wildcard asks", async () => {
  await withProfile(async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        await write(dir, "opencode.json", {
          $schema: "https://opencode.ai/config.json",
          permission: {
            bash: {
              "*": "ask",
              "supabase *": "allow",
            },
          },
        })
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const agent = await Agent.get("build")
        expect(perm(agent, "bash", "supabase db query")).toBe("allow")
        expect(perm(agent, "bash", "unknown cmd")).toBe("ask")
      },
    })
  })
})

test("team tool allows a single read-only task", async () => {
  await withProfile(async () => {
    await using tmp = await tmpdir({ git: true, config: { share: "auto" } })

    const plugin = await TeamPlugin({
      client: {
        session: {
          create: async () => ({ data: { id: "child" } }),
          promptAsync: async () => ({}),
          prompt: async () => ({}),
          status: async () => ({ data: { child: { type: "idle" } } }),
          messages: async () => ({
            data: [{ info: { role: "assistant" }, parts: [{ type: "text", text: "ok" }] }],
          }),
          abort: async () => ({}),
        },
      },
      worktree: tmp.path,
      directory: tmp.path,
    })

    const result = await plugin.tool.team.execute(
      {
        strategy: "parallel",
        limit: 1,
        tasks: [
          {
            id: "inspect",
            description: "inspect only",
            prompt: "Inspect src/index.ts and report findings without editing files.",
            write: false,
            worktree: false,
          },
        ],
      },
      {
        sessionID: "session_team_single",
        messageID: "",
        agent: "build",
        directory: tmp.path,
        worktree: tmp.path,
        abort: AbortSignal.any([]),
        metadata: () => {},
        ask: async () => {},
      },
    )

    expect(result).toContain("run_id:")
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

        expect(log).toContain('"type":"session.created"')
        expect(log).toContain('"type":"permission.asked"')
        expect(log).toContain('"type":"session.idle"')
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
          (item) =>
            item.type === "text" &&
            typeof item.text === "string" &&
            item.text.includes("Parallel implementation policy is active"),
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

for (const replay of Object.values(replays)) {
  it.live(`guardrail replay keeps ${replay.command} executable`, () =>
    run(replay).pipe(
      Effect.map((data) => {
        assertReplay(replay, data)
      }),
    ),
  )
}
