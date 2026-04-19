import { afterEach, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import team from "../../../../packages/guardrails/profile/plugins/team"
import { Instance } from "../../src/project/instance"
import { tmpdir } from "../fixture/fixture"

afterEach(async () => {
  await Instance.disposeAll()
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
          action: string
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
          expect(await Bun.file(path.join(box, "CLAUDE.md")).text()).toContain("local claude")
          expect(await Bun.file(path.join(box, ".opencode", "opencode.jsonc")).text()).toContain(`"gh *": "allow"`)
          expect(await Bun.file(path.join(box, ".claude", "settings.local.json")).text()).toContain(`"Bash(gh:*)"`)
          expect(await Bun.file(path.join(box, ".claude", "skills", "local-claude", "SKILL.md")).text()).toContain("local-claude")
          expect(await Bun.file(path.join(box, ".agents", "skills", "local-agent", "SKILL.md")).text()).toContain("local-agent")
          expect(await Bun.file(path.join(box, ".github", "copilot-instructions.md")).text()).toContain("Local Copilot")
          expect(await Bun.file(path.join(box, ".cursor", "rules", "global.mdc")).text()).toContain("Local Cursor Rule")
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
      ask: async () => {},
      metadata() {},
    },
  )

  expect(out).toContain("run_id:")
  expect(body?.parentID).toBe("ses_parent")
  expect(body?.permission?.slice(0, perm.length)).toEqual(perm)
  expect(body?.permission).toContainEqual({ permission: "bash", pattern: "rg *", action: "allow" })
  expect(body?.permission).toContainEqual({ permission: "bash", pattern: "git ls-tree*", action: "allow" })
  expect(body?.permission).toContainEqual({ permission: "bash", pattern: "opencode *", action: "deny" })
  expect(box).toContain(path.join(".opencode", "team"))
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
        ask: async () => {},
        metadata() {},
      },
    ),
  ).rejects.toThrow("Blocked on permission: bash (Check gstack browse availability)")
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
        ask: async () => {},
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
                patterns: ["osascript -e \"beep\""],
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
      ask: async () => {},
      metadata() {},
    },
  )

  expect(out).toContain("state: error")
  expect(out).toContain("failure_stage=blocked")
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
      ask: async () => {},
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
      ask: async () => {},
      metadata() {},
    },
  )

  expect(tools).toEqual({
    edit: false,
    write: false,
    apply_patch: false,
    task: false,
    todowrite: false,
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
      ask: async () => {},
      metadata() {},
    },
  )

  expect(prompt).not.toContain("Use bash to run `opencode run /init`")
  expect(prompt).toContain("Worker execution rules:")
  expect(prompt).toContain("perform the equivalent /init repository inspection and AGENTS.md bootstrap directly in this worktree")
  expect(prompt).toContain("Do not invoke nested OpenCode slash commands")
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
        ask: async () => {},
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
        ask: async () => {},
        metadata() {},
      },
    ),
  ).rejects.toThrow("Blocked on permission: bash :: git ls-tree --name-only -r HEAD")
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
      ask: async () => {},
      metadata() {},
    },
  )

  expect(turn).toBe(3)
  expect(out).toContain("output=finished")
})

test("team treats missing child status after activity as idle", async () => {
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
      ask: async () => {},
      metadata() {},
    },
  )

  expect(turn).toBe(2)
  expect(out).toContain("- verify: done")
  expect(out).toContain("output=finished")
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
      ask: async () => {},
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
      ask: async () => {},
      metadata() {},
    },
  )

  expect(out).toContain("- verify: done")
  expect(out).toContain("output=finished from completed message")
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
          if (calls === 1) return {} as { stream: AsyncIterable<{ type?: string; properties?: Record<string, unknown> }> }
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
      ask: async () => {},
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
        JSON.stringify({
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
              model: "gpt-5.4",
              variant: "high",
              state: "running",
              dir,
              session: "ses_child_stale_run",
              patch: "",
              output: "",
              error: "",
            },
          ],
        }, null, 2) + "\n",
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
      ask: async () => {},
      metadata() {},
    },
  )

  const saved = JSON.parse(await Bun.file(path.join(tmp.path, ".opencode", "guardrails", "team-runs", "run-1.json")).text())
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
        JSON.stringify({
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
              model: "gpt-5.4",
              variant: "high",
              state: "running",
              dir,
              session: "ses_child_stale_run_execute",
              patch: "",
              output: "",
              error: "",
            },
          ],
        }, null, 2) + "\n",
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
      ask: async () => {},
      metadata() {},
    },
  )

  const stale = JSON.parse(await Bun.file(path.join(tmp.path, ".opencode", "guardrails", "team-runs", "stale-run.json")).text())
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
        JSON.stringify({
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
              model: "gpt-5.4",
              variant: "high",
              state: "running",
              dir,
              session: "ses_child_startup_stale",
              patch: "",
              output: "",
              error: "",
            },
          ],
        }, null, 2) + "\n",
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
    const stale = JSON.parse(await Bun.file(path.join(tmp.path, ".opencode", "guardrails", "team-runs", "startup-stale.json")).text())
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
        JSON.stringify({
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
              model: "gpt-5.4",
              variant: "high",
              state: "running",
              dir,
              session: "ses_child_chat_stale",
              patch: "",
              output: "",
              error: "",
            },
          ],
        }, null, 2) + "\n",
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
    const stale = JSON.parse(await Bun.file(path.join(tmp.path, ".opencode", "guardrails", "team-runs", "chat-stale.json")).text())
    if (stale.state === "done") {
      expect(stale.tasks[0].state).toBe("done")
      expect(stale.tasks[0].output).toBe("chat stale completed")
      return
    }
    await Bun.sleep(50)
  }

throw new Error("chat.message sweep did not reconcile stale run")
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
      ask: async () => {},
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

  const patches = (await fs.readdir(path.join(tmp.path, ".opencode", "guardrails", "team-runs"))).filter((item) => item.endsWith(".patch"))
  expect(patches.length).toBeGreaterThan(0)
  const patchBody = await Bun.file(path.join(tmp.path, ".opencode", "guardrails", "team-runs", patches[0]!)).text()
  expect(patchBody).toContain("worker.txt")
  expect(patchBody).not.toContain(".opencode/guardrails/state.json")
  expect(patchBody).not.toContain(".opencode/memory/MEMORY.md")
})
