import { describe, expect, test } from "bun:test"
import path from "path"
import { createGitHandlers } from "../../../../packages/guardrails/profile/plugins/guardrail-git"
import type { GuardrailContext } from "../../../../packages/guardrails/profile/plugins/guardrail-context"
import { tmpdir } from "../fixture/fixture"

async function context() {
  const tmp = await tmpdir()
  const marks: Record<string, unknown>[] = []
  const ctx: GuardrailContext = {
    input: {
      client: {} as GuardrailContext["input"]["client"],
      directory: tmp.path,
      worktree: tmp.path,
    },
    mode: "enforced",
    root: path.join(tmp.path, ".opencode", "guardrails"),
    log: path.join(tmp.path, ".opencode", "guardrails", "events.jsonl"),
    state: path.join(tmp.path, ".opencode", "guardrails", "state.json"),
    allow: {},
    hasCodexMcp: false,
    maxParallelTasks: 5,
    maxSessionCost: 10,
    agentModelTier: {},
    tierModels: {},
    domainDirs: {},
    async mark(data) {
      marks.push(data)
    },
    async seen() {},
    note() {
      return { sessionID: undefined, permission: undefined, patterns: undefined }
    },
    hidden() {
      return false
    },
    code() {
      return false
    },
    fact() {
      return false
    },
    stale() {
      return false
    },
    factLine() {
      return ""
    },
    reviewLine() {
      return ""
    },
    compact() {
      return ""
    },
    deny() {
      return undefined
    },
    baseline() {
      return undefined
    },
    async version() {
      return undefined
    },
    async budget() {
      return 0
    },
    gate() {
      return undefined
    },
  }
  return {
    ctx,
    marks,
    [Symbol.asyncDispose]: async () => {
      await tmp[Symbol.asyncDispose]()
    },
  }
}

function review() {
  return {
    checklist() {
      return { score: 3, total: 3, blocking: [], summary: "ok" }
    },
    reviewGate() {
      return { done: false, pending: ["GLM code-reviewer"], message: "pending: GLM code-reviewer" }
    },
    async syncReviewState() {},
  }
}

describe("guardrail-git", () => {
  test("blocks GitHub API pull request merge bypasses", async () => {
    await using fixture = await context()
    const git = createGitHandlers(fixture.ctx, review())

    await expect(
      git.bashBeforeGit("gh api -X PUT repos/Cor-Incorporated/nfc-profile-card/pulls/42/merge", {}, {}),
    ).rejects.toThrow("merge blocked")

    expect(fixture.marks.some((item) => String(item.last_reason).includes("GLM code-reviewer"))).toBe(true)
  })

  test("blocks GitHub API pull request merge bypasses with equals method flags", async () => {
    await using fixture = await context()
    const git = createGitHandlers(fixture.ctx, review())

    await expect(
      git.bashBeforeGit("gh api --method=PUT repos/Cor-Incorporated/nfc-profile-card/pulls/42/merge", {}, {}),
    ).rejects.toThrow("merge blocked")
  })

  test("blocks reset-to-base sync bypasses", async () => {
    await using fixture = await context()
    const git = createGitHandlers(fixture.ctx, review())

    await expect(git.bashBeforeGit("git reset --soft origin/dev", {}, {})).rejects.toThrow("reset-to-base sync blocked")

    expect(fixture.marks.at(-1)?.last_reason).toBe("branch reset sync blocked")
  })

  test("does not treat dev as a hard-coded protected branch", async () => {
    await using fixture = await context()
    const git = createGitHandlers(fixture.ctx, review())

    await expect(git.bashBeforeGit("git push origin dev", {}, {})).resolves.toBeUndefined()
    await expect(git.bashBeforeGit("git push origin main", {}, {})).rejects.toThrow(
      "direct push to protected branch blocked",
    )
  })

  test("requires explicit worktree for codex exec reviews", async () => {
    await using fixture = await context()
    const git = createGitHandlers(fixture.ctx, review())

    await expect(git.bashBeforeGit("codex exec 'review PR #43'", {}, {})).rejects.toThrow(
      "codex exec review must set an explicit worktree",
    )

    await expect(git.bashBeforeGit("codex exec -C /tmp/project 'review PR #43'", {}, {})).rejects.toThrow(
      "codex exec review worktree must match",
    )

    await expect(
      git.bashBeforeGit(`codex exec -C ${fixture.ctx.input.worktree} 'review PR #43'`, {}, {}),
    ).resolves.toBeUndefined()
  })
})
