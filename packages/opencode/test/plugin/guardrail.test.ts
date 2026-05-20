import { describe, expect, test } from "bun:test"
import path from "path"
import { tmpdir } from "../fixture/fixture"
import {
  ensureLocalOpencodeIgnored,
  partID,
  teamWorkerWorktree,
} from "../../../../packages/guardrails/profile/plugins/guardrail"

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
})
