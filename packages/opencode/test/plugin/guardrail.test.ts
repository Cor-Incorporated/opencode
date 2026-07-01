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

async function writeReviewEvidence(worktree: string, data: Record<string, unknown>) {
  const guardrails = path.join(worktree, ".opencode", "guardrails")
  await fs.mkdir(guardrails, { recursive: true })
  await Bun.write(path.join(guardrails, "review-evidence.json"), JSON.stringify(data, null, 2))
}

async function withHome(home: string, fn: () => Promise<void>) {
  const previous = process.env.HOME
  process.env.HOME = home
  try {
    await fn()
  } finally {
    if (previous === undefined) delete process.env.HOME
    else process.env.HOME = previous
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

  test("session.created restores same-head review evidence after Codex MCP detection", async () => {
    await using tmp = await tmpdir({ git: true })
    const head = (await Bun.$`git rev-parse HEAD`.cwd(tmp.path).text()).trim()
    await writeReviewEvidence(tmp.path, {
      head,
      review_glm_state: "done",
      review_glm_at: "2026-07-01T00:00:00.000Z",
      review_agent: "code-reviewer",
      review_critical_count: 0,
      review_high_count: 0,
    })
    const plugin = await guardrail({ client: client(), directory: tmp.path, worktree: tmp.path }, {})

    await withHome(tmp.path, async () => {
      await plugin.event({ event: { type: "session.created", properties: { sessionID: "ses_restore" } } })
    })

    const data = await Bun.file(path.join(tmp.path, ".opencode", "guardrails", "state.json")).json()
    expect(data.read_count).toBe(0)
    expect(data.workflow_phase).toBe("idle")
    expect(data.review_glm_state).toBe("done")
    expect(data.review_codex_state).toBe("done")
    expect(data.review_codex_at).toBe("auto:no-codex-mcp")
    expect(data.review_state).toBe("done")
    expect(data.edits_since_review).toBe(0)
    expect(data.review_agent).toBe("code-reviewer")
  })

  test("session.created skips review evidence when HEAD mismatches", async () => {
    await using tmp = await tmpdir({ git: true })
    await writeReviewEvidence(tmp.path, {
      head: "0000000000000000000000000000000000000000",
      review_glm_state: "done",
    })
    const plugin = await guardrail({ client: client(), directory: tmp.path, worktree: tmp.path }, {})

    await withHome(tmp.path, async () => {
      await plugin.event({ event: { type: "session.created", properties: { sessionID: "ses_mismatch" } } })
    })

    const data = await Bun.file(path.join(tmp.path, ".opencode", "guardrails", "state.json")).json()
    expect(data.review_glm_state).toBe("")
    expect(data.review_codex_state).toBe("done")
    expect(data.review_state).toBe("")
  })

  test("session.created skips review evidence when worktree is dirty", async () => {
    await using tmp = await tmpdir({ git: true })
    const head = (await Bun.$`git rev-parse HEAD`.cwd(tmp.path).text()).trim()
    await writeReviewEvidence(tmp.path, {
      head,
      review_glm_state: "done",
    })
    await Bun.write(path.join(tmp.path, "dirty.txt"), "dirty\n")
    const plugin = await guardrail({ client: client(), directory: tmp.path, worktree: tmp.path }, {})

    await withHome(tmp.path, async () => {
      await plugin.event({ event: { type: "session.created", properties: { sessionID: "ses_dirty" } } })
    })

    const data = await Bun.file(path.join(tmp.path, ".opencode", "guardrails", "state.json")).json()
    expect(data.review_glm_state).toBe("")
    expect(data.review_codex_state).toBe("done")
    expect(data.review_state).toBe("")
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
