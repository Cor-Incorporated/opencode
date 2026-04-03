import { afterEach, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Agent } from "../../src/agent/agent"
import { Command } from "../../src/command"
import { Config } from "../../src/config/config"
import { Plugin } from "../../src/plugin"
import { Instance } from "../../src/project/instance"
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
