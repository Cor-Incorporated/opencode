import { afterAll, afterEach, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { pathToFileURL } from "url"
import { Agent } from "../../src/agent/agent"
import { Command } from "../../src/command"
import { Config } from "../../src/config/config"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { Skill } from "../../src/skill"
import { Filesystem } from "../../src/util/filesystem"
import { SessionID } from "../../src/session/schema"
import { Permission } from "../../src/permission"
import { tmpdir } from "../fixture/fixture"

const disable = process.env.OPENCODE_DISABLE_DEFAULT_PLUGINS
process.env.OPENCODE_DISABLE_DEFAULT_PLUGINS = "1"

const { Plugin } = await import("../../src/plugin")

const managed = process.env.OPENCODE_TEST_MANAGED_CONFIG_DIR!
const profile = path.resolve(import.meta.dir, "../../../guardrails/profile")

afterEach(async () => {
  await Instance.disposeAll()
  await fs.rm(managed, { force: true, recursive: true }).catch(() => {})
  await Config.invalidate(true)
})

afterAll(() => {
  if (disable === undefined) {
    delete process.env.OPENCODE_DISABLE_DEFAULT_PLUGINS
    return
  }
  process.env.OPENCODE_DISABLE_DEFAULT_PLUGINS = disable
})

async function write(dir: string, file: string, data: object) {
  await Filesystem.write(path.join(dir, file), JSON.stringify(data, null, 2))
}

async function managedConfig(data: object) {
  await fs.mkdir(managed, { recursive: true })
  await write(managed, "opencode.json", data)
}

async function pluginProject(dir: string, source: string) {
  const file = path.join(dir, "guardrail-plugin.ts")
  await Bun.write(file, source)
  await write(dir, "opencode.json", {
    $schema: "https://opencode.ai/config.json",
    plugin: [pathToFileURL(file).href],
  })
  return file
}

test("managed config overrides project provider and share defaults", async () => {
  await using tmp = await tmpdir({
    git: true,
    init: async (dir) => {
      await write(dir, "opencode.json", {
        $schema: "https://opencode.ai/config.json",
        share: "auto",
        enabled_providers: ["openrouter", "openai"],
      })
    },
  })

  await managedConfig({
    $schema: "https://opencode.ai/config.json",
    share: "disabled",
    enabled_providers: ["zai", "openai"],
    disabled_providers: ["openrouter"],
  })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const cfg = await Config.get()
      expect(cfg.share).toBe("disabled")
      expect(cfg.enabled_providers).toEqual(["zai", "openai"])
      expect(cfg.disabled_providers).toEqual(["openrouter"])
    },
  })
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

test("project plugin can inject shell environment for policy mode", async () => {
  await using tmp = await tmpdir({
    git: true,
    init: async (dir) => {
      await pluginProject(
        dir,
        [
          "export default async () => ({",
          '  "shell.env": async (_input, output) => {',
          '    output.env.GUARDRAIL_MODE = "strict"',
          "  },",
          "})",
          "",
        ].join("\n"),
      )
    },
  })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      await Plugin.init()
      const out = await Plugin.trigger("shell.env", { cwd: tmp.path }, { env: {} as Record<string, string> })
      expect(out.env.GUARDRAIL_MODE).toBe("strict")
    },
  })
})

test("project plugin can extend compaction context for state handoff", async () => {
  await using tmp = await tmpdir({
    git: true,
    init: async (dir) => {
      await pluginProject(
        dir,
        [
          "export default async () => ({",
          '  "experimental.session.compacting": async (_input, output) => {',
          '    output.context.push("Preserve guardrail lock state before compaction.")',
          '    output.prompt = "Resume with guardrail state restored."',
          "  },",
          "})",
          "",
        ].join("\n"),
      )
    },
  })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      await Plugin.init()
      const out = await Plugin.trigger(
        "experimental.session.compacting",
        { sessionID: SessionID.make("ses_guardrail") },
        { context: [] as string[], prompt: undefined as string | undefined },
      )
      expect(out.context).toEqual(["Preserve guardrail lock state before compaction."])
      expect(out.prompt).toBe("Resume with guardrail state restored.")
    },
  })
})

test("guardrail profile keeps internal assets while allowing project-local additions", async () => {
  const prev = process.env.OPENCODE_CONFIG_DIR
  process.env.OPENCODE_CONFIG_DIR = profile

  try {
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
        const name = await Agent.defaultAgent()
        const implement = await Agent.get("implement")
        const review = await Agent.get("review")

        expect(cfg.default_agent).toBe("implement")
        expect(cfg.share).toBe("disabled")
        expect(cfg.server?.hostname).toBe("127.0.0.1")
        expect(name).toBe("implement")
        expect(implement?.mode).toBe("primary")
        expect(Permission.evaluate("question", "*", implement?.permission).action).toBe("allow")
        expect(Permission.evaluate("bash", "git push --force-with-lease origin head", implement?.permission).action).toBe(
          "deny",
        )
        expect(Permission.evaluate("edit", "*", review?.permission).action).toBe("deny")
        expect(cmds.some((item) => item.name === "implement" && item.agent === "implement")).toBe(true)
        expect(cmds.some((item) => item.name === "review" && item.agent === "review" && item.subtask)).toBe(true)
        expect(cmds.some((item) => item.name === "ship" && item.agent === "review" && item.subtask)).toBe(true)
        expect(cmds.some((item) => item.name === "handoff")).toBe(true)
        expect(cmds.some((item) => item.name === "project-local")).toBe(true)
        expect(agents.some((item) => item.name === "implement")).toBe(true)
        expect(skills.some((item) => item.name === "project-skill")).toBe(true)
        expect(agents.some((item) => item.name === "review")).toBe(true)
        expect(agents.some((item) => item.name === "project-review")).toBe(true)
      },
    })
  } finally {
    if (prev === undefined) delete process.env.OPENCODE_CONFIG_DIR
    else process.env.OPENCODE_CONFIG_DIR = prev
  }
})

test("guardrail profile plugin injects env, blocks secret reads, and logs session lifecycle", async () => {
  const prevDir = process.env.OPENCODE_CONFIG_DIR
  const prevLog = process.env.GUARDRAIL_LOG_FILE
  process.env.OPENCODE_CONFIG_DIR = profile

  await using tmp = await tmpdir({
    git: true,
    init: async (dir) => {
      await Bun.write(path.join(dir, ".env"), "SECRET=1\n")
    },
  })

  process.env.GUARDRAIL_LOG_FILE = path.join(tmp.path, "guardrail.jsonl")

  try {
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await Plugin.init()

        const env = await Plugin.trigger("shell.env", { cwd: tmp.path }, { env: {} as Record<string, string> })
        expect(env.env.GUARDRAIL_MODE).toBe("strict")

        await expect(
          Plugin.trigger(
            "tool.execute.before",
            { tool: "read", sessionID: SessionID.make("ses_guardrail_plugin"), callID: "call_guardrail_plugin" },
            { args: { filePath: path.join(tmp.path, ".env") } },
          ),
        ).rejects.toThrow("guardrail blocked read access")

        const session = await Session.create({})
        const out = await Plugin.trigger(
          "experimental.session.compacting",
          { sessionID: session.id },
          { context: [] as string[], prompt: undefined as string | undefined },
        )
        const hooks = await Plugin.list()

        expect(out.context).toContain("Preserve guardrail approvals, denials, and policy mode before compaction.")

        await Promise.all(
          hooks.map((hook) =>
            hook.event?.({
              event: {
                type: "session.created",
                properties: {
                  sessionID: session.id,
                  info: session,
                },
              } as never,
            }),
          ),
        )

        const log = await Bun.file(process.env.GUARDRAIL_LOG_FILE!).text()
        expect(log).toContain('"event":"session.created"')
      },
    })
  } finally {
    if (prevDir === undefined) delete process.env.OPENCODE_CONFIG_DIR
    else process.env.OPENCODE_CONFIG_DIR = prevDir
    if (prevLog === undefined) delete process.env.GUARDRAIL_LOG_FILE
    else process.env.GUARDRAIL_LOG_FILE = prevLog
  }
})
