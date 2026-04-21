import { afterEach, expect, test } from "bun:test"
import { mkdir, readdir } from "fs/promises"
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

test("team merges worker output when local .opencode config is gitignored", async () => {
  await using tmp = await tmpdir({
    git: true,
    init: async (dir) => {
      await Bun.write(path.join(dir, ".gitignore"), ".opencode/\n")
      await Bun.write(path.join(dir, "README.md"), "# test\n")
      await mkdir(path.join(dir, ".opencode", "plugins"), { recursive: true })
      await Bun.write(path.join(dir, ".opencode", "opencode.jsonc"), `{"plugin":["./plugins/team.ts"]}\n`)
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
          return { data: { id: "ses_child_ignored_opencode" } }
        },
        async promptAsync(input) {
          box = input.query.directory
          expect(await Bun.file(path.join(box, ".opencode", "opencode.jsonc")).text()).toContain("./plugins/team.ts")
          expect(await Bun.file(path.join(box, ".opencode", "plugins", "team.ts")).text()).toContain("export default")
          await Bun.write(path.join(box, "worker.txt"), "worker output\n")
        },
        async prompt() {
          return {}
        },
        async status() {
          return { data: { ses_child_ignored_opencode: { type: "idle" } } }
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
          prompt: "write worker output",
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
      abort: AbortSignal.timeout(5000),
      metadata() {},
      ask() {
        return undefined as never
      },
    },
  )

  expect(out).toContain("- ignored-opencode: done")
  expect(box).toContain(path.join(".opencode", "team"))
  expect(await Bun.file(path.join(tmp.path, "worker.txt")).text()).toBe("worker output\n")
  expect(await Bun.file(path.join(tmp.path, ".opencode", "opencode.jsonc")).exists()).toBeTrue()
})

test("team merge tolerates uncommitted removal of the .opencode gitignore rule", async () => {
  await using tmp = await tmpdir({
    git: true,
    init: async (dir) => {
      await Bun.write(path.join(dir, ".gitignore"), ".opencode/\n")
      await Bun.write(path.join(dir, "README.md"), "# test\n")
      await mkdir(path.join(dir, ".opencode", "plugins"), { recursive: true })
      await Bun.write(path.join(dir, ".opencode", "opencode.jsonc"), `{"plugin":["./plugins/team.ts"]}\n`)
      await Bun.write(path.join(dir, ".opencode", "plugins", "team.ts"), "export default async function team() {}\n")
      await Bun.$`git add .gitignore README.md`.cwd(dir).quiet()
      await Bun.$`git commit -m "seed"`.cwd(dir).quiet()
      await Bun.write(path.join(dir, ".gitignore"), "# temporarily removed during repair\n")
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
          return { data: { id: "ses_child_uncommitted_gitignore" } }
        },
        async promptAsync(input) {
          box = input.query.directory
          expect(await Bun.file(path.join(box, ".gitignore")).text()).toContain(".opencode/")
          expect(await Bun.file(path.join(box, ".opencode", "opencode.jsonc")).text()).toContain("./plugins/team.ts")
          await Bun.write(path.join(box, "worker-uncommitted.txt"), "worker output\n")
        },
        async prompt() {
          return {}
        },
        async status() {
          return { data: { ses_child_uncommitted_gitignore: { type: "idle" } } }
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
    worktree: tmp.path,
    directory: tmp.path,
  })

  const out = await plugin.tool.team.execute(
    {
      strategy: "parallel",
      limit: 1,
      tasks: [
        {
          id: "uncommitted-gitignore",
          prompt: "write worker output",
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
      abort: AbortSignal.timeout(5000),
      metadata() {},
      ask() {
        return undefined as never
      },
    },
  )

  expect(out).toContain("- uncommitted-gitignore: done")
  expect(box).toContain(path.join(".opencode", "team"))
  expect(await Bun.file(path.join(tmp.path, "worker-uncommitted.txt")).text()).toBe("worker output\n")
  expect(await Bun.file(path.join(tmp.path, ".gitignore")).text()).not.toContain(".opencode/")
})

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
