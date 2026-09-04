import { describe, expect, test } from "bun:test"
import path from "path"
import { tmpdir } from "../fixture/fixture"
import {
  team,
  DEFAULT_TEAM_IDLE_TIMEOUT_MS,
  DEFAULT_TEAM_READ_IDLE_TIMEOUT_MS,
  DEFAULT_TEAM_WRITE_IDLE_TIMEOUT_MS,
  formatTimeoutProgress,
  resolveIdleTimeout,
} from "../../../../packages/guardrails/profile/plugins/team"

describe("resolveIdleTimeout (Issue #286)", () => {
  test("defaults: read 10m, write/deepseek 20m", () => {
    expect(DEFAULT_TEAM_READ_IDLE_TIMEOUT_MS).toBe(10 * 60 * 1000)
    expect(DEFAULT_TEAM_WRITE_IDLE_TIMEOUT_MS).toBe(20 * 60 * 1000)
    expect(DEFAULT_TEAM_IDLE_TIMEOUT_MS).toBe(DEFAULT_TEAM_WRITE_IDLE_TIMEOUT_MS)
    expect(resolveIdleTimeout({ write: false, env: {} })).toBe(DEFAULT_TEAM_READ_IDLE_TIMEOUT_MS)
    expect(resolveIdleTimeout({ write: true, env: {} })).toBe(DEFAULT_TEAM_WRITE_IDLE_TIMEOUT_MS)
    expect(resolveIdleTimeout({ provider: "deepseek", model: "deepseek-v4-flash", env: {} })).toBe(
      DEFAULT_TEAM_WRITE_IDLE_TIMEOUT_MS,
    )
  })

  test("OPENCODE_TEAM_IDLE_TIMEOUT_MS wins over write/provider defaults", () => {
    expect(
      resolveIdleTimeout({
        write: true,
        provider: "deepseek",
        env: { OPENCODE_TEAM_IDLE_TIMEOUT_MS: "3000" },
      }),
    ).toBe(3000)
  })

  test("provider-scoped override applies when global unset", () => {
    expect(
      resolveIdleTimeout({
        write: false,
        provider: "deepseek",
        model: "deepseek-v4-flash",
        env: { OPENCODE_TEAM_IDLE_TIMEOUT_MS_DEEPSEEK: "900000" },
      }),
    ).toBe(900000)
  })

  test("OPENCODE_TEAM_WRITE_IDLE_TIMEOUT_MS applies to write tasks only", () => {
    expect(
      resolveIdleTimeout({
        write: true,
        provider: "zai-coding-plan",
        model: "glm-5.2",
        env: { OPENCODE_TEAM_WRITE_IDLE_TIMEOUT_MS: "1500000" },
      }),
    ).toBe(1500000)
    expect(
      resolveIdleTimeout({
        write: false,
        provider: "zai-coding-plan",
        model: "glm-5.2",
        env: { OPENCODE_TEAM_WRITE_IDLE_TIMEOUT_MS: "1500000" },
      }),
    ).toBe(DEFAULT_TEAM_READ_IDLE_TIMEOUT_MS)
  })

  test("negative: unrelated env keys and invalid values do not shrink the default", () => {
    expect(resolveIdleTimeout({ write: true, env: { OPENCODE_TEAM_IDLE_TIMEOUT_MS: "0" } })).toBe(
      DEFAULT_TEAM_WRITE_IDLE_TIMEOUT_MS,
    )
    expect(resolveIdleTimeout({ write: true, env: { OPENCODE_TEAM_IDLE_TIMEOUT_MS: "nope" } })).toBe(
      DEFAULT_TEAM_WRITE_IDLE_TIMEOUT_MS,
    )
    expect(resolveIdleTimeout({ write: true, env: { SOME_OTHER_TIMEOUT: "1" } })).toBe(
      DEFAULT_TEAM_WRITE_IDLE_TIMEOUT_MS,
    )
  })

  test("falsify: restoring the old 600s default would be shorter than write budget", () => {
    const legacy = 10 * 60 * 1000
    expect(resolveIdleTimeout({ write: true, env: {} })).toBeGreaterThan(legacy)
  })
})

describe("formatTimeoutProgress", () => {
  test("includes last tool status and text without word-matching on severity labels", () => {
    const label = formatTimeoutProgress(
      [
        {
          info: { role: "assistant" },
          parts: [
            { type: "text", text: "editing high priority module" },
            { type: "tool", state: { status: "running", output: "" } },
          ],
        },
      ],
      "status busy",
    )
    expect(label).toContain("status busy")
    expect(label).toContain("last_tool=running")
    expect(label).toContain("last_text=editing high priority module")
  })
})

describe("team idle timeout integration", () => {
  test("timeout error includes progress and env discoverability hint", async () => {
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
              return { data: { id: "ses_child_busy_timeout" } }
            },
            async promptAsync() {
              return {}
            },
            async prompt() {
              return {}
            },
            async status() {
              return { data: { ses_child_busy_timeout: { type: "busy" } } }
            },
            async messages() {
              return {
                data: [
                  {
                    info: { role: "assistant" },
                    parts: [
                      { type: "text", text: "still implementing files" },
                      { type: "tool", state: { status: "running", output: "" } },
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
            tasks: [{ id: "busy", prompt: "keep working", write: false, worktree: false }],
          },
          {
            sessionID: "ses_parent",
            messageID: "msg_parent",
            agent: "implement",
            directory: tmp.path,
            worktree: tmp.path,
            abort: new AbortController().signal,
            ask: async () => undefined,
            metadata() {},
          },
        ),
      ).rejects.toThrow(/last_tool=running[\s\S]*OPENCODE_TEAM_IDLE_TIMEOUT_MS/)
    } finally {
      if (prev === undefined) delete process.env.OPENCODE_TEAM_IDLE_TIMEOUT_MS
      else process.env.OPENCODE_TEAM_IDLE_TIMEOUT_MS = prev
    }
  })
})
