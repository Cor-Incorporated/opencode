import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { tmpdir } from "../fixture/fixture"
import guardrail, {
  ensureLocalOpencodeIgnored,
  partID,
  teamWorkerWorktree,
} from "../../../../packages/guardrails/profile/plugins/guardrail"
import type { GuardrailInput } from "../../../../packages/guardrails/profile/plugins/guardrail-context"

function client(): GuardrailInput["client"] {
  return {
    session: {
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
  }
}

describe("guardrail plugin", () => {
  test("uses OpenCode-compatible part ids for injected text", () => {
    expect(partID().startsWith("prt_")).toBe(true)
  })

  test("detects internal team worker worktrees", () => {
    expect(teamWorkerWorktree("/repo/.opencode/team/run-a")).toBe(true)
    expect(teamWorkerWorktree("/repo/src")).toBe(false)
  })

  test("adds .opencode to local git exclude instead of project .gitignore", async () => {
    await using tmp = await tmpdir({ git: true })
    const changed = await ensureLocalOpencodeIgnored(tmp.path)

    expect(changed).toBe(true)
    expect(await Bun.file(path.join(tmp.path, ".gitignore")).exists()).toBe(false)
    expect(await Bun.$`git check-ignore .opencode/state.json`.cwd(tmp.path).text()).toContain(".opencode/state.json")
  })

  test("does not mutate git exclude for internal team worker worktrees", async () => {
    await using tmp = await tmpdir({ git: true })
    const teamDir = path.join(tmp.path, ".opencode", "team", "worker")
    await Bun.$`git worktree add ${teamDir}`.cwd(tmp.path).quiet()
    const exclude = (await Bun.$`git -C ${teamDir} rev-parse --git-path info/exclude`.text()).trim()
    const before = await Bun.file(exclude).text()

    expect(await ensureLocalOpencodeIgnored(teamDir)).toBe(false)
    expect(await Bun.file(exclude).text()).toBe(before)
  })

  test("tool hook blocks code PR merge when code-reviewer state is missing", async () => {
    await using tmp = await tmpdir({ git: true })
    await Bun.$`git branch -M dev`.cwd(tmp.path).quiet()
    await Bun.$`git update-ref refs/remotes/origin/dev HEAD`.cwd(tmp.path).quiet()
    await Bun.$`git checkout -b feat/full-review`.cwd(tmp.path).quiet()
    await fs.mkdir(path.join(tmp.path, "src"), { recursive: true })
    await Bun.write(path.join(tmp.path, "src", "policy.ts"), "export const policy = true\n")
    await Bun.$`git add src/policy.ts`.cwd(tmp.path).quiet()
    await Bun.$`git commit -m "add policy source"`.cwd(tmp.path).quiet()
    const plugin = await guardrail({ client: client(), directory: tmp.path, worktree: tmp.path }, {})

    await plugin.event({ event: { type: "session.created", properties: { sessionID: "ses_test" } } })
    await Bun.write(
      path.join(tmp.path, ".opencode", "guardrails", "state.json"),
      JSON.stringify({
        ...(await Bun.file(path.join(tmp.path, ".opencode", "guardrails", "state.json")).json()),
        review_codex_state: "done",
      }),
    )

    await expect(
      plugin["tool.execute.before"](
        { tool: "bash", args: { command: "git merge dev" } },
        { args: { command: "git merge dev" } },
      ),
    ).rejects.toThrow("pending: GLM code-reviewer")
  })
})
