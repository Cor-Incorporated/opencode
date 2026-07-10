import { describe, expect, test } from "bun:test"
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

  test("tool after updates ci_green from gh pr checks output", async () => {
    await using tmp = await tmpdir({ git: true })
    const plugin = await guardrail({ client: client(), directory: tmp.path, worktree: tmp.path }, {})
    await plugin.event({ event: { type: "session.created", properties: { sessionID: "ses_ci" } } })

    await plugin["tool.execute.after"](
      { tool: "bash", args: { command: "gh pr checks 42" } },
      { title: "checks", output: "build\tpass\t0\thttps://example.test/check\n", metadata: { exitCode: 0 } },
    )
    let data = await Bun.file(path.join(tmp.path, ".opencode", "guardrails", "state.json")).json()
    expect(data.ci_green).toBe(true)

    await plugin["tool.execute.after"](
      { tool: "bash", args: { command: "gh pr checks 42" } },
      { title: "checks", output: "build\tqueued\t0\thttps://example.test/check\n", metadata: { exitCode: 0 } },
    )
    data = await Bun.file(path.join(tmp.path, ".opencode", "guardrails", "state.json")).json()
    expect(data.ci_green).toBe(false)

    await plugin["tool.execute.after"](
      { tool: "bash", args: { command: "gh pr checks 42" } },
      { title: "checks", output: "build\tpass\t0\thttps://example.test/check\n", metadata: { exitCode: 1 } },
    )
    data = await Bun.file(path.join(tmp.path, ".opencode", "guardrails", "state.json")).json()
    expect(data.ci_green).toBe(false)
  })

  test("git push to a protected branch is still blocked through the aggregate hook", async () => {
    await using tmp = await tmpdir({ git: true })
    const plugin = await guardrail({ client: client(), directory: tmp.path, worktree: tmp.path }, {})
    await plugin.event({ event: { type: "session.created", properties: { sessionID: "ses_push" } } })

    await expect(
      plugin["tool.execute.before"](
        { tool: "bash", args: { command: "git push origin main" } },
        { args: { command: "git push origin main" } },
      ),
    ).rejects.toThrow("direct push to protected branch blocked")
  })
})
