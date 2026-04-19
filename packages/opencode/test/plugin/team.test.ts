import { afterEach, expect, test } from "bun:test"
import { readdir } from "fs/promises"
import path from "path"
import team from "../../../../packages/guardrails/profile/plugins/team"
import { Instance } from "../../src/project/instance"
import { tmpdir } from "../fixture/fixture"

afterEach(async () => {
  await Instance.disposeAll()
})

async function createPlugin(dir: string, worktree = dir) {
  return team({
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
          return {}
        },
        async prompt() {
          return {}
        },
        async status() {
          return { data: { ses_child: { type: "idle" } } }
        },
        async messages() {
          return {
            data: [
              {
                info: {
                  role: "assistant",
                  time: { completed: Date.now() },
                },
                parts: [{ type: "text", text: "done" }],
              },
            ],
          }
        },
        async abort() {
          return {}
        },
      },
    },
    worktree,
    directory: dir,
  })
}

test("background success clears the parallel implementation gate", async () => {
  await using tmp = await tmpdir({ git: true })
  const plugin = await createPlugin(tmp.path)

  await plugin["chat.message"]?.(
    { sessionID: "ses_background_done", agent: "implement" },
    {
      message: { id: "msg_background_done", sessionID: "ses_background_done", role: "user" },
      parts: [
        {
          type: "text",
          text:
            "Implement the following across packages/a, packages/b, and packages/c:\n" +
            "- Add new types\n" +
            "- Update imports\n" +
            "- Add tests\n" +
            "- Fix consumers\n" +
            "Large multi-file implementation. Keep working in the background.",
        },
      ],
    },
  )

  await expect(
    plugin["tool.execute.before"]?.(
      { tool: "edit", sessionID: "ses_background_done" },
      { args: { filePath: path.join(tmp.path, "src", "a.ts"), oldString: "a", newString: "b" } },
    ),
  ).rejects.toThrow("Parallel implementation is enforced")

  await plugin["tool.execute.after"]?.(
    { tool: "background", sessionID: "ses_background_done" },
    { title: "background run", output: "done", metadata: {} },
  )

  await expect(
    plugin["tool.execute.before"]?.(
      { tool: "edit", sessionID: "ses_background_done" },
      { args: { filePath: path.join(tmp.path, "src", "a.ts"), oldString: "a", newString: "b" } },
    ),
  ).resolves.toBeUndefined()
})

test("background failure also clears the parallel implementation gate", async () => {
  await using tmp = await tmpdir({ git: true })
  const plugin = await createPlugin(tmp.path)

  await plugin["chat.message"]?.(
    { sessionID: "ses_background_fail", agent: "implement" },
    {
      message: { id: "msg_background_fail", sessionID: "ses_background_fail", role: "user" },
      parts: [
        {
          type: "text",
          text:
            "Implement the following across packages/a, packages/b, and packages/c:\n" +
            "- Add new types\n" +
            "- Update imports\n" +
            "- Add tests\n" +
            "- Fix consumers\n" +
            "Large multi-file implementation. Fan the work out.",
        },
      ],
    },
  )

  await expect(
    plugin["tool.execute.before"]?.(
      { tool: "edit", sessionID: "ses_background_fail" },
      { args: { filePath: path.join(tmp.path, "src", "a.ts"), oldString: "a", newString: "b" } },
    ),
  ).rejects.toThrow("Parallel implementation is enforced")

  await plugin["tool.execute.error"]?.(
    { tool: "background", sessionID: "ses_background_fail" },
    { error: new Error("background failed") },
  )

  await expect(
    plugin["tool.execute.before"]?.(
      { tool: "edit", sessionID: "ses_background_fail" },
      { args: { filePath: path.join(tmp.path, "src", "a.ts"), oldString: "a", newString: "b" } },
    ),
  ).resolves.toBeUndefined()
})

test("background uses the session directory for state when no git worktree is available", async () => {
  await using tmp = await tmpdir()
  const plugin = await createPlugin(tmp.path, "/")

  const result = await plugin.tool.background.execute(
    {
      description: "read-only non-git check",
      prompt: "Run a read-only check in the current directory and report success.",
      notify: false,
      worktree: false,
    },
    {
      sessionID: "ses_non_git_background",
      messageID: "msg_non_git_background",
      agent: "build",
      directory: tmp.path,
      worktree: "/",
      abort: AbortSignal.timeout(5000),
      metadata() {},
      ask() {
        return undefined as never
      },
    },
  )

  expect(result).toContain("state: done")
  const entries = await readdir(path.join(tmp.path, ".opencode", "guardrails", "team-runs"))
  expect(entries.some((item) => item.endsWith(".json"))).toBeTrue()
})

test("background detaches worker execution from the parent abort signal", async () => {
  await using tmp = await tmpdir()
  const plugin = await createPlugin(tmp.path, "/")
  const controller = new AbortController()
  controller.abort()

  const result = await plugin.tool.background.execute(
    {
      description: "detached background check",
      prompt: "Run a read-only check in the current directory and report success.",
      notify: false,
      worktree: false,
    },
    {
      sessionID: "ses_detached_background",
      messageID: "msg_detached_background",
      agent: "build",
      directory: tmp.path,
      worktree: "/",
      abort: controller.signal,
      metadata() {},
      ask() {
        return undefined as never
      },
    },
  )

  expect(result).toContain("state: done")
})
