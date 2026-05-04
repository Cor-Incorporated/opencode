import { afterEach, expect, test } from "bun:test"
import { Effect } from "effect"
import fs from "fs/promises"
import path from "path"
import team from "../../../../packages/guardrails/profile/plugins/team"
import { evaluate } from "../../src/permission/evaluate"
import { Instance } from "../../src/project/instance"
import { Background } from "../../src/util/background"
import { disposeAllInstances, tmpdir } from "../fixture/fixture"

afterEach(async () => {
  await disposeAllInstances()
})

test("team uses default limit when caller omits limit", async () => {
  await using tmp = await tmpdir({ git: true })
  let prompted = false

  const plugin = await team({
    client: {
      permission: {
        async list() {
          return { data: [] }
        },
      },
      question: {
        async list() {
          return { data: [] }
        },
      },
      session: {
        async get() {
          return { data: { permission: [] } }
        },
        async create() {
          return { data: { id: "ses_child" } }
        },
        async promptAsync() {
          prompted = true
          return {}
        },
        async prompt() {
          return {}
        },
        async status() {
          return {
            data: {
              ses_child: {
                type: "idle",
              },
            },
          }
        },
        async messages() {
          return {
            data: [
              {
                info: {
                  role: "assistant",
                },
                parts: [
                  {
                    type: "text",
                    text: "done",
                  },
                ],
              },
            ],
          }
        },
        async abort() {
          return {}
        },
      },
    },
    worktree: tmp.path,
    directory: tmp.path,
  })

  const out = await plugin.tool.team.execute(
    {
      tasks: [
        {
          id: "default-limit",
          prompt: "inspect scheduler defaults",
          write: false,
        },
      ],
    } as unknown as Parameters<typeof plugin.tool.team.execute>[0],
    {
      sessionID: "ses_parent",
      messageID: "msg_parent",
      agent: "implement",
      directory: tmp.path,
      worktree: tmp.path,
      abort: new AbortController().signal,
      ask: () => Effect.void,
      metadata() {},
    },
  )

  expect(prompted).toBe(true)
  expect(out).toContain("default-limit: done")
})

test("team creates run before stale sweep can block launch", async () => {
  await using tmp = await tmpdir({
    git: true,
    init: async (dir) => {
      await Bun.write(path.join(dir, "README.md"), "# test\n")
      await fs.mkdir(path.join(dir, ".opencode", "guardrails", "team-runs"), { recursive: true })
      await Bun.write(
        path.join(dir, ".opencode", "guardrails", "team-runs", "stale-run.json"),
        JSON.stringify(
          {
            id: "stale-run",
            kind: "team",
            state: "running",
            session: "ses_parent",
            directory: dir,
            created_at: new Date(0).toISOString(),
            updated_at: new Date(0).toISOString(),
            tasks: [
              {
                id: "stale",
                description: "stale",
                prompt: "old work",
                depends: [],
                agent: "general",
                write: false,
                worktree: false,
                provider: "openai",
                model: "gpt-5.5",
                variant: "high",
                state: "running",
                dir,
                session: "ses_child_stale_blocked",
                patch: "",
                output: "",
                error: "",
              },
            ],
          },
          null,
          2,
        ) + "\n",
      )
      await Bun.$`git add README.md`.cwd(dir).quiet()
      await Bun.$`git commit -m "seed"`.cwd(dir).quiet()
    },
  })

  const metadata: Record<string, unknown>[] = []
  const plugin = await team({
    client: {
      permission: {
        async list() {
          return { data: [] }
        },
      },
      question: {
        async list() {
          return { data: [] }
        },
      },
      session: {
        async get() {
          return { data: { permission: [] } }
        },
        async create() {
          return { data: { id: "ses_child_fresh_after_blocked_sweep" } }
        },
        async promptAsync() {
          return {}
        },
        async prompt() {
          return {}
        },
        async status() {
          return {
            data: {
              ses_child_stale_blocked: { type: "busy" },
              ses_child_fresh_after_blocked_sweep: { type: "idle" },
            },
          }
        },
        async messages(input) {
          if (input.path.id === "ses_child_stale_blocked") await new Promise(() => {})
          return {
            data: [
              {
                info: {
                  role: "assistant",
                  time: { completed: Date.now() },
                },
                parts: [
                  {
                    type: "text",
                    text: "fresh work completed",
                  },
                ],
              },
            ],
          }
        },
        async abort() {
          return {}
        },
      },
    },
    worktree: tmp.path,
    directory: tmp.path,
  })

  const out = await plugin.tool.team.execute(
    {
      strategy: "parallel",
      limit: 1,
      tasks: [
        {
          id: "fresh",
          prompt: "inspect current work",
          write: false,
          worktree: false,
        },
      ],
    },
    {
      sessionID: "ses_parent",
      messageID: "msg_parent",
      agent: "implement",
      directory: tmp.path,
      worktree: tmp.path,
      abort: new AbortController().signal,
      ask: () => Effect.void,
      metadata(input) {
        metadata.push(input.metadata ?? {})
      },
    },
  )

  expect(out).toContain("run_id:")
  expect(out).toContain("- fresh: done")
  expect(metadata.some((item) => typeof item.run_id === "string")).toBe(true)

  const runs = await fs.readdir(path.join(tmp.path, ".opencode", "guardrails", "team-runs"))
  expect(runs.length).toBeGreaterThanOrEqual(2)
})

test("team worker model inherits the parent session model", async () => {
  await using tmp = await tmpdir({
    git: true,
    init: async (dir) => {
      await Bun.write(path.join(dir, "README.md"), "# test\n")
      await Bun.$`git add README.md`.cwd(dir).quiet()
      await Bun.$`git commit -m "seed"`.cwd(dir).quiet()
    },
  })

  let model:
    | {
        providerID: string
        modelID: string
      }
    | undefined

  const plugin = await team({
    client: {
      permission: {
        async list() {
          return { data: [] }
        },
      },
      question: {
        async list() {
          return { data: [] }
        },
      },
      session: {
        async get() {
          return { data: { permission: [] } }
        },
        async create() {
          return { data: { id: "ses_child_inherit_model" } }
        },
        async promptAsync(input) {
          model = input.body.model
          return {}
        },
        async prompt() {
          return {}
        },
        async status() {
          return {
            data: {
              ses_child_inherit_model: {
                type: "idle",
              },
            },
          }
        },
        async messages() {
          return {
            data: [
              {
                info: {
                  role: "assistant",
                  time: { completed: Date.now() },
                },
                parts: [
                  {
                    type: "text",
                    text: "done",
                  },
                ],
              },
            ],
          }
        },
        async abort() {
          return {}
        },
      },
    },
    worktree: tmp.path,
    directory: tmp.path,
  })

  await plugin["chat.message"]?.(
    {
      sessionID: "ses_parent_model",
      agent: "implement",
      model: {
        providerID: "zai-coding-plan",
        modelID: "glm-5.1",
      },
    },
    {
      message: {
        id: "msg_parent_model",
        sessionID: "ses_parent_model",
        role: "user",
      },
      parts: [
        {
          type: "text",
          text: "Inspect the repository model routing before the team worker runs.",
        },
      ],
    },
  )

  const out = await plugin.tool.team.execute(
    {
      tasks: [
        {
          id: "inherit-model",
          prompt: `${"Implement coordinated fixes across packages/guardrails with tests. ".repeat(12)}Check routing only.`,
          write: false,
        },
      ],
    } as unknown as Parameters<typeof plugin.tool.team.execute>[0],
    {
      sessionID: "ses_parent_model",
      messageID: "msg_parent_model",
      agent: "implement",
      directory: tmp.path,
      worktree: tmp.path,
      abort: new AbortController().signal,
      ask: () => Effect.void,
      metadata() {},
    },
  )

  expect(out).toContain("model=zai-coding-plan/glm-5.1")
  expect(model).toEqual({
    providerID: "zai-coding-plan",
    modelID: "glm-5.1",
  })
})

test("team carries local .opencode files into worker worktrees and inherits parent permission", async () => {
  await using tmp = await tmpdir({
    git: true,
    init: async (dir) => {
      await Bun.write(path.join(dir, "README.md"), "# test\n")
      await Bun.write(path.join(dir, "CLAUDE.md"), "# local claude\n")
      await fs.mkdir(path.join(dir, ".opencode"), { recursive: true })
      await fs.mkdir(path.join(dir, ".claude", "skills", "local-claude"), { recursive: true })
      await fs.mkdir(path.join(dir, ".agents", "skills", "local-agent"), { recursive: true })
      await fs.mkdir(path.join(dir, ".cursor", "rules"), { recursive: true })
      await Bun.write(
        path.join(dir, ".opencode", "opencode.jsonc"),
        `{
  "permission": {
    "bash": {
      "gh *": "allow"
    }
  }
}
`,
      )
      await Bun.write(
        path.join(dir, ".claude", "settings.local.json"),
        `{
  "permissions": {
    "allow": ["Bash(gh:*)"]
  }
}
`,
      )
      await Bun.write(
        path.join(dir, ".claude", "skills", "local-claude", "SKILL.md"),
        `---
name: local-claude
description: local claude skill
---

# Local Claude Skill
`,
      )
      await Bun.write(
        path.join(dir, ".agents", "skills", "local-agent", "SKILL.md"),
        `---
name: local-agent
description: local agent skill
---

# Local Agent Skill
`,
      )
      await Bun.write(path.join(dir, ".github", "copilot-instructions.md"), "# Local Copilot\n")
      await Bun.write(
        path.join(dir, ".cursor", "rules", "global.mdc"),
        `---
description: global
alwaysApply: true
---

# Local Cursor Rule
`,
      )
      await Bun.$`git add README.md`.cwd(dir).quiet()
      await Bun.$`git commit -m "seed"`.cwd(dir).quiet()
    },
  })

  const perm = [
    {
      permission: "bash",
      pattern: "gh *",
      action: "allow" as const,
    },
    {
      permission: "bash",
      pattern: "gh pr merge *",
      action: "deny" as const,
    },
  ]

  let box = ""
  let body:
    | {
        parentID: string
        title: string
        permission?: {
          permission: string
          pattern: string
          action: "allow" | "ask" | "deny"
        }[]
      }
    | undefined

  const plugin = await team({
    client: {
      permission: {
        async list() {
          return { data: [] }
        },
      },
      question: {
        async list() {
          return { data: [] }
        },
      },
      session: {
        async get() {
          return {
            data: {
              permission: perm,
            },
          }
        },
        async create(input) {
          body = input.body
          return {
            data: {
              id: "ses_child",
            },
          }
        },
        async promptAsync(input) {
          box = input.query.directory
          expect(box).not.toBe(tmp.path)
          expect(await Bun.file(path.join(box, "README.md")).text()).toContain("# test")
          expect(await Bun.file(path.join(box, "CLAUDE.md")).text()).toContain("local claude")
          expect(await Bun.file(path.join(box, ".opencode", "opencode.jsonc")).text()).toContain(`"gh *": "allow"`)
          expect(await Bun.file(path.join(box, ".claude", "settings.local.json")).text()).toContain(`"Bash(gh:*)"`)
          expect(await Bun.file(path.join(box, ".claude", "skills", "local-claude", "SKILL.md")).text()).toContain(
            "local-claude",
          )
          expect(await Bun.file(path.join(box, ".agents", "skills", "local-agent", "SKILL.md")).text()).toContain(
            "local-agent",
          )
          expect(await Bun.file(path.join(box, ".github", "copilot-instructions.md")).text()).toContain("Local Copilot")
          expect(await Bun.file(path.join(box, ".cursor", "rules", "global.mdc")).text()).toContain("Local Cursor Rule")
          await Bun.write(path.join(box, "worker.txt"), "worker output\n")
        },
        async prompt() {
          return {}
        },
        async status() {
          return {
            data: {
              ses_child: {
                type: "idle",
              },
            },
          }
        },
        async messages() {
          return {
            data: [
              {
                info: {
                  role: "assistant",
                },
                parts: [
                  {
                    type: "text",
                    text: "done",
                  },
                ],
              },
            ],
          }
        },
        async abort() {
          return {}
        },
      },
    },
    worktree: tmp.path,
    directory: tmp.path,
  })

  const out = await plugin.tool.team.execute(
    {
      strategy: "parallel",
      limit: 1,
      tasks: [
        {
          id: "copy",
          prompt: "check local config",
          write: true,
        },
      ],
    },
    {
      sessionID: "ses_parent",
      messageID: "msg_parent",
      agent: "implement",
      directory: tmp.path,
      worktree: tmp.path,
      abort: new AbortController().signal,
      ask: () => Effect.void,
      metadata() {},
    },
  )

  expect(out).toContain("run_id:")
  expect(body?.parentID).toBe("ses_parent")
  expect(body?.permission?.slice(0, perm.length)).toEqual(perm)
  expect(body?.permission).toContainEqual({ permission: "bash", pattern: "rg *", action: "allow" })
  expect(body?.permission).toContainEqual({ permission: "bash", pattern: "git ls-tree*", action: "allow" })
  expect(body?.permission).toContainEqual({ permission: "bash", pattern: "git worktree list*", action: "allow" })
  expect(body?.permission).toContainEqual({ permission: "bash", pattern: "git checkout *", action: "allow" })
  expect(body?.permission).toContainEqual({ permission: "bash", pattern: "git rebase origin/develop", action: "allow" })
  expect(body?.permission).toContainEqual({ permission: "bash", pattern: "git checkout -- *", action: "allow" })
  expect(body?.permission).toContainEqual({ permission: "bash", pattern: "git cherry-pick *", action: "allow" })
  expect(evaluate("bash", "git worktree list", body?.permission ?? []).action).toBe("allow")
  expect(evaluate("bash", "git checkout feat/alpha-quality-gates", body?.permission ?? []).action).toBe("allow")
  expect(evaluate("bash", "opencode run /init", body?.permission ?? []).action).toBe("deny")
  expect(evaluate("bash", "rm -rf .opencode", body?.permission ?? []).action).toBe("deny")
  expect(body?.permission).toContainEqual({ permission: "bash", pattern: "opencode *", action: "deny" })
  expect(box).toContain(path.join(".opencode", "team"))
})

test("team carries local .opencode config even when the project gitignore ignores .opencode", async () => {
  await using tmp = await tmpdir({
    git: true,
    init: async (dir) => {
      await Bun.write(path.join(dir, ".gitignore"), ".opencode/\n")
      await Bun.write(path.join(dir, "README.md"), "# test\n")
      await fs.mkdir(path.join(dir, ".opencode", "plugins"), { recursive: true })
      await Bun.write(
        path.join(dir, ".opencode", "opencode.jsonc"),
        `{
  "plugin": ["./plugins/team.ts"]
}
`,
      )
      await Bun.write(path.join(dir, ".opencode", "plugins", "team.ts"), "export default async function team() {}\n")
      await Bun.$`git add .gitignore README.md`.cwd(dir).quiet()
      await Bun.$`git commit -m "seed"`.cwd(dir).quiet()
    },
  })

  let box = ""

  const plugin = await team({
    client: {
      permission: {
        async list() {
          return { data: [] }
        },
      },
      question: {
        async list() {
          return { data: [] }
        },
      },
      session: {
        async get() {
          return { data: { permission: [] } }
        },
        async create() {
          return {
            data: {
              id: "ses_child_ignored_opencode",
            },
          }
        },
        async promptAsync(input) {
          box = input.query.directory
          expect(box).not.toBe(tmp.path)
          expect(await Bun.file(path.join(box, ".opencode", "opencode.jsonc")).text()).toContain("./plugins/team.ts")
          expect(await Bun.file(path.join(box, ".opencode", "plugins", "team.ts")).text()).toContain("export default")
          await Bun.write(path.join(box, "worker.txt"), "worker output\n")
        },
        async prompt() {
          return {}
        },
        async status() {
          return {
            data: {
              ses_child_ignored_opencode: {
                type: "idle",
              },
            },
          }
        },
        async messages() {
          return {
            data: [
              {
                info: {
                  role: "assistant",
                },
                parts: [
                  {
                    type: "text",
                    text: "done",
                  },
                ],
              },
            ],
          }
        },
        async abort() {
          return {}
        },
      },
    },
    worktree: tmp.path,
    directory: tmp.path,
  })

  const out = await plugin.tool.team.execute(
    {
      strategy: "parallel",
      limit: 1,
      tasks: [
        {
          id: "ignored-opencode",
          prompt: "inspect local opencode config",
          write: true,
        },
      ],
    },
    {
      sessionID: "ses_parent",
      messageID: "msg_parent",
      agent: "implement",
      directory: tmp.path,
      worktree: tmp.path,
      abort: new AbortController().signal,
      ask: () => Effect.void,
      metadata() {},
    },
  )

  expect(out).toContain("run_id:")
  expect(box).toContain(path.join(".opencode", "team"))
})

test("team rewrites parent absolute paths into isolated worker prompts", async () => {
  await using tmp = await tmpdir({
    git: true,
    init: async (dir) => {
      await fs.mkdir(path.join(dir, "src"), { recursive: true })
      await Bun.write(path.join(dir, "src", "target.txt"), "before\n")
      await Bun.$`git add src/target.txt`.cwd(dir).quiet()
      await Bun.$`git commit -m "seed"`.cwd(dir).quiet()
    },
  })

  let box = ""
  const parent = path.join(tmp.path, "src", "target.txt")
  const plugin = await team({
    client: {
      permission: {
        async list() {
          return { data: [] }
        },
      },
      question: {
        async list() {
          return { data: [] }
        },
      },
      session: {
        async get() {
          return { data: { permission: [] } }
        },
        async create() {
          return {
            data: {
              id: "ses_child_absolute_path",
            },
          }
        },
        async promptAsync(input) {
          box = input.query.directory
          const text = input.body.parts[0]?.text ?? ""
          const target = path.join(box, "src", "target.txt")
          expect(text).toContain(target)
          expect(text).not.toContain(parent)
          await Bun.write(target, "after\n")
        },
        async prompt() {
          return {}
        },
        async status() {
          return {
            data: {
              ses_child_absolute_path: {
                type: "idle",
              },
            },
          }
        },
        async messages() {
          return {
            data: [
              {
                info: {
                  role: "assistant",
                  time: { completed: Date.now() },
                },
                parts: [
                  {
                    type: "text",
                    text: "done",
                  },
                ],
              },
            ],
          }
        },
        async abort() {
          return {}
        },
      },
    },
    worktree: tmp.path,
    directory: tmp.path,
  })

  const out = await plugin.tool.team.execute(
    {
      strategy: "parallel",
      limit: 1,
      tasks: [
        {
          id: "absolute-path",
          prompt: `Edit ${parent} and replace the contents with after.`,
          write: true,
        },
      ],
    },
    {
      sessionID: "ses_parent",
      messageID: "msg_parent",
      agent: "implement",
      directory: tmp.path,
      worktree: tmp.path,
      abort: new AbortController().signal,
      ask: () => Effect.void,
      metadata() {},
    },
  )

  expect(out).toContain("- absolute-path: done")
  expect(box).toContain(path.join(".opencode", "team"))
  expect(await Bun.file(parent).text()).toBe("after\n")
})

test("team fails isolated write tasks that produce no patch", async () => {
  await using tmp = await tmpdir({
    git: true,
    init: async (dir) => {
      await Bun.write(path.join(dir, "README.md"), "# test\n")
      await Bun.$`git add README.md`.cwd(dir).quiet()
      await Bun.$`git commit -m "seed"`.cwd(dir).quiet()
    },
  })

  const plugin = await team({
    client: {
      permission: {
        async list() {
          return { data: [] }
        },
      },
      question: {
        async list() {
          return { data: [] }
        },
      },
      session: {
        async get() {
          return { data: { permission: [] } }
        },
        async create() {
          return {
            data: {
              id: "ses_child_no_patch",
            },
          }
        },
        async promptAsync() {
          return {}
        },
        async prompt() {
          return {}
        },
        async status() {
          return {
            data: {
              ses_child_no_patch: {
                type: "idle",
              },
            },
          }
        },
        async messages() {
          return {
            data: [
              {
                info: {
                  role: "assistant",
                  time: { completed: Date.now() },
                },
                parts: [
                  {
                    type: "text",
                    text: "done",
                  },
                ],
              },
            ],
          }
        },
        async abort() {
          return {}
        },
      },
    },
    worktree: tmp.path,
    directory: tmp.path,
  })

  await expect(
    plugin.tool.team.execute(
      {
        strategy: "parallel",
        limit: 1,
        tasks: [
          {
            id: "no-patch",
            prompt: "write a note file",
            write: true,
          },
        ],
      },
      {
        sessionID: "ses_parent",
        messageID: "msg_parent",
        agent: "implement",
        directory: tmp.path,
        worktree: tmp.path,
        abort: new AbortController().signal,
        ask: () => Effect.void,
        metadata() {},
      },
    ),
  ).rejects.toThrow("Write task completed without producing a patch")
})

test("team classifies model routing failures as llm_unavailable", async () => {
  await using tmp = await tmpdir({
    git: true,
    init: async (dir) => {
      await Bun.write(path.join(dir, "README.md"), "# test\n")
      await Bun.$`git add README.md`.cwd(dir).quiet()
      await Bun.$`git commit -m "seed"`.cwd(dir).quiet()
    },
  })

  const plugin = await team({
    client: {
      permission: {
        async list() {
          return { data: [] }
        },
      },
      question: {
        async list() {
          return { data: [] }
        },
      },
      session: {
        async get() {
          return { data: { permission: [] } }
        },
        async create() {
          return {
            data: {
              id: "ses_child_model_missing",
            },
          }
        },
        async promptAsync() {
          throw new Error("Model not found: openai/gpt-5.5")
        },
        async prompt() {
          return {}
        },
        async status() {
          return { data: {} }
        },
        async messages() {
          return { data: [] }
        },
        async abort() {
          return {}
        },
      },
    },
    worktree: tmp.path,
    directory: tmp.path,
  })

  await expect(
    plugin.tool.team.execute(
      {
        strategy: "parallel",
        limit: 1,
        tasks: [
          {
            id: "model-missing",
            prompt: "write a note file",
            write: true,
          },
        ],
      },
      {
        sessionID: "ses_parent",
        messageID: "msg_parent",
        agent: "implement",
        directory: tmp.path,
        worktree: tmp.path,
        abort: new AbortController().signal,
        ask: () => Effect.void,
        metadata() {},
      },
    ),
  ).rejects.toThrow("Model not found: openai/gpt-5.5")

  const runs = await fs.readdir(path.join(tmp.path, ".opencode", "guardrails", "team-runs"))
  const saved = JSON.parse(await Bun.file(path.join(tmp.path, ".opencode", "guardrails", "team-runs", runs[0]!)).text())
  expect(saved.tasks[0].failure_stage).toBe("llm_unavailable")
})

test("team allows explicit no_patch write tasks for operation-only work", async () => {
  await using tmp = await tmpdir({
    git: true,
    init: async (dir) => {
      await Bun.write(path.join(dir, "README.md"), "# test\n")
      await Bun.$`git add README.md`.cwd(dir).quiet()
      await Bun.$`git commit -m "seed"`.cwd(dir).quiet()
    },
  })

  const plugin = await team({
    client: {
      permission: {
        async list() {
          return { data: [] }
        },
      },
      question: {
        async list() {
          return { data: [] }
        },
      },
      session: {
        async get() {
          return { data: { permission: [] } }
        },
        async create() {
          return {
            data: {
              id: "ses_child_no_patch_ok",
            },
          }
        },
        async promptAsync() {
          return {}
        },
        async prompt() {
          return {}
        },
        async status() {
          return {
            data: {
              ses_child_no_patch_ok: {
                type: "idle",
              },
            },
          }
        },
        async messages() {
          return {
            data: [
              {
                info: {
                  role: "assistant",
                  time: { completed: Date.now() },
                },
                parts: [
                  {
                    type: "text",
                    text: "created pull request",
                  },
                ],
              },
            ],
          }
        },
        async abort() {
          return {}
        },
      },
    },
    worktree: tmp.path,
    directory: tmp.path,
  })

  const out = await plugin.tool.team.execute(
    {
      strategy: "parallel",
      limit: 1,
      tasks: [
        {
          id: "pr-only",
          prompt: "Run gh pr create for the already committed branch, then report the PR URL.",
          write: true,
          no_patch: true,
        },
      ],
    },
    {
      sessionID: "ses_parent",
      messageID: "msg_parent",
      agent: "implement",
      directory: tmp.path,
      worktree: tmp.path,
      abort: new AbortController().signal,
      ask: () => Effect.void,
      metadata() {},
    },
  )

  expect(out).toContain("pr-only: done")
  expect(out).toContain("no_patch=true")
})

test("team reports worktree setup failures instead of dependency deadlocks", async () => {
  await using tmp = await tmpdir({
    git: true,
    init: async (dir) => {
      await Bun.write(path.join(dir, "README.md"), "# test\n")
      await Bun.$`git add README.md`.cwd(dir).quiet()
      await Bun.$`git commit -m "seed"`.cwd(dir).quiet()
      await fs.mkdir(path.join(dir, ".opencode"), { recursive: true })
      await Bun.write(path.join(dir, ".opencode", "team"), "not a directory\n")
    },
  })

  const plugin = await team({
    client: {
      permission: {
        async list() {
          return { data: [] }
        },
      },
      question: {
        async list() {
          return { data: [] }
        },
      },
      session: {
        async get() {
          return { data: { permission: [] } }
        },
        async create() {
          throw new Error("session create should not run")
        },
        async promptAsync() {
          throw new Error("prompt should not run")
        },
        async prompt() {
          return {}
        },
        async status() {
          return { data: {} }
        },
        async messages() {
          return { data: [] }
        },
        async abort() {
          return {}
        },
      },
    },
    worktree: tmp.path,
    directory: tmp.path,
  })

  let thrown = ""
  try {
    await plugin.tool.team.execute(
      {
        strategy: "parallel",
        limit: 1,
        tasks: [
          {
            id: "setup-fails",
            prompt: "write a worker file",
            write: true,
            worktree: true,
          },
        ],
      },
      {
        sessionID: "ses_parent",
        messageID: "msg_parent",
        agent: "implement",
        directory: tmp.path,
        worktree: tmp.path,
        abort: new AbortController().signal,
        ask: () => Effect.void,
        metadata() {},
      },
    )
  } catch (error) {
    thrown = error instanceof Error ? error.message : String(error)
  }

  expect(thrown).not.toBe("")
  expect(thrown).not.toContain("Dependency deadlock")

  const runs = await fs.readdir(path.join(tmp.path, ".opencode", "guardrails", "team-runs"))
  const saved = JSON.parse(await Bun.file(path.join(tmp.path, ".opencode", "guardrails", "team-runs", runs[0]!)).text())
  expect(saved.state).toBe("error")
  expect(saved.tasks[0].state).toBe("error")
  expect(saved.tasks[0].dir).toBe("")
  expect(saved.tasks[0].session).toBe("")
  expect(saved.tasks[0].failure_stage).toBe("worktree_setup")
  expect(saved.tasks[0].error).not.toContain("Dependency deadlock")
})

test("team removes worktree when session create fails", async () => {
  await using tmp = await tmpdir({
    git: true,
    init: async (dir) => {
      await Bun.write(path.join(dir, "README.md"), "# test\n")
      await Bun.$`git add README.md`.cwd(dir).quiet()
      await Bun.$`git commit -m "seed"`.cwd(dir).quiet()
    },
  })

  const plugin = await team({
    client: {
      permission: {
        async list() {
          return { data: [] }
        },
      },
      question: {
        async list() {
          return { data: [] }
        },
      },
      session: {
        async get() {
          return {
            data: {
              permission: [],
            },
          }
        },
        async create() {
          throw new Error("session create failed")
        },
        async promptAsync() {
          throw new Error("should not run")
        },
        async prompt() {
          return {}
        },
        async status() {
          return { data: {} }
        },
        async messages() {
          return { data: [] }
        },
        async abort() {
          return {}
        },
      },
    },
    worktree: tmp.path,
    directory: tmp.path,
  })

  await expect(
    plugin.tool.team.execute(
      {
        strategy: "parallel",
        limit: 1,
        tasks: [
          {
            id: "create-fail",
            prompt: "write a note file",
            write: true,
          },
        ],
      },
      {
        sessionID: "ses_parent",
        messageID: "msg_parent",
        agent: "implement",
        directory: tmp.path,
        worktree: tmp.path,
        abort: new AbortController().signal,
        ask: () => Effect.void,
        metadata() {},
      },
    ),
  ).rejects.toThrow("session create failed")

  const list = await fs.readdir(path.join(tmp.path, ".opencode", "team"), { withFileTypes: true }).catch(() => [])
  expect(list.filter((item) => item.isDirectory()).length).toBe(0)
})

test("team surfaces blocked child permissions instead of hanging", async () => {
  await using tmp = await tmpdir({
    git: true,
    init: async (dir) => {
      await Bun.write(path.join(dir, "README.md"), "# test\n")
      await Bun.$`git add README.md`.cwd(dir).quiet()
      await Bun.$`git commit -m "seed"`.cwd(dir).quiet()
    },
  })

  const plugin = await team({
    client: {
      permission: {
        async list() {
          return {
            data: [
              {
                id: "per_test",
                sessionID: "ses_child_blocked",
                permission: "bash",
                patterns: ["npx vite --port 5173"],
                metadata: {
                  description: "Check gstack browse availability",
                },
              },
            ],
          }
        },
      },
      question: {
        async list() {
          return { data: [] }
        },
      },
      session: {
        async get() {
          return { data: { permission: [] } }
        },
        async create() {
          return {
            data: {
              id: "ses_child_blocked",
            },
          }
        },
        async promptAsync() {
          return {}
        },
        async prompt() {
          return {}
        },
        async status() {
          return {
            data: {
              ses_child_blocked: {
                type: "busy",
              },
            },
          }
        },
        async messages() {
          return { data: [] }
        },
        async abort() {
          return {}
        },
      },
    },
    worktree: tmp.path,
    directory: tmp.path,
  })

  await expect(
    plugin.tool.team.execute(
      {
        strategy: "parallel",
        limit: 1,
        tasks: [
          {
            id: "browser",
            prompt: "run browser check",
            write: false,
            worktree: false,
          },
        ],
      },
      {
        sessionID: "ses_parent",
        messageID: "msg_parent",
        agent: "implement",
        directory: tmp.path,
        worktree: tmp.path,
        abort: new AbortController().signal,
        ask: () => Effect.void,
        metadata() {},
      },
    ),
  ).rejects.toThrow("Blocked on permission: bash (Check gstack browse availability)")
})

test("team removes worktree when child prompt fails", async () => {
  await using tmp = await tmpdir({
    git: true,
    init: async (dir) => {
      await Bun.write(path.join(dir, "README.md"), "# test\n")
      await Bun.$`git add README.md`.cwd(dir).quiet()
      await Bun.$`git commit -m "seed"`.cwd(dir).quiet()
    },
  })

  const plugin = await team({
    client: {
      permission: {
        async list() {
          return { data: [] }
        },
      },
      question: {
        async list() {
          return { data: [] }
        },
      },
      session: {
        async get() {
          return {
            data: {
              permission: [],
            },
          }
        },
        async create() {
          return {
            data: {
              id: "ses_child_prompt_fail",
            },
          }
        },
        async promptAsync() {
          throw new Error("prompt failed")
        },
        async prompt() {
          return {}
        },
        async status() {
          return {
            data: {
              ses_child_prompt_fail: {
                type: "idle",
              },
            },
          }
        },
        async messages() {
          return { data: [] }
        },
        async abort() {
          return {}
        },
      },
    },
    worktree: tmp.path,
    directory: tmp.path,
  })

  await expect(
    plugin.tool.team.execute(
      {
        strategy: "parallel",
        limit: 1,
        tasks: [
          {
            id: "prompt-fail",
            prompt: "write a note file",
            write: true,
          },
        ],
      },
      {
        sessionID: "ses_parent",
        messageID: "msg_parent",
        agent: "implement",
        directory: tmp.path,
        worktree: tmp.path,
        abort: new AbortController().signal,
        ask: () => Effect.void,
        metadata() {},
      },
    ),
  ).rejects.toThrow("prompt failed")

  const list = await fs.readdir(path.join(tmp.path, ".opencode", "team"), { withFileTypes: true }).catch(() => [])
  expect(list.filter((item) => item.isDirectory()).length).toBe(0)
})

test("team persists failed runs without leaving tasks nonterminal", async () => {
  await using tmp = await tmpdir({
    git: true,
    init: async (dir) => {
      await Bun.write(path.join(dir, "README.md"), "# test\n")
      await Bun.$`git add README.md`.cwd(dir).quiet()
      await Bun.$`git commit -m "seed"`.cwd(dir).quiet()
    },
  })

  const plugin = await team({
    client: {
      permission: {
        async list() {
          return {
            data: [
              {
                id: "per_blocked_run",
                sessionID: "ses_child_blocked_run",
                permission: "bash",
                patterns: ["npx vite --port 5173"],
                metadata: {
                  description: "Check gstack browse availability",
                },
              },
            ],
          }
        },
      },
      question: {
        async list() {
          return { data: [] }
        },
      },
      session: {
        async get() {
          return { data: { permission: [] } }
        },
        async create() {
          return {
            data: {
              id: "ses_child_blocked_run",
            },
          }
        },
        async promptAsync() {
          return {}
        },
        async prompt() {
          return {}
        },
        async status() {
          return {
            data: {
              ses_child_blocked_run: {
                type: "busy",
              },
            },
          }
        },
        async messages() {
          return { data: [] }
        },
        async abort() {
          return {}
        },
      },
    },
    worktree: tmp.path,
    directory: tmp.path,
  })

  await expect(
    plugin.tool.team.execute(
      {
        strategy: "parallel",
        limit: 1,
        tasks: [
          {
            id: "browser",
            prompt: "run browser check",
            write: false,
            worktree: false,
          },
          {
            id: "follow",
            prompt: "summarize the browser result",
            depends: ["browser"],
            write: false,
            worktree: false,
          },
        ],
      },
      {
        sessionID: "ses_parent",
        messageID: "msg_parent",
        agent: "implement",
        directory: tmp.path,
        worktree: tmp.path,
        abort: new AbortController().signal,
        ask: () => Effect.void,
        metadata() {},
      },
    ),
  ).rejects.toThrow("Blocked on permission: bash (Check gstack browse availability)")

  const root = path.join(tmp.path, ".opencode", "guardrails", "team-runs")
  const list = await fs.readdir(root)
  const saved = JSON.parse(await Bun.file(path.join(root, list[0]!)).text())

  expect(saved.state).toBe("error")
  expect(saved.tasks.map((item: { state: string }) => item.state)).toEqual(["error", "error"])
  expect(saved.tasks.every((item: { state: string }) => item.state === "done" || item.state === "error")).toBe(true)
  expect(saved.tasks[0].failure_stage).toBe("blocked")
  expect(saved.tasks[1].failure_stage).toBe("blocked")
})

test("background surfaces blocked child permissions before returning", async () => {
  await using tmp = await tmpdir({
    git: true,
    init: async (dir) => {
      await Bun.write(path.join(dir, "README.md"), "# test\n")
      await Bun.$`git add README.md`.cwd(dir).quiet()
      await Bun.$`git commit -m "seed"`.cwd(dir).quiet()
    },
  })

  const plugin = await team({
    client: {
      permission: {
        async list() {
          return {
            data: [
              {
                id: "per_bg",
                sessionID: "ses_child_bg",
                permission: "bash",
                patterns: ['osascript -e "beep"'],
                metadata: {
                  description: "background worker",
                },
              },
            ],
          }
        },
      },
      question: {
        async list() {
          return { data: [] }
        },
      },
      session: {
        async get() {
          return { data: { permission: [] } }
        },
        async create() {
          return {
            data: {
              id: "ses_child_bg",
            },
          }
        },
        async promptAsync() {
          return {}
        },
        async prompt() {
          return {}
        },
        async status() {
          return {
            data: {
              ses_child_bg: {
                type: "busy",
              },
            },
          }
        },
        async messages() {
          return { data: [] }
        },
        async abort() {
          return {}
        },
      },
    },
    worktree: tmp.path,
    directory: tmp.path,
  })

  const out = await plugin.tool.background.execute(
    {
      description: "blocked-check",
      prompt: "run the bash command 'osascript -e \"beep\"'",
      write: false,
      worktree: false,
      notify: false,
    },
    {
      sessionID: "ses_parent",
      messageID: "msg_parent",
      agent: "implement",
      directory: tmp.path,
      worktree: tmp.path,
      abort: new AbortController().signal,
      ask: () => Effect.void,
      metadata() {},
    },
  )

  expect(out).toContain("state: error")
  expect(out).toContain("failure_stage=blocked")
})

test("background continues after returning, notifies parent, and team_status reconciles completion", async () => {
  await using tmp = await tmpdir({
    git: true,
    init: async (dir) => {
      await Bun.write(path.join(dir, "README.md"), "# test\n")
      await Bun.$`git add README.md`.cwd(dir).quiet()
      await Bun.$`git commit -m "seed"`.cwd(dir).quiet()
    },
  })

  let complete = false
  let statusCalls = 0
  const notifications: string[] = []
  const metadata: Record<string, unknown>[] = []

  const plugin = await team({
    client: {
      permission: {
        async list() {
          return { data: [] }
        },
      },
      question: {
        async list() {
          return { data: [] }
        },
      },
      session: {
        async get() {
          return { data: { permission: [] } }
        },
        async create() {
          return {
            data: {
              id: "ses_child_background_continue",
            },
          }
        },
        async promptAsync() {
          return {}
        },
        async prompt(input) {
          notifications.push(input.body.parts.map((part) => part.text).join("\n"))
          return {}
        },
        async status() {
          statusCalls += 1
          return {
            data: {
              ses_child_background_continue: {
                type: complete ? "idle" : "busy",
              },
            },
          }
        },
        async messages() {
          return {
            data: complete
              ? [
                  {
                    info: {
                      role: "assistant",
                      time: { completed: Date.now() },
                    },
                    parts: [
                      {
                        type: "text",
                        text: "background finished after parent returned",
                      },
                    ],
                  },
                ]
              : [],
          }
        },
        async abort() {
          return {}
        },
      },
    },
    worktree: tmp.path,
    directory: tmp.path,
  })

  const out = await plugin.tool.background.execute(
    {
      description: "async-background",
      prompt: "Inspect the repository in the background and report completion.",
      write: false,
      worktree: false,
      notify: true,
    },
    {
      sessionID: "ses_parent",
      messageID: "msg_parent",
      agent: "implement",
      directory: tmp.path,
      worktree: tmp.path,
      abort: new AbortController().signal,
      ask: () => Effect.void,
      metadata(input) {
        metadata.push(input.metadata ?? {})
      },
    },
  )

  expect(out).toContain("type: background")
  expect(out).toContain("state: running")
  expect(out).toContain("- async-background: running")
  expect(notifications).toEqual([])
  expect(statusCalls).toBeGreaterThan(0)

  complete = true
  await Background.wait(tmp.path)

  const runID = metadata.find((item): item is { run_id: string } => typeof item.run_id === "string")?.run_id
  expect(runID).toBeTruthy()
  expect(notifications).toHaveLength(1)
  expect(notifications[0]).toContain(`Background run ${runID} completed.`)
  expect(notifications[0]).toContain("output=background finished after parent returned")

  const status = await plugin.tool.team_status.execute(
    { run_id: runID },
    {
      sessionID: "ses_parent",
      messageID: "msg_parent",
      agent: "implement",
      directory: tmp.path,
      worktree: tmp.path,
      abort: new AbortController().signal,
      ask: () => Effect.void,
      metadata() {},
    },
  )

  expect(status).toContain(`run_id: ${runID}`)
  expect(status).toContain("state: done")
  expect(status).toContain("output=background finished after parent returned")
})

test("background failure with notify false is persisted without sending parent prompt", async () => {
  await using tmp = await tmpdir({
    git: true,
    init: async (dir) => {
      await Bun.write(path.join(dir, "README.md"), "# test\n")
      await Bun.$`git add README.md`.cwd(dir).quiet()
      await Bun.$`git commit -m "seed"`.cwd(dir).quiet()
    },
  })

  const notifications: string[] = []
  const metadata: Record<string, unknown>[] = []

  const plugin = await team({
    client: {
      permission: {
        async list() {
          return {
            data: [
              {
                id: "per_bg_notify_false",
                sessionID: "ses_child_background_no_notify",
                permission: "bash",
                patterns: ["deploy production"],
                metadata: {
                  description: "background deployment",
                },
              },
            ],
          }
        },
      },
      question: {
        async list() {
          return { data: [] }
        },
      },
      session: {
        async get() {
          return { data: { permission: [] } }
        },
        async create() {
          return {
            data: {
              id: "ses_child_background_no_notify",
            },
          }
        },
        async promptAsync() {
          return {}
        },
        async prompt(input) {
          notifications.push(input.body.parts.map((part) => part.text).join("\n"))
          return {}
        },
        async status() {
          return {
            data: {
              ses_child_background_no_notify: {
                type: "busy",
              },
            },
          }
        },
        async messages() {
          return { data: [] }
        },
        async abort() {
          return {}
        },
      },
    },
    worktree: tmp.path,
    directory: tmp.path,
  })

  const out = await plugin.tool.background.execute(
    {
      description: "no-notify-failure",
      prompt: "deploy production",
      write: false,
      worktree: false,
      notify: false,
    },
    {
      sessionID: "ses_parent",
      messageID: "msg_parent",
      agent: "implement",
      directory: tmp.path,
      worktree: tmp.path,
      abort: new AbortController().signal,
      ask: () => Effect.void,
      metadata(input) {
        metadata.push(input.metadata ?? {})
      },
    },
  )

  const runID = metadata.find((item): item is { run_id: string } => typeof item.run_id === "string")?.run_id
  expect(runID).toBeTruthy()
  expect(out).toContain("state: error")
  expect(out).toContain("failure_stage=blocked")
  expect(notifications).toEqual([])

  const status = await plugin.tool.team_status.execute(
    { run_id: runID },
    {
      sessionID: "ses_parent",
      messageID: "msg_parent",
      agent: "implement",
      directory: tmp.path,
      worktree: tmp.path,
      abort: new AbortController().signal,
      ask: () => Effect.void,
      metadata() {},
    },
  )

  expect(status).toContain("state: error")
  expect(status).toContain("failure_stage=blocked")
  expect(status).toContain("Blocked on permission: bash (background deployment) :: deploy production")
})

test("team falls back to tool output when child returns no text", async () => {
  await using tmp = await tmpdir({
    git: true,
    init: async (dir) => {
      await Bun.write(path.join(dir, "README.md"), "# test\n")
      await Bun.$`git add README.md`.cwd(dir).quiet()
      await Bun.$`git commit -m "seed"`.cwd(dir).quiet()
    },
  })

  const plugin = await team({
    client: {
      permission: {
        async list() {
          return { data: [] }
        },
      },
      question: {
        async list() {
          return { data: [] }
        },
      },
      session: {
        async get() {
          return { data: { permission: [] } }
        },
        async create() {
          return {
            data: {
              id: "ses_child_tool",
            },
          }
        },
        async promptAsync() {
          return {}
        },
        async prompt() {
          return {}
        },
        async status() {
          return {
            data: {
              ses_child_tool: {
                type: "idle",
              },
            },
          }
        },
        async messages() {
          return {
            data: [
              {
                info: {
                  role: "assistant",
                },
                parts: [
                  {
                    type: "tool",
                    state: {
                      status: "completed",
                      output: "OPEN",
                    },
                  },
                ],
              },
            ],
          }
        },
        async abort() {
          return {}
        },
      },
    },
    worktree: tmp.path,
    directory: tmp.path,
  })

  const out = await plugin.tool.team.execute(
    {
      strategy: "parallel",
      limit: 1,
      tasks: [
        {
          id: "verify",
          prompt: "check issue",
          write: false,
          worktree: false,
        },
      ],
    },
    {
      sessionID: "ses_parent",
      messageID: "msg_parent",
      agent: "implement",
      directory: tmp.path,
      worktree: tmp.path,
      abort: new AbortController().signal,
      ask: () => Effect.void,
      metadata() {},
    },
  )

  expect(out).toContain("output=OPEN")
})

test("team keeps bash enabled for read-only workers and disables recursive delegation", async () => {
  await using tmp = await tmpdir({
    git: true,
    init: async (dir) => {
      await Bun.write(path.join(dir, "README.md"), "# test\n")
      await Bun.$`git add README.md`.cwd(dir).quiet()
      await Bun.$`git commit -m "seed"`.cwd(dir).quiet()
    },
  })

  let tools: Record<string, boolean> | undefined

  const plugin = await team({
    client: {
      permission: {
        async list() {
          return { data: [] }
        },
      },
      question: {
        async list() {
          return { data: [] }
        },
      },
      session: {
        async get() {
          return { data: { permission: [] } }
        },
        async create() {
          return {
            data: {
              id: "ses_child_tools",
            },
          }
        },
        async promptAsync(input) {
          tools = input.body.tools
        },
        async prompt() {
          return {}
        },
        async status() {
          return {
            data: {
              ses_child_tools: {
                type: "idle",
              },
            },
          }
        },
        async messages() {
          return {
            data: [
              {
                info: {
                  role: "assistant",
                },
                parts: [
                  {
                    type: "text",
                    text: "done",
                  },
                ],
              },
            ],
          }
        },
        async abort() {
          return {}
        },
      },
    },
    worktree: tmp.path,
    directory: tmp.path,
  })

  await plugin.tool.team.execute(
    {
      strategy: "parallel",
      limit: 1,
      tasks: [
        {
          id: "verify",
          prompt: "run read-only verification",
          write: false,
          worktree: false,
        },
      ],
    },
    {
      sessionID: "ses_parent",
      messageID: "msg_parent",
      agent: "implement",
      directory: tmp.path,
      worktree: tmp.path,
      abort: new AbortController().signal,
      ask: () => Effect.void,
      metadata() {},
    },
  )

  expect(tools).toEqual({
    edit: false,
    write: false,
    apply_patch: false,
    task: false,
    team: false,
    background: false,
    team_status: false,
    todowrite: false,
  })
})

test("team disables recursive orchestration tools for write workers", async () => {
  await using tmp = await tmpdir({
    git: true,
    init: async (dir) => {
      await Bun.write(path.join(dir, "README.md"), "# test\n")
      await Bun.$`git add README.md`.cwd(dir).quiet()
      await Bun.$`git commit -m "seed"`.cwd(dir).quiet()
    },
  })

  let tools: Record<string, boolean> | undefined

  const plugin = await team({
    client: {
      permission: {
        async list() {
          return { data: [] }
        },
      },
      question: {
        async list() {
          return { data: [] }
        },
      },
      session: {
        async get() {
          return { data: { permission: [] } }
        },
        async create() {
          return {
            data: {
              id: "ses_child_write_tools",
            },
          }
        },
        async promptAsync(input) {
          tools = input.body.tools
          await Bun.write(path.join(input.query.directory, "worker.txt"), "worker output\n")
        },
        async prompt() {
          return {}
        },
        async status() {
          return {
            data: {
              ses_child_write_tools: {
                type: "idle",
              },
            },
          }
        },
        async messages() {
          return {
            data: [
              {
                info: {
                  role: "assistant",
                },
                parts: [
                  {
                    type: "text",
                    text: "done",
                  },
                ],
              },
            ],
          }
        },
        async abort() {
          return {}
        },
      },
    },
    worktree: tmp.path,
    directory: tmp.path,
  })

  await plugin.tool.team.execute(
    {
      strategy: "parallel",
      limit: 1,
      tasks: [
        {
          id: "write-tools",
          prompt: "write a file",
          write: true,
        },
      ],
    },
    {
      sessionID: "ses_parent",
      messageID: "msg_parent",
      agent: "implement",
      directory: tmp.path,
      worktree: tmp.path,
      abort: new AbortController().signal,
      ask: () => Effect.void,
      metadata() {},
    },
  )

  expect(tools).toEqual({
    task: false,
    team: false,
    background: false,
    team_status: false,
  })
})

test("team rewrites nested opencode init prompts to direct bootstrap work", async () => {
  await using tmp = await tmpdir({
    git: true,
    init: async (dir) => {
      await Bun.write(path.join(dir, "README.md"), "# test\n")
      await Bun.$`git add README.md`.cwd(dir).quiet()
      await Bun.$`git commit -m "seed"`.cwd(dir).quiet()
    },
  })

  let prompt = ""

  const plugin = await team({
    client: {
      permission: {
        async list() {
          return { data: [] }
        },
      },
      question: {
        async list() {
          return { data: [] }
        },
      },
      session: {
        async get() {
          return { data: { permission: [] } }
        },
        async create() {
          return {
            data: {
              id: "ses_child_init_rewrite",
            },
          }
        },
        async promptAsync(input) {
          prompt = input.body.parts[0]?.text ?? ""
          await Bun.write(path.join(input.query.directory, "AGENTS.md"), "# test agent instructions\n")
        },
        async prompt() {
          return {}
        },
        async status() {
          return {
            data: {
              ses_child_init_rewrite: {
                type: "idle",
              },
            },
          }
        },
        async messages() {
          return {
            data: [
              {
                info: {
                  role: "assistant",
                },
                parts: [
                  {
                    type: "text",
                    text: "done",
                  },
                ],
              },
            ],
          }
        },
        async abort() {
          return {}
        },
      },
    },
    worktree: tmp.path,
    directory: tmp.path,
  })

  await plugin.tool.team.execute(
    {
      strategy: "parallel",
      limit: 1,
      tasks: [
        {
          id: "run-init",
          prompt: "Use bash to run `opencode run /init` in this isolated worktree and confirm AGENTS.md was created.",
          write: true,
          worktree: true,
        },
      ],
    },
    {
      sessionID: "ses_parent",
      messageID: "msg_parent",
      agent: "implement",
      directory: tmp.path,
      worktree: tmp.path,
      abort: new AbortController().signal,
      ask: () => Effect.void,
      metadata() {},
    },
  )

  expect(prompt).not.toContain("Use bash to run `opencode run /init`")
  expect(prompt).toContain("Worker execution rules:")
  expect(prompt).toContain(
    "perform the equivalent /init repository inspection and AGENTS.md bootstrap directly in this worktree",
  )
  expect(prompt).toContain("Do not invoke nested OpenCode slash commands")
  expect(prompt).toContain("Do not create git branches, clones, nested repositories, or nested worktrees")
  expect(prompt).toContain("operate only on files inside the current worktree directory")
})

test("team surfaces permission.asked events instead of polling forever", async () => {
  await using tmp = await tmpdir({
    git: true,
    init: async (dir) => {
      await Bun.write(path.join(dir, "README.md"), "# test\n")
      await Bun.$`git add README.md`.cwd(dir).quiet()
      await Bun.$`git commit -m "seed"`.cwd(dir).quiet()
    },
  })

  const plugin = await team({
    client: {
      permission: {
        async list() {
          return { data: [] }
        },
      },
      question: {
        async list() {
          return { data: [] }
        },
      },
      event: {
        async subscribe() {
          return {
            stream: (async function* () {
              await Bun.sleep(20)
              yield {
                type: "permission.asked",
                properties: {
                  sessionID: "ses_child_permission_asked",
                  permission: "bash",
                  patterns: ["opencode run /init"],
                },
              }
            })(),
          }
        },
      },
      session: {
        async get() {
          return { data: { permission: [] } }
        },
        async create() {
          return {
            data: {
              id: "ses_child_permission_asked",
            },
          }
        },
        async promptAsync() {
          return {}
        },
        async prompt() {
          return {}
        },
        async status() {
          return {
            data: {
              ses_child_permission_asked: {
                type: "busy",
              },
            },
          }
        },
        async messages() {
          return { data: [] }
        },
        async abort() {
          return {}
        },
      },
    },
    worktree: tmp.path,
    directory: tmp.path,
  })

  await expect(
    plugin.tool.team.execute(
      {
        strategy: "parallel",
        limit: 1,
        tasks: [
          {
            id: "run-init",
            prompt: "rerun opencode init",
            write: true,
            worktree: true,
          },
        ],
      },
      {
        sessionID: "ses_parent",
        messageID: "msg_parent",
        agent: "implement",
        directory: tmp.path,
        worktree: tmp.path,
        abort: new AbortController().signal,
        ask: () => Effect.void,
        metadata() {},
      },
    ),
  ).rejects.toThrow("Blocked on permission: bash :: opencode run /init")
})

test("team surfaces child worktree-local permission asks from guardrail state", async () => {
  await using tmp = await tmpdir({
    git: true,
    init: async (dir) => {
      await Bun.write(path.join(dir, "README.md"), "# test\n")
      await fs.mkdir(path.join(dir, ".opencode", "guardrails"), { recursive: true })
      await Bun.write(
        path.join(dir, ".opencode", "guardrails", "state.json"),
        JSON.stringify({
          last_event: "permission.asked",
          last_permission: "bash",
          last_patterns: ["git ls-tree --name-only -r HEAD"],
        }),
      )
      await Bun.$`git add README.md`.cwd(dir).quiet()
      await Bun.$`git commit -m "seed"`.cwd(dir).quiet()
    },
  })

  const plugin = await team({
    client: {
      permission: {
        async list() {
          return { data: [] }
        },
      },
      question: {
        async list() {
          return { data: [] }
        },
      },
      session: {
        async get() {
          return { data: { permission: [] } }
        },
        async create() {
          return {
            data: {
              id: "ses_child_local_permission",
            },
          }
        },
        async promptAsync() {
          return {}
        },
        async prompt() {
          return {}
        },
        async status() {
          return {
            data: {
              ses_child_local_permission: {
                type: "busy",
              },
            },
          }
        },
        async messages() {
          return { data: [] }
        },
        async abort() {
          return {}
        },
      },
    },
    worktree: tmp.path,
    directory: tmp.path,
  })

  await expect(
    plugin.tool.team.execute(
      {
        strategy: "parallel",
        limit: 1,
        tasks: [
          {
            id: "writer",
            prompt: "write AGENTS.md",
            write: false,
            worktree: false,
          },
        ],
      },
      {
        sessionID: "ses_parent",
        messageID: "msg_parent",
        agent: "implement",
        directory: tmp.path,
        worktree: tmp.path,
        abort: new AbortController().signal,
        ask: () => Effect.void,
        metadata() {},
      },
    ),
  ).rejects.toThrow("Blocked on permission: bash :: git ls-tree --name-only -r HEAD")
})

test("team times out busy child sessions instead of polling forever", async () => {
  const prev = process.env.OPENCODE_TEAM_IDLE_TIMEOUT_MS
  process.env.OPENCODE_TEAM_IDLE_TIMEOUT_MS = "1"
  try {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        await Bun.write(path.join(dir, "README.md"), "# test\n")
        await Bun.$`git add README.md`.cwd(dir).quiet()
        await Bun.$`git commit -m "seed"`.cwd(dir).quiet()
      },
    })

    const plugin = await team({
      client: {
        permission: {
          async list() {
            return { data: [] }
          },
        },
        question: {
          async list() {
            return { data: [] }
          },
        },
        session: {
          async get() {
            return { data: { permission: [] } }
          },
          async create() {
            return {
              data: {
                id: "ses_child_busy_timeout",
              },
            }
          },
          async promptAsync() {
            return {}
          },
          async prompt() {
            return {}
          },
          async status() {
            return {
              data: {
                ses_child_busy_timeout: {
                  type: "busy",
                },
              },
            }
          },
          async messages() {
            return { data: [] }
          },
          async abort() {
            return {}
          },
        },
      },
      worktree: tmp.path,
      directory: tmp.path,
    })

    await expect(
      plugin.tool.team.execute(
        {
          strategy: "parallel",
          limit: 1,
          tasks: [
            {
              id: "busy",
              prompt: "keep working",
              write: false,
              worktree: false,
            },
          ],
        },
        {
          sessionID: "ses_parent",
          messageID: "msg_parent",
          agent: "implement",
          directory: tmp.path,
          worktree: tmp.path,
          abort: new AbortController().signal,
          ask: () => Effect.void,
          metadata() {},
        },
      ),
    ).rejects.toThrow("Timed out waiting for worker session ses_child_busy_timeout")
  } finally {
    if (prev === undefined) delete process.env.OPENCODE_TEAM_IDLE_TIMEOUT_MS
    else process.env.OPENCODE_TEAM_IDLE_TIMEOUT_MS = prev
  }
})

test("team waits when child status is temporarily missing before idle", async () => {
  await using tmp = await tmpdir({
    git: true,
    init: async (dir) => {
      await Bun.write(path.join(dir, "README.md"), "# test\n")
      await Bun.$`git add README.md`.cwd(dir).quiet()
      await Bun.$`git commit -m "seed"`.cwd(dir).quiet()
    },
  })

  let turn = 0

  const plugin = await team({
    client: {
      permission: {
        async list() {
          return { data: [] }
        },
      },
      question: {
        async list() {
          return { data: [] }
        },
      },
      session: {
        async get() {
          return { data: { permission: [] } }
        },
        async create() {
          return {
            data: {
              id: "ses_child_wait",
            },
          }
        },
        async promptAsync() {
          return {}
        },
        async prompt() {
          return {}
        },
        async status() {
          turn += 1
          if (turn === 1) return { data: {} as Record<string, { type: string }> }
          if (turn === 2) {
            return {
              data: {
                ses_child_wait: {
                  type: "busy",
                },
              },
            }
          }
          return {
            data: {
              ses_child_wait: {
                type: "idle",
              },
            },
          }
        },
        async messages() {
          return {
            data: [
              {
                info: {
                  role: "assistant",
                },
                parts: [
                  {
                    type: "text",
                    text: "finished",
                  },
                ],
              },
            ],
          }
        },
        async abort() {
          return {}
        },
      },
    },
    worktree: tmp.path,
    directory: tmp.path,
  })

  const out = await plugin.tool.team.execute(
    {
      strategy: "parallel",
      limit: 1,
      tasks: [
        {
          id: "wait",
          prompt: "wait for child",
          write: false,
          worktree: false,
        },
      ],
    },
    {
      sessionID: "ses_parent",
      messageID: "msg_parent",
      agent: "implement",
      directory: tmp.path,
      worktree: tmp.path,
      abort: new AbortController().signal,
      ask: () => Effect.void,
      metadata() {},
    },
  )

  expect(turn).toBe(3)
  expect(out).toContain("output=finished")
})

test("team ignores parent abort while waiting for child completion", async () => {
  await using tmp = await tmpdir({
    git: true,
    init: async (dir) => {
      await Bun.write(path.join(dir, "README.md"), "# test\n")
      await Bun.$`git add README.md`.cwd(dir).quiet()
      await Bun.$`git commit -m "seed"`.cwd(dir).quiet()
    },
  })

  let turn = 0
  const abort = new AbortController()

  const plugin = await team({
    client: {
      permission: {
        async list() {
          return { data: [] }
        },
      },
      question: {
        async list() {
          return { data: [] }
        },
      },
      session: {
        async get() {
          return { data: { permission: [] } }
        },
        async create() {
          return {
            data: {
              id: "ses_child_gone_idle",
            },
          }
        },
        async promptAsync() {
          return {}
        },
        async prompt() {
          return {}
        },
        async status() {
          turn += 1
          if (turn === 1) {
            return {
              data: {
                ses_child_gone_idle: {
                  type: "busy",
                },
              },
            }
          }
          return {
            data: {
              ses_child_gone_idle: {
                type: "idle",
              },
            },
          }
        },
        async messages() {
          return {
            data: [
              {
                info: {
                  role: "assistant",
                  time: turn > 1 ? { completed: Date.now() } : undefined,
                },
                parts: [
                  {
                    type: "text",
                    text: turn > 1 ? "finished after parent abort" : "Inspecting the repository before editing.",
                  },
                ],
              },
            ],
          }
        },
        async abort() {
          return {}
        },
      },
    },
    worktree: tmp.path,
    directory: tmp.path,
  })

  setTimeout(() => abort.abort(), 1100)

  const out = await plugin.tool.team.execute(
    {
      strategy: "parallel",
      limit: 1,
      tasks: [
        {
          id: "verify",
          prompt: "check repo facts",
          write: false,
          worktree: false,
        },
      ],
    },
    {
      sessionID: "ses_parent",
      messageID: "msg_parent",
      agent: "implement",
      directory: tmp.path,
      worktree: tmp.path,
      abort: abort.signal,
      ask: () => Effect.void,
      metadata() {},
    },
  )

  expect(turn).toBeGreaterThanOrEqual(2)
  expect(out).toContain("- verify: done")
  expect(out).toContain("output=finished after parent abort")
})

test("team treats session.idle event as completion even when status never appears", async () => {
  await using tmp = await tmpdir({
    git: true,
    init: async (dir) => {
      await Bun.write(path.join(dir, "README.md"), "# test\n")
      await Bun.$`git add README.md`.cwd(dir).quiet()
      await Bun.$`git commit -m "seed"`.cwd(dir).quiet()
    },
  })

  const plugin = await team({
    client: {
      permission: {
        async list() {
          return { data: [] }
        },
      },
      question: {
        async list() {
          return { data: [] }
        },
      },
      event: {
        async subscribe() {
          return {
            stream: (async function* () {
              await Bun.sleep(20)
              yield {
                type: "session.idle",
                properties: {
                  sessionID: "ses_child_event_idle",
                },
              }
            })(),
          }
        },
      },
      session: {
        async get() {
          return { data: { permission: [] } }
        },
        async create() {
          return {
            data: {
              id: "ses_child_event_idle",
            },
          }
        },
        async promptAsync() {
          return {}
        },
        async prompt() {
          return {}
        },
        async status() {
          return { data: {} as Record<string, { type: string }> }
        },
        async messages() {
          return {
            data: [
              {
                info: {
                  role: "assistant",
                },
                parts: [
                  {
                    type: "text",
                    text: "finished",
                  },
                ],
              },
            ],
          }
        },
        async abort() {
          return {}
        },
      },
    },
    worktree: tmp.path,
    directory: tmp.path,
  })

  const out = await plugin.tool.team.execute(
    {
      strategy: "parallel",
      limit: 1,
      tasks: [
        {
          id: "verify",
          prompt: "check repo facts",
          write: false,
          worktree: false,
        },
      ],
    },
    {
      sessionID: "ses_parent",
      messageID: "msg_parent",
      agent: "implement",
      directory: tmp.path,
      worktree: tmp.path,
      abort: new AbortController().signal,
      ask: () => Effect.void,
      metadata() {},
    },
  )

  expect(out).toContain("- verify: done")
  expect(out).toContain("output=finished")
})

test("team treats completed assistant messages as completion even when status stays busy", async () => {
  await using tmp = await tmpdir({
    git: true,
    init: async (dir) => {
      await Bun.write(path.join(dir, "README.md"), "# test\n")
      await Bun.$`git add README.md`.cwd(dir).quiet()
      await Bun.$`git commit -m "seed"`.cwd(dir).quiet()
    },
  })

  const plugin = await team({
    client: {
      permission: {
        async list() {
          return { data: [] }
        },
      },
      question: {
        async list() {
          return { data: [] }
        },
      },
      session: {
        async get() {
          return { data: { permission: [] } }
        },
        async create() {
          return {
            data: {
              id: "ses_child_completed_busy",
            },
          }
        },
        async promptAsync() {
          return {}
        },
        async prompt() {
          return {}
        },
        async status() {
          return {
            data: {
              ses_child_completed_busy: {
                type: "busy",
              },
            },
          }
        },
        async messages() {
          return {
            data: [
              {
                info: {
                  role: "assistant",
                  time: {
                    completed: Date.now(),
                  },
                },
                parts: [
                  {
                    type: "text",
                    text: "finished from completed message",
                  },
                ],
              },
            ],
          }
        },
        async abort() {
          return {}
        },
      },
    },
    worktree: tmp.path,
    directory: tmp.path,
  })

  const out = await plugin.tool.team.execute(
    {
      strategy: "parallel",
      limit: 1,
      tasks: [
        {
          id: "verify",
          prompt: "check repo facts",
          write: false,
          worktree: false,
        },
      ],
    },
    {
      sessionID: "ses_parent",
      messageID: "msg_parent",
      agent: "implement",
      directory: tmp.path,
      worktree: tmp.path,
      abort: new AbortController().signal,
      ask: () => Effect.void,
      metadata() {},
    },
  )

  expect(out).toContain("- verify: done")
  expect(out).toContain("output=finished from completed message")
})

test("team waits past completed tool-call assistant messages", async () => {
  await using tmp = await tmpdir({
    git: true,
    init: async (dir) => {
      await Bun.write(path.join(dir, "README.md"), "# test\n")
      await Bun.$`git add README.md`.cwd(dir).quiet()
      await Bun.$`git commit -m "seed"`.cwd(dir).quiet()
    },
  })

  let messages = 0
  const plugin = await team({
    client: {
      permission: {
        async list() {
          return { data: [] }
        },
      },
      question: {
        async list() {
          return { data: [] }
        },
      },
      session: {
        async get() {
          return { data: { permission: [] } }
        },
        async create() {
          return {
            data: {
              id: "ses_child_tool_calls_then_done",
            },
          }
        },
        async promptAsync() {
          return {}
        },
        async prompt() {
          return {}
        },
        async status() {
          return {
            data: {
              ses_child_tool_calls_then_done: {
                type: "busy",
              },
            },
          }
        },
        async messages() {
          messages += 1
          return {
            data: [
              messages < 2
                ? {
                    info: {
                      role: "assistant",
                      finish: "tool-calls",
                      time: {
                        completed: Date.now(),
                      },
                    },
                    parts: [
                      {
                        type: "tool",
                        state: {
                          status: "completed",
                          output: "git worktree list output",
                        },
                      },
                    ],
                  }
                : {
                    info: {
                      role: "assistant",
                      time: {
                        completed: Date.now(),
                      },
                    },
                    parts: [
                      {
                        type: "text",
                        text: "finished after tool call",
                      },
                    ],
                  },
            ],
          }
        },
        async abort() {
          return {}
        },
      },
    },
    worktree: tmp.path,
    directory: tmp.path,
  })

  const out = await plugin.tool.team.execute(
    {
      strategy: "parallel",
      limit: 1,
      tasks: [
        {
          id: "verify",
          prompt: "check repo facts",
          write: false,
          worktree: false,
        },
      ],
    },
    {
      sessionID: "ses_parent",
      messageID: "msg_parent",
      agent: "implement",
      directory: tmp.path,
      worktree: tmp.path,
      abort: new AbortController().signal,
      ask: () => Effect.void,
      metadata() {},
    },
  )

  expect(messages).toBeGreaterThanOrEqual(2)
  expect(out).toContain("- verify: done")
  expect(out).toContain("output=finished after tool call")
})

test("team retries event subscriptions before consuming session.idle", async () => {
  await using tmp = await tmpdir({
    git: true,
    init: async (dir) => {
      await Bun.write(path.join(dir, "README.md"), "# test\n")
      await Bun.$`git add README.md`.cwd(dir).quiet()
      await Bun.$`git commit -m "seed"`.cwd(dir).quiet()
    },
  })

  let calls = 0

  const plugin = await team({
    client: {
      permission: {
        async list() {
          return { data: [] }
        },
      },
      question: {
        async list() {
          return { data: [] }
        },
      },
      event: {
        async subscribe() {
          calls += 1
          if (calls === 1)
            return {} as { stream: AsyncIterable<{ type?: string; properties?: Record<string, unknown> }> }
          return {
            stream: (async function* () {
              await Bun.sleep(20)
              yield {
                type: "session.idle",
                properties: {
                  sessionID: "ses_child_retry_idle",
                },
              }
            })(),
          }
        },
      },
      session: {
        async get() {
          return { data: { permission: [] } }
        },
        async create() {
          return {
            data: {
              id: "ses_child_retry_idle",
            },
          }
        },
        async promptAsync() {
          return {}
        },
        async prompt() {
          return {}
        },
        async status() {
          return { data: {} as Record<string, { type: string }> }
        },
        async messages() {
          return { data: [] }
        },
        async abort() {
          return {}
        },
      },
    },
    worktree: tmp.path,
    directory: tmp.path,
  })

  const out = await plugin.tool.team.execute(
    {
      strategy: "parallel",
      limit: 1,
      tasks: [
        {
          id: "verify",
          prompt: "check repo facts",
          write: false,
          worktree: false,
        },
      ],
    },
    {
      sessionID: "ses_parent",
      messageID: "msg_parent",
      agent: "implement",
      directory: tmp.path,
      worktree: tmp.path,
      abort: new AbortController().signal,
      ask: () => Effect.void,
      metadata() {},
    },
  )

  expect(calls).toBeGreaterThanOrEqual(2)
  expect(out).toContain("- verify: done")
})

test("team_status reconciles stale running runs from completed child messages", async () => {
  await using tmp = await tmpdir({
    git: true,
    init: async (dir) => {
      await Bun.write(path.join(dir, "README.md"), "# test\n")
      await fs.mkdir(path.join(dir, ".opencode", "guardrails", "team-runs"), { recursive: true })
      await Bun.write(
        path.join(dir, ".opencode", "guardrails", "team-runs", "run-1.json"),
        JSON.stringify(
          {
            id: "run-1",
            kind: "team",
            state: "running",
            session: "ses_parent",
            directory: dir,
            created_at: new Date(0).toISOString(),
            updated_at: new Date(0).toISOString(),
            tasks: [
              {
                id: "verify",
                description: "verify",
                prompt: "check repo facts",
                depends: [],
                agent: "explore",
                write: false,
                worktree: false,
                provider: "openai",
                model: "gpt-5.5",
                variant: "high",
                state: "running",
                dir,
                session: "ses_child_stale_run",
                patch: "",
                output: "",
                error: "",
              },
            ],
          },
          null,
          2,
        ) + "\n",
      )
      await Bun.$`git add README.md`.cwd(dir).quiet()
      await Bun.$`git commit -m "seed"`.cwd(dir).quiet()
    },
  })

  const plugin = await team({
    client: {
      permission: {
        async list() {
          return { data: [] }
        },
      },
      question: {
        async list() {
          return { data: [] }
        },
      },
      session: {
        async get() {
          return { data: { permission: [] } }
        },
        async create() {
          return { data: { id: "unused" } }
        },
        async promptAsync() {
          return {}
        },
        async prompt() {
          return {}
        },
        async status() {
          return {
            data: {
              ses_child_stale_run: {
                type: "busy",
              },
            },
          }
        },
        async messages() {
          return {
            data: [
              {
                info: {
                  role: "assistant",
                  time: {
                    completed: Date.now(),
                  },
                },
                parts: [
                  {
                    type: "text",
                    text: "stale run completed",
                  },
                ],
              },
            ],
          }
        },
        async abort() {
          return {}
        },
      },
    },
    worktree: tmp.path,
    directory: tmp.path,
  })

  const out = await plugin.tool.team_status.execute(
    {},
    {
      sessionID: "ses_parent",
      messageID: "msg_parent",
      agent: "implement",
      directory: tmp.path,
      worktree: tmp.path,
      abort: new AbortController().signal,
      ask: () => Effect.void,
      metadata() {},
    },
  )

  const saved = JSON.parse(
    await Bun.file(path.join(tmp.path, ".opencode", "guardrails", "team-runs", "run-1.json")).text(),
  )
  expect(out).toContain("run_id: run-1")
  expect(out).toContain("state: done")
  expect(out).toContain("output=stale run completed")
  expect(saved.state).toBe("done")
  expect(saved.tasks[0].state).toBe("done")
  expect(saved.tasks[0].output).toBe("stale run completed")
})

test("team execute sweeps stale running runs before launching new work", async () => {
  await using tmp = await tmpdir({
    git: true,
    init: async (dir) => {
      await Bun.write(path.join(dir, "README.md"), "# test\n")
      await fs.mkdir(path.join(dir, ".opencode", "guardrails", "team-runs"), { recursive: true })
      await Bun.write(
        path.join(dir, ".opencode", "guardrails", "team-runs", "stale-run.json"),
        JSON.stringify(
          {
            id: "stale-run",
            kind: "team",
            state: "running",
            session: "ses_parent",
            directory: dir,
            created_at: new Date(0).toISOString(),
            updated_at: new Date(0).toISOString(),
            tasks: [
              {
                id: "stale",
                description: "stale",
                prompt: "old work",
                depends: [],
                agent: "general",
                write: false,
                worktree: false,
                provider: "openai",
                model: "gpt-5.5",
                variant: "high",
                state: "running",
                dir,
                session: "ses_child_stale_run_execute",
                patch: "",
                output: "",
                error: "",
              },
            ],
          },
          null,
          2,
        ) + "\n",
      )
      await Bun.$`git add README.md`.cwd(dir).quiet()
      await Bun.$`git commit -m "seed"`.cwd(dir).quiet()
    },
  })

  let created = 0

  const plugin = await team({
    client: {
      permission: {
        async list() {
          return { data: [] }
        },
      },
      question: {
        async list() {
          return { data: [] }
        },
      },
      session: {
        async get() {
          return { data: { permission: [] } }
        },
        async create() {
          created += 1
          return { data: { id: "ses_child_new_execute" } }
        },
        async promptAsync() {
          return {}
        },
        async prompt() {
          return {}
        },
        async status() {
          return {
            data: {
              ses_child_stale_run_execute: { type: "busy" },
              ses_child_new_execute: { type: "idle" },
            },
          }
        },
        async messages(input) {
          if (input.path.id === "ses_child_stale_run_execute") {
            return {
              data: [
                {
                  info: {
                    role: "assistant",
                    time: {
                      completed: Date.now(),
                    },
                  },
                  parts: [
                    {
                      type: "text",
                      text: "stale execute completed",
                    },
                  ],
                },
              ],
            }
          }
          return {
            data: [
              {
                info: {
                  role: "assistant",
                  time: {
                    completed: Date.now(),
                  },
                },
                parts: [
                  {
                    type: "text",
                    text: "fresh execute completed",
                  },
                ],
              },
            ],
          }
        },
        async abort() {
          return {}
        },
      },
    },
    worktree: tmp.path,
    directory: tmp.path,
  })

  const out = await plugin.tool.team.execute(
    {
      strategy: "parallel",
      limit: 1,
      tasks: [
        {
          id: "fresh",
          prompt: "new read-only work",
          write: false,
          worktree: false,
        },
      ],
    },
    {
      sessionID: "ses_parent",
      messageID: "msg_parent",
      agent: "implement",
      directory: tmp.path,
      worktree: tmp.path,
      abort: new AbortController().signal,
      ask: () => Effect.void,
      metadata() {},
    },
  )

  const stale = JSON.parse(
    await Bun.file(path.join(tmp.path, ".opencode", "guardrails", "team-runs", "stale-run.json")).text(),
  )
  expect(created).toBe(1)
  expect(out).toContain("- fresh: done")
  expect(stale.state).toBe("done")
  expect(stale.tasks[0].state).toBe("done")
  expect(stale.tasks[0].output).toBe("stale execute completed")
})

test("team startup sweep reconciles stale runs without explicit tool use", async () => {
  await using tmp = await tmpdir({
    git: true,
    init: async (dir) => {
      await Bun.write(path.join(dir, "README.md"), "# test\n")
      await fs.mkdir(path.join(dir, ".opencode", "guardrails", "team-runs"), { recursive: true })
      await Bun.write(
        path.join(dir, ".opencode", "guardrails", "team-runs", "startup-stale.json"),
        JSON.stringify(
          {
            id: "startup-stale",
            kind: "team",
            state: "running",
            session: "ses_parent",
            directory: dir,
            created_at: new Date(0).toISOString(),
            updated_at: new Date(0).toISOString(),
            tasks: [
              {
                id: "stale",
                description: "stale",
                prompt: "old work",
                depends: [],
                agent: "general",
                write: false,
                worktree: false,
                provider: "openai",
                model: "gpt-5.5",
                variant: "high",
                state: "running",
                dir,
                session: "ses_child_startup_stale",
                patch: "",
                output: "",
                error: "",
              },
            ],
          },
          null,
          2,
        ) + "\n",
      )
      await Bun.$`git add README.md`.cwd(dir).quiet()
      await Bun.$`git commit -m "seed"`.cwd(dir).quiet()
    },
  })

  await team({
    client: {
      permission: {
        async list() {
          return { data: [] }
        },
      },
      question: {
        async list() {
          return { data: [] }
        },
      },
      session: {
        async get() {
          return { data: { permission: [] } }
        },
        async create() {
          return { data: { id: "unused" } }
        },
        async promptAsync() {
          return {}
        },
        async prompt() {
          return {}
        },
        async status() {
          return {
            data: {
              ses_child_startup_stale: { type: "busy" },
            },
          }
        },
        async messages() {
          return {
            data: [
              {
                info: {
                  role: "assistant",
                  time: {
                    completed: Date.now(),
                  },
                },
                parts: [
                  {
                    type: "text",
                    text: "startup stale completed",
                  },
                ],
              },
            ],
          }
        },
        async abort() {
          return {}
        },
      },
    },
    worktree: tmp.path,
    directory: tmp.path,
  })

  for (let i = 0; i < 20; i += 1) {
    const stale = JSON.parse(
      await Bun.file(path.join(tmp.path, ".opencode", "guardrails", "team-runs", "startup-stale.json")).text(),
    )
    if (stale.state === "done") {
      expect(stale.tasks[0].state).toBe("done")
      expect(stale.tasks[0].output).toBe("startup stale completed")
      return
    }
    await Bun.sleep(50)
  }

  throw new Error("startup sweep did not reconcile stale run")
})

test("chat.message hook also sweeps stale runs during normal lifecycle", async () => {
  await using tmp = await tmpdir({
    git: true,
    init: async (dir) => {
      await Bun.write(path.join(dir, "README.md"), "# test\n")
      await fs.mkdir(path.join(dir, ".opencode", "guardrails", "team-runs"), { recursive: true })
      await Bun.write(
        path.join(dir, ".opencode", "guardrails", "team-runs", "chat-stale.json"),
        JSON.stringify(
          {
            id: "chat-stale",
            kind: "team",
            state: "running",
            session: "ses_parent",
            directory: dir,
            created_at: new Date(0).toISOString(),
            updated_at: new Date(0).toISOString(),
            tasks: [
              {
                id: "stale",
                description: "stale",
                prompt: "old work",
                depends: [],
                agent: "general",
                write: false,
                worktree: false,
                provider: "openai",
                model: "gpt-5.5",
                variant: "high",
                state: "running",
                dir,
                session: "ses_child_chat_stale",
                patch: "",
                output: "",
                error: "",
              },
            ],
          },
          null,
          2,
        ) + "\n",
      )
      await Bun.$`git add README.md`.cwd(dir).quiet()
      await Bun.$`git commit -m "seed"`.cwd(dir).quiet()
    },
  })

  const plugin = await team({
    client: {
      permission: {
        async list() {
          return { data: [] }
        },
      },
      question: {
        async list() {
          return { data: [] }
        },
      },
      session: {
        async get() {
          return { data: { permission: [] } }
        },
        async create() {
          return { data: { id: "unused" } }
        },
        async promptAsync() {
          return {}
        },
        async prompt() {
          return {}
        },
        async status() {
          return {
            data: {
              ses_child_chat_stale: { type: "busy" },
            },
          }
        },
        async messages() {
          return {
            data: [
              {
                info: {
                  role: "assistant",
                  time: {
                    completed: Date.now(),
                  },
                },
                parts: [
                  {
                    type: "text",
                    text: "chat stale completed",
                  },
                ],
              },
            ],
          }
        },
        async abort() {
          return {}
        },
      },
    },
    worktree: tmp.path,
    directory: tmp.path,
  })

  await plugin["chat.message"]?.(
    {
      sessionID: "ses_parent",
      agent: "implement",
    },
    {
      message: {
        id: "msg_parent",
        sessionID: "ses_parent",
        role: "user",
      },
      parts: [
        {
          type: "text",
          text: "Please inspect the repo and tell me what to change.",
        },
      ],
    },
  )

  for (let i = 0; i < 20; i += 1) {
    const stale = JSON.parse(
      await Bun.file(path.join(tmp.path, ".opencode", "guardrails", "team-runs", "chat-stale.json")).text(),
    )
    if (stale.state === "done") {
      expect(stale.tasks[0].state).toBe("done")
      expect(stale.tasks[0].output).toBe("chat stale completed")
      return
    }
    await Bun.sleep(50)
  }

  throw new Error("chat.message sweep did not reconcile stale run")
})

test("parallel enforcement ignores operation-only commit push PR requests", async () => {
  await using tmp = await tmpdir({
    git: true,
    init: async (dir) => {
      await Bun.write(path.join(dir, "README.md"), "# test\n")
      await Bun.$`git add README.md`.cwd(dir).quiet()
      await Bun.$`git commit -m "seed"`.cwd(dir).quiet()
    },
  })

  const plugin = await team({
    client: {
      permission: {
        async list() {
          return { data: [] }
        },
      },
      question: {
        async list() {
          return { data: [] }
        },
      },
      session: {
        async get() {
          return { data: { permission: [] } }
        },
        async create() {
          return { data: { id: "unused" } }
        },
        async promptAsync() {
          return {}
        },
        async prompt() {
          return {}
        },
        async status() {
          return { data: {} }
        },
        async messages() {
          return { data: [] }
        },
        async abort() {
          return {}
        },
      },
    },
    worktree: tmp.path,
    directory: tmp.path,
  })

  const parts = [
    {
      type: "text",
      text:
        `${"Please review the completed local changes and summarize the current state. ".repeat(12)}\n` +
        "Then commit the prepared changes, push the branch, and create the pull request with gh pr create.",
    },
  ]

  await plugin["chat.message"]?.(
    {
      sessionID: "ses_operation_only",
      agent: "implement",
    },
    {
      message: {
        id: "msg_operation_only",
        sessionID: "ses_operation_only",
        role: "user",
      },
      parts,
    },
  )

  expect(parts.some((part) => part.text?.includes("Parallel implementation policy is active"))).toBe(false)
  await expect(
    plugin["tool.execute.before"]?.(
      {
        tool: "write",
        sessionID: "ses_operation_only",
      },
      {
        args: {
          filePath: "completion.md",
        },
      },
    ),
  ).resolves.toBeUndefined()
})

test("parallel enforcement does not re-arm after team failure for the same user message", async () => {
  await using tmp = await tmpdir({
    git: true,
    init: async (dir) => {
      await Bun.write(path.join(dir, "README.md"), "# test\n")
      await Bun.$`git add README.md`.cwd(dir).quiet()
      await Bun.$`git commit -m "seed"`.cwd(dir).quiet()
    },
  })

  const plugin = await team({
    client: {
      permission: {
        async list() {
          return { data: [] }
        },
      },
      question: {
        async list() {
          return { data: [] }
        },
      },
      session: {
        async get() {
          return { data: { permission: [] } }
        },
        async create() {
          return { data: { id: "unused" } }
        },
        async promptAsync() {
          return {}
        },
        async prompt() {
          return {}
        },
        async status() {
          return { data: {} }
        },
        async messages() {
          return { data: [] }
        },
        async abort() {
          return {}
        },
      },
    },
    worktree: tmp.path,
    directory: tmp.path,
  })

  const text =
    `${"Implement coordinated fixes across packages/guardrails and packages/opencode with tests. ".repeat(10)}\n` +
    "This is a multi-file implementation and should use the team tool."

  const makeParts = () => [
    {
      type: "text",
      text,
    },
  ]

  const first = makeParts()
  await plugin["chat.message"]?.(
    {
      sessionID: "ses_rearm",
      agent: "implement",
    },
    {
      message: {
        id: "msg_rearm_1",
        sessionID: "ses_rearm",
        role: "user",
      },
      parts: first,
    },
  )

  expect(first.some((part) => part.text?.includes("Parallel implementation policy is active"))).toBe(true)
  await expect(
    plugin["tool.execute.before"]?.(
      {
        tool: "write",
        sessionID: "ses_rearm",
      },
      {
        args: {
          filePath: "blocked.md",
        },
      },
    ),
  ).rejects.toThrow("Parallel implementation is enforced")

  await plugin["tool.execute.error"]?.(
    {
      tool: "team",
      sessionID: "ses_rearm",
    },
    {
      error: new Error("team failed"),
    },
  )

  const second = makeParts()
  await plugin["chat.message"]?.(
    {
      sessionID: "ses_rearm",
      agent: "implement",
    },
    {
      message: {
        id: "msg_rearm_2",
        sessionID: "ses_rearm",
        role: "user",
      },
      parts: second,
    },
  )

  expect(second.some((part) => part.text?.includes("Parallel implementation policy is active"))).toBe(false)
  await expect(
    plugin["tool.execute.before"]?.(
      {
        tool: "write",
        sessionID: "ses_rearm",
      },
      {
        args: {
          filePath: "allowed.md",
        },
      },
    ),
  ).resolves.toBeUndefined()
})

test("team merge excludes runtime artifacts and leaves unrelated parent edits untouched", async () => {
  await using tmp = await tmpdir({
    git: true,
    init: async (dir) => {
      await Bun.write(path.join(dir, "README.md"), "# test\n")
      await Bun.$`git add README.md`.cwd(dir).quiet()
      await Bun.$`git commit -m "seed"`.cwd(dir).quiet()
      await Bun.write(path.join(dir, "local-note.txt"), "keep me local\n")
    },
  })

  let box = ""

  const plugin = await team({
    client: {
      permission: {
        async list() {
          return { data: [] }
        },
      },
      question: {
        async list() {
          return { data: [] }
        },
      },
      session: {
        async get() {
          return { data: { permission: [] } }
        },
        async create() {
          return {
            data: {
              id: "ses_child_runtime_merge",
            },
          }
        },
        async promptAsync(input) {
          box = input.query.directory
          await fs.mkdir(path.join(box, ".opencode", "guardrails"), { recursive: true })
          await fs.mkdir(path.join(box, ".opencode", "memory"), { recursive: true })
          await Bun.write(path.join(box, ".opencode", "guardrails", "state.json"), `{"last_event":"permission.asked"}`)
          await Bun.write(path.join(box, ".opencode", "memory", "MEMORY.md"), "# runtime memory\n")
          await Bun.write(path.join(box, "worker.txt"), "worker output\n")
          return {}
        },
        async prompt() {
          return {}
        },
        async status() {
          return {
            data: {
              ses_child_runtime_merge: {
                type: "idle",
              },
            },
          }
        },
        async messages() {
          return {
            data: [
              {
                info: {
                  role: "assistant",
                  time: {
                    completed: Date.now(),
                  },
                },
                parts: [
                  {
                    type: "text",
                    text: "worker finished",
                  },
                ],
              },
            ],
          }
        },
        async abort() {
          return {}
        },
      },
    },
    worktree: tmp.path,
    directory: tmp.path,
  })

  const out = await plugin.tool.team.execute(
    {
      strategy: "parallel",
      limit: 1,
      tasks: [
        {
          id: "merge-runtime",
          prompt: "write worker output",
          write: true,
          worktree: true,
        },
      ],
    },
    {
      sessionID: "ses_parent",
      messageID: "msg_parent",
      agent: "implement",
      directory: tmp.path,
      worktree: tmp.path,
      abort: new AbortController().signal,
      ask: () => Effect.void,
      metadata() {},
    },
  )

  expect(out).toContain("merge-runtime: done")
  expect(box).toContain(path.join(".opencode", "team"))
  expect(await Bun.file(path.join(tmp.path, "worker.txt")).text()).toBe("worker output\n")
  expect(await Bun.file(path.join(tmp.path, ".opencode", "guardrails", "state.json")).exists()).toBe(false)
  expect(await Bun.file(path.join(tmp.path, ".opencode", "memory", "MEMORY.md")).exists()).toBe(false)

  const statusWorker = await Bun.$`git status --porcelain -- worker.txt`.cwd(tmp.path).text()
  const statusLocal = await Bun.$`git status --porcelain -- local-note.txt`.cwd(tmp.path).text()
  expect(statusWorker.trim()).toBe("")
  expect(statusLocal.trim()).toBe("?? local-note.txt")

  const patches = (await fs.readdir(path.join(tmp.path, ".opencode", "guardrails", "team-runs"))).filter((item) =>
    item.endsWith(".patch"),
  )
  expect(patches.length).toBeGreaterThan(0)
  const patchBody = await Bun.file(path.join(tmp.path, ".opencode", "guardrails", "team-runs", patches[0]!)).text()
  expect(patchBody).toContain("worker.txt")
  expect(patchBody).not.toContain(".opencode/guardrails/state.json")
  expect(patchBody).not.toContain(".opencode/memory/MEMORY.md")
})

test("team merge_back reports parent dirty overlap before git apply index failure", async () => {
  await using tmp = await tmpdir({
    git: true,
    init: async (dir) => {
      await Bun.write(path.join(dir, "route.test.ts"), "base\n")
      await Bun.$`git add route.test.ts`.cwd(dir).quiet()
      await Bun.$`git commit -m "seed"`.cwd(dir).quiet()
      await Bun.write(path.join(dir, "route.test.ts"), "parent edit\n")
    },
  })

  let box = ""
  const plugin = await team({
    client: {
      permission: {
        async list() {
          return { data: [] }
        },
      },
      question: {
        async list() {
          return { data: [] }
        },
      },
      session: {
        async get() {
          return { data: { permission: [] } }
        },
        async create() {
          return { data: { id: "ses_dirty_overlap" } }
        },
        async promptAsync(input) {
          box = input.query.directory
          await Bun.write(path.join(box, "route.test.ts"), "worker edit\n")
          return {}
        },
        async prompt() {
          return {}
        },
        async status() {
          return {
            data: {
              ses_dirty_overlap: {
                type: "idle",
              },
            },
          }
        },
        async messages() {
          return {
            data: [
              {
                info: {
                  role: "assistant",
                  time: { completed: Date.now() },
                },
                parts: [
                  {
                    type: "text",
                    text: "worker finished",
                  },
                ],
              },
            ],
          }
        },
        async abort() {
          return {}
        },
      },
    },
    worktree: tmp.path,
    directory: tmp.path,
  })

  await expect(
    plugin.tool.team.execute(
      {
        strategy: "parallel",
        limit: 1,
        tasks: [
          {
            id: "dirty-overlap",
            prompt: "fix route test",
            write: true,
            worktree: true,
          },
        ],
      },
      {
        sessionID: "ses_parent",
        messageID: "msg_parent",
        agent: "implement",
        directory: tmp.path,
        worktree: tmp.path,
        abort: new AbortController().signal,
        ask: () => Effect.void,
        metadata() {},
      },
    ),
  ).rejects.toThrow("Parent worktree has uncommitted changes in worker-touched file(s): route.test.ts")

  expect(box).toContain(path.join(".opencode", "team"))
  expect(await Bun.file(path.join(tmp.path, "route.test.ts")).text()).toBe("parent edit\n")
  const patches = (await fs.readdir(path.join(tmp.path, ".opencode", "guardrails", "team-runs"))).filter((item) =>
    item.endsWith(".patch"),
  )
  expect(patches.length).toBeGreaterThan(0)
  const patchBody = await Bun.file(path.join(tmp.path, ".opencode", "guardrails", "team-runs", patches[0]!)).text()
  expect(patchBody).toContain("worker edit")
})

test("team uses an existing sibling git worktree mentioned in the task prompt", async () => {
  await using tmp = await tmpdir({
    git: true,
    init: async (dir) => {
      await Bun.write(path.join(dir, "README.md"), "# test\n")
      await Bun.$`git add README.md`.cwd(dir).quiet()
      await Bun.$`git commit -m "seed"`.cwd(dir).quiet()
    },
  })

  const target = path.join(path.dirname(tmp.path), `opencode-existing-worktree-${crypto.randomUUID()}`)
  await Bun.$`git worktree add --detach ${target} HEAD`.cwd(tmp.path).quiet()

  let box = ""
  try {
    const plugin = await team({
      client: {
        permission: {
          async list() {
            return { data: [] }
          },
        },
        question: {
          async list() {
            return { data: [] }
          },
        },
        session: {
          async get() {
            return { data: { permission: [] } }
          },
          async create(input) {
            box = input.query.directory
            return {
              data: {
                id: "ses_existing_worktree",
              },
            }
          },
          async promptAsync(input) {
            expect(input.query.directory).toBe(await fs.realpath(target))
            await Bun.write(path.join(input.query.directory, "worker.txt"), "worker output\n")
            return {}
          },
          async prompt() {
            return {}
          },
          async status() {
            return {
              data: {
                ses_existing_worktree: {
                  type: "idle",
                },
              },
            }
          },
          async messages() {
            return {
              data: [
                {
                  info: {
                    role: "assistant",
                    time: {
                      completed: Date.now(),
                    },
                  },
                  parts: [
                    {
                      type: "text",
                      text: "worker finished",
                    },
                  ],
                },
              ],
            }
          },
          async abort() {
            return {}
          },
        },
      },
      worktree: tmp.path,
      directory: tmp.path,
    })

    const out = await plugin.tool.team.execute(
      {
        strategy: "parallel",
        limit: 1,
        tasks: [
          {
            id: "existing-worktree",
            prompt: `You are working in a **git worktree** at:\n\`${target}\`\n\nModify worker.txt.`,
            write: true,
            worktree: true,
          },
        ],
      },
      {
        sessionID: "ses_parent",
        messageID: "msg_parent",
        agent: "implement",
        directory: tmp.path,
        worktree: tmp.path,
        abort: new AbortController().signal,
        ask: () => Effect.void,
        metadata() {},
      },
    )

    expect(box).toBe(await fs.realpath(target))
    expect(box).not.toContain(path.join(".opencode", "team"))
    expect(await Bun.file(path.join(target, "worker.txt")).text()).toBe("worker output\n")
    expect(out).toContain("existing-worktree: done")
    expect(out).not.toContain("no_patch=true")
  } finally {
    await Bun.$`git worktree remove --force ${target}`
      .cwd(tmp.path)
      .quiet()
      .catch(() => undefined)
    await fs.rm(target, { recursive: true, force: true })
  }
})

test("team merges changes from an existing .opencode worktree mentioned in the task prompt", async () => {
  await using tmp = await tmpdir({
    git: true,
    init: async (dir) => {
      await Bun.write(path.join(dir, "README.md"), "# test\n")
      await Bun.$`git add README.md`.cwd(dir).quiet()
      await Bun.$`git commit -m "seed"`.cwd(dir).quiet()
    },
  })

  const target = path.join(path.dirname(tmp.path), ".opencode", "worktrees", `team-shared-${crypto.randomUUID()}`)
  await fs.mkdir(path.dirname(target), { recursive: true })
  await Bun.$`git worktree add --detach ${target} HEAD`.cwd(tmp.path).quiet()

  let box = ""
  try {
    const plugin = await team({
      client: {
        permission: {
          async list() {
            return { data: [] }
          },
        },
        question: {
          async list() {
            return { data: [] }
          },
        },
        session: {
          async get() {
            return { data: { permission: [] } }
          },
          async create() {
            return {
              data: {
                id: "ses_existing_opencode_worktree",
              },
            }
          },
          async promptAsync(input) {
            box = input.query.directory
            expect(box).toBe(target)
            await Bun.write(path.join(target, "shared-worker.txt"), "shared worker output\n")
          },
          async prompt() {
            return {}
          },
          async status() {
            return {
              data: {
                ses_existing_opencode_worktree: {
                  type: "idle",
                },
              },
            }
          },
          async messages() {
            return {
              data: [
                {
                  info: {
                    role: "assistant",
                    time: { completed: Date.now() },
                  },
                  parts: [
                    {
                      type: "text",
                      text: "done",
                    },
                  ],
                },
              ],
            }
          },
          async abort() {
            return {}
          },
        },
      },
      worktree: tmp.path,
      directory: tmp.path,
    })

    const out = await plugin.tool.team.execute(
      {
        strategy: "parallel",
        limit: 1,
        tasks: [
          {
            id: "shared-worktree",
            prompt: `You are working in a **git worktree** at:\n\`${target}\`\n\nModify shared-worker.txt.`,
            write: true,
            worktree: true,
          },
        ],
      },
      {
        sessionID: "ses_parent",
        messageID: "msg_parent",
        agent: "implement",
        directory: tmp.path,
        worktree: tmp.path,
        abort: new AbortController().signal,
        ask: () => Effect.void,
        metadata() {},
      },
    )

    expect(out).toContain("shared-worktree: done")
    expect(out).toContain("patch=")
    expect(await Bun.file(path.join(tmp.path, "shared-worker.txt")).text()).toBe("shared worker output\n")
  } finally {
    await Bun.$`git worktree remove --force ${target}`
      .cwd(tmp.path)
      .quiet()
      .catch(() => {})
    await fs.rm(path.dirname(target), { recursive: true, force: true }).catch(() => {})
  }
})

test("team rewrites invalid external worktree hints to the isolated worker worktree", async () => {
  await using tmp = await tmpdir({
    git: true,
    init: async (dir) => {
      await Bun.write(path.join(dir, "README.md"), "# test\n")
      await Bun.$`git add README.md`.cwd(dir).quiet()
      await Bun.$`git commit -m "seed"`.cwd(dir).quiet()
    },
  })

  const invalid = path.join(path.dirname(tmp.path), ".worktrees", `other-${crypto.randomUUID()}`)
  await fs.mkdir(invalid, { recursive: true })

  let box = ""
  try {
    const plugin = await team({
      client: {
        permission: {
          async list() {
            return { data: [] }
          },
        },
        question: {
          async list() {
            return { data: [] }
          },
        },
        session: {
          async get() {
            return { data: { permission: [] } }
          },
          async create(input) {
            box = input.query.directory
            return {
              data: {
                id: "ses_invalid_worktree_hint",
              },
            }
          },
          async promptAsync(input) {
            const text = input.body.parts[0]?.text ?? ""
            expect(input.query.directory).toContain(path.join(".opencode", "team"))
            expect(text).toContain(input.query.directory)
            expect(text).not.toContain(invalid)
            await Bun.write(path.join(input.query.directory, "worker.txt"), "worker output\n")
            return {}
          },
          async prompt() {
            return {}
          },
          async status() {
            return {
              data: {
                ses_invalid_worktree_hint: {
                  type: "idle",
                },
              },
            }
          },
          async messages() {
            return {
              data: [
                {
                  info: {
                    role: "assistant",
                    time: {
                      completed: Date.now(),
                    },
                  },
                  parts: [
                    {
                      type: "text",
                      text: "worker finished",
                    },
                  ],
                },
              ],
            }
          },
          async abort() {
            return {}
          },
        },
      },
      worktree: tmp.path,
      directory: tmp.path,
    })

    const out = await plugin.tool.team.execute(
      {
        strategy: "parallel",
        limit: 1,
        tasks: [
          {
            id: "invalid-hint",
            prompt: `You are working in a **git worktree** at:\n\`${invalid}\`\n\nModify worker.txt.`,
            write: true,
            worktree: true,
          },
        ],
      },
      {
        sessionID: "ses_parent",
        messageID: "msg_parent",
        agent: "implement",
        directory: tmp.path,
        worktree: tmp.path,
        abort: new AbortController().signal,
        ask: () => Effect.void,
        metadata() {},
      },
    )

    expect(box).toContain(path.join(".opencode", "team"))
    expect(await Bun.file(path.join(tmp.path, "worker.txt")).text()).toBe("worker output\n")
    expect(out).toContain("invalid-hint: done")
  } finally {
    await fs.rm(invalid, { recursive: true, force: true })
  }
})

test("team rejects directories outside the project worktree and cleans provisional worktrees", async () => {
  await using tmp = await tmpdir({
    git: true,
    init: async (dir) => {
      await Bun.write(path.join(dir, "README.md"), "# test\n")
      await Bun.$`git add README.md`.cwd(dir).quiet()
      await Bun.$`git commit -m "seed"`.cwd(dir).quiet()
    },
  })

  const out = path.join(path.dirname(tmp.path), `opencode-outside-${crypto.randomUUID()}`)
  await fs.mkdir(out, { recursive: true })

  const plugin = await team({
    client: {
      permission: {
        async list() {
          return { data: [] }
        },
      },
      question: {
        async list() {
          return { data: [] }
        },
      },
      session: {
        async get() {
          return { data: { permission: [] } }
        },
        async create() {
          throw new Error("session create should not run")
        },
        async promptAsync() {
          throw new Error("prompt should not run")
        },
        async prompt() {
          return {}
        },
        async status() {
          return { data: {} }
        },
        async messages() {
          return { data: [] }
        },
        async abort() {
          return {}
        },
      },
    },
    worktree: tmp.path,
    directory: tmp.path,
  })

  try {
    await expect(
      plugin.tool.team.execute(
        {
          strategy: "parallel",
          limit: 1,
          tasks: [
            {
              id: "outside",
              prompt: "write a file",
              write: true,
            },
          ],
        },
        {
          sessionID: "ses_parent",
          messageID: "msg_parent",
          agent: "implement",
          directory: out,
          worktree: tmp.path,
          abort: new AbortController().signal,
          ask: () => Effect.void,
          metadata() {},
        },
      ),
    ).rejects.toThrow("directory is outside worktree")

    const list = await fs.readdir(path.join(tmp.path, ".opencode", "team"), { withFileTypes: true }).catch(() => [])
    expect(list.filter((item) => item.isDirectory()).length).toBe(0)
  } finally {
    await fs.rm(out, { recursive: true, force: true })
  }
})
