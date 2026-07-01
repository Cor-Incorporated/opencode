import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { createGitHandlers } from "../../../../packages/guardrails/profile/plugins/guardrail-git"
import type { GuardrailContext } from "../../../../packages/guardrails/profile/plugins/guardrail-context"
import { ciChecksGreen } from "../../../../packages/guardrails/profile/plugins/guardrail-patterns"
import { tmpdir } from "../fixture/fixture"

type HydrateReviewState = (expectedHead?: string) => Promise<boolean | void> | boolean | void

async function context() {
  const tmp = await tmpdir()
  const state = path.join(tmp.path, ".opencode", "guardrails", "state.json")
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
    state,
    allow: {},
    hasCodexMcp: false,
    maxParallelTasks: 5,
    maxSessionCost: 10,
    agentModelTier: {},
    tierModels: {},
    domainDirs: {},
    async mark(data) {
      marks.push(data)
      await fs.mkdir(path.dirname(state), { recursive: true })
      await Bun.write(
        state,
        JSON.stringify(
          {
            ...(await Bun.file(state)
              .json()
              .catch(() => ({}))),
            ...data,
          },
          null,
          2,
        ),
      )
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

function review(input: { hydrateReviewEvidence?: HydrateReviewState } = {}) {
  return {
    checklist() {
      return { score: 3, total: 3, blocking: [], summary: "ok" }
    },
    reviewGate(data: Record<string, unknown>) {
      const pending = [
        data.review_glm_state !== "done" && "GLM code-reviewer",
        data.review_codex_state !== "done" && "Codex review",
      ].filter((item): item is string => typeof item === "string")
      return {
        done: pending.length === 0,
        pending,
        message: pending.length === 0 ? "all reviews complete" : `pending: ${pending.join(" and ")}`,
      }
    },
    async syncReviewState() {},
    async hydrateReviewEvidence(expectedHead?: string) {
      return input.hydrateReviewEvidence?.(expectedHead)
    },
  }
}

async function diffFixture(file: string) {
  const fixture = await context()
  await Bun.$`git init`.cwd(fixture.ctx.input.worktree).quiet()
  await Bun.$`git config core.fsmonitor false`.cwd(fixture.ctx.input.worktree).quiet()
  await Bun.$`git config commit.gpgsign false`.cwd(fixture.ctx.input.worktree).quiet()
  await Bun.$`git config user.email "test@opencode.test"`.cwd(fixture.ctx.input.worktree).quiet()
  await Bun.$`git config user.name "Test"`.cwd(fixture.ctx.input.worktree).quiet()
  await Bun.$`git commit --allow-empty -m root`.cwd(fixture.ctx.input.worktree).quiet()
  await Bun.$`git branch -M dev`.cwd(fixture.ctx.input.worktree).quiet()
  await Bun.$`git update-ref refs/remotes/origin/dev HEAD`.cwd(fixture.ctx.input.worktree).quiet()
  await Bun.$`git checkout -b feat/policy`.cwd(fixture.ctx.input.worktree).quiet()
  await fs.mkdir(path.dirname(path.join(fixture.ctx.input.worktree, file)), { recursive: true })
  await Bun.write(path.join(fixture.ctx.input.worktree, file), "content\n")
  await Bun.$`git add ${file}`.cwd(fixture.ctx.input.worktree).quiet()
  await Bun.$`git commit -m change`.cwd(fixture.ctx.input.worktree).quiet()
  return fixture
}

async function branchFixture(branch: string) {
  const fixture = await diffFixture("docs/placeholder.md")
  await Bun.$`git reset --hard origin/dev`.cwd(fixture.ctx.input.worktree).quiet()
  await Bun.$`git checkout -B ${branch}`.cwd(fixture.ctx.input.worktree).quiet()
  return fixture
}

async function opencodeFixture() {
  const fixture = await diffFixture("docs/placeholder.md")
  await Bun.$`git remote add origin git@github.com:Cor-Incorporated/opencode.git`
    .cwd(fixture.ctx.input.worktree)
    .quiet()
  return fixture
}

function fakeGh(handler: (args: string[]) => { stdout?: string; stderr?: string; code?: number }) {
  const original = Bun.spawn
  Bun.spawn = ((command: string[] | { cmd: string[] }, options?: object) => {
    const args = Array.isArray(command) ? command.map(String) : command.cmd.map(String)
    if (args[0] !== "gh") {
      return Reflect.apply(original, Bun, options === undefined ? [command] : [command, options]) as ReturnType<
        typeof Bun.spawn
      >
    }
    return ghProcess(handler(args.slice(1)))
  }) as typeof Bun.spawn
  return () => {
    Bun.spawn = original
  }
}

function fakePrMergeGh(input: {
  files: string[]
  checks?: string
  pr?: string
  headRefOid?: string
  author?: string
  approvals?: string[]
}) {
  const pr = input.pr ?? "170"
  return fakeGh((args) => {
    if (args[0] === "pr" && args[1] === "checks")
      return { stdout: input.checks ?? "build\tpass\t0\thttps://example.test/check\n" }
    if (args[0] === "pr" && args[1] === "view" && args[2] === pr && args.includes("headRefOid")) {
      return { stdout: `${input.headRefOid ?? ""}\n` }
    }
    if (args[0] === "api" && args[1] === `repos/owner/repo/pulls/${pr}/files`) {
      return { stdout: `${input.files.join("\n")}\n` }
    }
    if (args[0] === "api" && args[1] === `repos/owner/repo/pulls/${pr}/reviews` && args[3]?.includes("APPROVED")) {
      return { stdout: `${(input.approvals ?? []).join("\n")}\n` }
    }
    if (args[0] === "api" && args[1] === `repos/owner/repo/pulls/${pr}/reviews`) return { stdout: "0\n" }
    if (args[0] === "api" && args[1] === `repos/owner/repo/pulls/${pr}`) {
      return { stdout: input.author ? `${input.author}\n` : "\n" }
    }
    return {}
  })
}

function ghProcess(result: { stdout?: string; stderr?: string; code?: number }) {
  return {
    stdout: new Response(result.stdout ?? "").body!,
    stderr: new Response(result.stderr ?? "").body!,
    exited: Promise.resolve(result.code ?? 0),
    exitCode: result.code ?? 0,
  } as ReturnType<typeof Bun.spawn>
}

describe("guardrail-git", () => {
  test("assesses gh pr checks status without scanning descriptions", () => {
    expect(ciChecksGreen("CodeRabbit\tpass\t0\t\tReview skipped: reviews are disabled for this base branch\n", 0)).toBe(
      true,
    )
    expect(
      ciChecksGreen(
        JSON.stringify([
          {
            bucket: "pass",
            name: "CodeRabbit",
            state: "SUCCESS",
            workflow: "Review skipped: reviews are disabled for this base branch",
            link: "https://example.test/stale-cache",
          },
        ]),
        0,
      ),
    ).toBe(true)
    expect(ciChecksGreen(JSON.stringify([{ bucket: "skipping", name: "optional" }]), 0)).toBe(false)
    expect(ciChecksGreen("build\tqueued\t0\thttps://example.test/check\n", 0)).toBe(false)
    expect(ciChecksGreen("build\tpass\t0\thttps://example.test/check\n", 1)).toBe(false)
    expect(ciChecksGreen("", 0)).toBe(false)
    expect(ciChecksGreen("[", 0)).toBe(false)
  })

  test("blocks GitHub API pull request merge bypasses", async () => {
    await using fixture = await context()
    const restore = fakeGh((args) => {
      if (args[0] === "pr" && args[1] === "checks") return { stdout: "build\tpass\t0\thttps://example.test/check\n" }
      if (args[0] === "pr" && args[1] === "diff") return { stdout: "packages/opencode/src/api-merge.ts\n" }
      return {}
    })
    try {
      const git = createGitHandlers(fixture.ctx, review())

      await expect(
        git.bashBeforeGit("gh api -X PUT repos/Cor-Incorporated/nfc-profile-card/pulls/42/merge", {}, {}),
      ).rejects.toThrow("merge blocked")

      expect(fixture.marks.some((item) => String(item.last_reason).includes("GLM code-reviewer"))).toBe(true)
    } finally {
      restore()
    }
  })

  test("blocks GitHub API pull request merge bypasses with equals method flags", async () => {
    await using fixture = await context()
    const restore = fakeGh((args) => {
      if (args[0] === "pr" && args[1] === "checks") return { stdout: "build\tpass\t0\thttps://example.test/check\n" }
      if (args[0] === "pr" && args[1] === "diff") return { stdout: "packages/opencode/src/api-merge.ts\n" }
      return {}
    })
    try {
      const git = createGitHandlers(fixture.ctx, review())

      await expect(
        git.bashBeforeGit("gh api --method=PUT repos/Cor-Incorporated/nfc-profile-card/pulls/42/merge", {}, {}),
      ).rejects.toThrow("merge blocked")
    } finally {
      restore()
    }
  })

  test("blocks reset-to-base sync bypasses", async () => {
    await using fixture = await context()
    const git = createGitHandlers(fixture.ctx, review())

    await expect(git.bashBeforeGit("git reset --soft origin/dev", {}, {})).rejects.toThrow("reset-to-base sync blocked")

    expect(fixture.marks.at(-1)?.last_reason).toBe("branch reset sync blocked")
  })

  test("blocks direct pushes to dev default branch", async () => {
    await using fixture = await context()
    const git = createGitHandlers(fixture.ctx, review())

    await expect(git.bashBeforeGit("git push origin dev", {}, {})).rejects.toThrow(
      "direct push to protected branch blocked",
    )
    await expect(git.bashBeforeGit("git push origin main", {}, {})).rejects.toThrow(
      "direct push to protected branch blocked",
    )
  })

  test("blocks UAT PR merge commands without browser or live evidence", async () => {
    await using fixture = await context()
    const git = createGitHandlers(fixture.ctx, review())

    await expect(git.bashBeforeGit("gh pr merge 42 --merge # UX UAT browser-tested complete", {}, {})).rejects.toThrow(
      "UAT/UX/E2E/browser-tested issue or PR completion requires browser/live evidence markers",
    )

    expect(fixture.marks.at(-1)?.last_reason).toBe("UAT/browser evidence missing")
  })

  test("blocks Japanese UAT issue close commands without evidence", async () => {
    await using fixture = await context()
    const git = createGitHandlers(fixture.ctx, review())

    await expect(
      git.bashBeforeGit("gh issue close 42 --comment '操作テストはブラウザで確認済のためクローズ'", {}, {}),
    ).rejects.toThrow("UAT/UX/E2E/browser-tested issue or PR completion requires browser/live evidence markers")
  })

  test("does not treat missing browser evidence text as evidence", async () => {
    await using fixture = await context()
    const git = createGitHandlers(fixture.ctx, review())

    await expect(
      git.bashBeforeGit("gh issue close 42 --comment 'UAT complete but no browser evidence was captured'", {}, {}),
    ).rejects.toThrow("UAT/UX/E2E/browser-tested issue or PR completion requires browser/live evidence markers")
  })

  test("allows read-only UAT planning and investigation shell commands", async () => {
    await using fixture = await context()
    const git = createGitHandlers(fixture.ctx, review())

    await expect(
      git.bashBeforeGit(
        "rg -n 'UAT evidence plan investigation unverified blocker completion close merge PR ready' packages/guardrails",
        {},
        {},
      ),
    ).resolves.toBeUndefined()
  })

  test("allows UAT investigation comments that explicitly stay unverified", async () => {
    await using fixture = await context()
    const git = createGitHandlers(fixture.ctx, review())

    await expect(
      git.bashBeforeGit(
        "gh issue comment 42 --body 'Investigation complete: UAT remains unverified; blocker is OAuth sandbox outage. No browser evidence captured yet.'",
        {},
        {},
      ),
    ).resolves.toBeUndefined()

    expect(fixture.marks).toHaveLength(0)
  })

  test("allows UAT planning status comments without browser evidence", async () => {
    await using fixture = await context()
    const git = createGitHandlers(fixture.ctx, review())

    await expect(
      git.bashBeforeGit(
        "gh issue comment 42 --body 'Plan complete for UAT verification: inspect login flow, then capture browser evidence before close.'",
        {},
        {},
      ),
    ).resolves.toBeUndefined()
  })

  test("blocks UAT completion comments without browser or live evidence", async () => {
    await using fixture = await context()
    const git = createGitHandlers(fixture.ctx, review())

    await expect(
      git.bashBeforeGit("gh issue comment 42 --body 'UAT login flow complete and ready to close'", {}, {}),
    ).rejects.toThrow("UAT/UX/E2E/browser-tested issue or PR completion requires browser/live evidence markers")
  })

  test("blocks UAT PR ready commands without browser or live evidence", async () => {
    await using fixture = await context()
    const git = createGitHandlers(fixture.ctx, review())

    await expect(git.bashBeforeGit("gh pr ready 42 # UX UAT ready for review", {}, {})).rejects.toThrow(
      "UAT/UX/E2E/browser-tested issue or PR completion requires browser/live evidence markers",
    )
  })

  test("blocks GitHub API issue close mutations without browser or live evidence", async () => {
    await using fixture = await context()
    const git = createGitHandlers(fixture.ctx, review())

    await expect(
      git.bashBeforeGit(
        "gh api -X PATCH repos/Cor-Incorporated/opencode/issues/42 -f state=closed -f body='UAT complete'",
        {},
        {},
      ),
    ).rejects.toThrow("UAT/UX/E2E/browser-tested issue or PR completion requires browser/live evidence markers")
  })

  test("allows UAT issue close commands with browser and live evidence markers", async () => {
    await using fixture = await context()
    const git = createGitHandlers(fixture.ctx, review())

    await expect(
      git.bashBeforeGit(
        "gh issue close 42 --comment 'UAT passed. Browser evidence: artifacts/playwright/report/index.html. Live evidence: https://app.example.test/smoke'",
        {},
        {},
      ),
    ).resolves.toBeUndefined()

    expect(fixture.marks.some((item) => item.uat_evidence_done === true)).toBe(true)
  })

  test("allows UAT issue close commands with live evidence docs paths", async () => {
    await using fixture = await context()
    const git = createGitHandlers(fixture.ctx, review())

    await expect(
      git.bashBeforeGit(
        "gh issue close 42 --comment '操作テスト完了。docs/v2/live-evidence/uat-login-smoke.md にブラウザ証跡あり'",
        {},
        {},
      ),
    ).resolves.toBeUndefined()
  })

  test("allows UAT blocker issues without browser evidence", async () => {
    await using fixture = await context()
    const git = createGitHandlers(fixture.ctx, review())

    await expect(
      git.bashBeforeGit(
        "gh issue create --title 'UAT blocker: browser sign-in cannot start' --body 'unverified-restart-condition: OAuth sandbox is down' --label blocker",
        {},
        {},
      ),
    ).resolves.toBeUndefined()
  })

  test("allows non-UAT issue commands without browser evidence", async () => {
    await using fixture = await context()
    const git = createGitHandlers(fixture.ctx, review())

    await expect(
      git.bashBeforeGit("gh issue comment 42 --body 'Refactor cleanup note without user-journey scope'", {}, {}),
    ).resolves.toBeUndefined()
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

  test("exempts docs-only merge review gate based on diff, not branch prefix", async () => {
    await using fixture = await diffFixture("docs/guardrails.md")
    const git = createGitHandlers(fixture.ctx, review())

    await expect(git.bashBeforeGit("git merge dev", {}, {})).resolves.toBeUndefined()

    expect(fixture.marks.some((item) => item.merge_review_tier === "DOCS_ONLY")).toBe(true)
  })

  test("does not let stale review findings block docs-only merges", async () => {
    await using fixture = await diffFixture("docs/guardrails.md")
    const git = createGitHandlers(fixture.ctx, review())

    await expect(
      git.bashBeforeGit("git merge dev", {}, { review_critical_count: 1, review_high_count: 1 }),
    ).resolves.toBeUndefined()

    expect(fixture.marks.some((item) => item.merge_review_tier === "DOCS_ONLY")).toBe(true)
  })

  test.serial("allows docs-only GitHub PR files with green checks to merge without review state", async () => {
    await using fixture = await diffFixture("packages/opencode/src/ignored-by-pr-files.ts")
    await Bun.$`git remote add origin git@github.com:owner/repo.git`.cwd(fixture.ctx.input.worktree).quiet()
    const restore = fakePrMergeGh({ files: ["docs/guardrails.md", "README.md"] })
    try {
      await expect(
        createGitHandlers(fixture.ctx, review()).bashBeforeGit("gh pr merge 170 --merge", {}, {}),
      ).resolves.toBeUndefined()
      expect(fixture.marks.some((item) => item.merge_review_tier === "DOCS_ONLY")).toBe(true)
    } finally {
      restore()
    }
  })

  test.serial("allows PR merge when passing check text mentions skipped review", async () => {
    await using fixture = await diffFixture("packages/opencode/src/ignored-by-pr-files.ts")
    await Bun.$`git remote add origin git@github.com:owner/repo.git`.cwd(fixture.ctx.input.worktree).quiet()
    const restore = fakePrMergeGh({
      files: ["docs/guardrails.md"],
      checks: JSON.stringify([
        {
          bucket: "pass",
          name: "CodeRabbit",
          state: "SUCCESS",
          workflow: "Review skipped: reviews are disabled for this base branch",
          link: "https://example.test/stale-cache",
        },
      ]),
    })
    try {
      await expect(
        createGitHandlers(fixture.ctx, review()).bashBeforeGit("gh pr merge 170 --merge", {}, {}),
      ).resolves.toBeUndefined()
      expect(fixture.marks.some((item) => item.ci_green === true)).toBe(true)
    } finally {
      restore()
    }
  })

  test.serial("blocks docs-only GitHub PR files when checks are queued", async () => {
    await using fixture = await diffFixture("packages/opencode/src/ignored-by-pr-files.ts")
    await Bun.$`git remote add origin git@github.com:owner/repo.git`.cwd(fixture.ctx.input.worktree).quiet()
    const restore = fakePrMergeGh({
      files: ["docs/guardrails.md"],
      checks: "build\tqueued\t0\thttps://example.test/check\n",
    })
    try {
      await expect(
        createGitHandlers(fixture.ctx, review()).bashBeforeGit("gh pr merge 170 --merge", {}, {}),
      ).rejects.toThrow("CI checks not all green")
      expect(fixture.marks.at(-1)?.last_reason).toBe("CI checks not all green")
    } finally {
      restore()
    }
  })

  test.serial("blocks PR merge when checks output is empty", async () => {
    await using fixture = await diffFixture("docs/guardrails.md")
    await Bun.$`git remote add origin git@github.com:owner/repo.git`.cwd(fixture.ctx.input.worktree).quiet()
    const restore = fakePrMergeGh({ files: ["docs/guardrails.md"], checks: "" })
    try {
      await expect(
        createGitHandlers(fixture.ctx, review()).bashBeforeGit("gh pr merge 170 --merge", {}, {}),
      ).rejects.toThrow("CI checks not all green")
      expect(fixture.marks.at(-1)?.last_reason).toBe("CI checks not all green")
    } finally {
      restore()
    }
  })

  test.serial("blocks PR merge when changed file classification is unavailable", async () => {
    await using fixture = await diffFixture("docs/guardrails.md")
    await Bun.$`git remote add origin git@github.com:owner/repo.git`.cwd(fixture.ctx.input.worktree).quiet()
    const restore = fakeGh((args) => {
      if (args[0] === "pr" && args[1] === "checks") return { stdout: "build\tpass\t0\thttps://example.test/check\n" }
      if (args[0] === "api" && args[1] === "repos/owner/repo/pulls/170/files") return { code: 1 }
      if (args[0] === "pr" && args[1] === "view") return { code: 1 }
      if (args[0] === "pr" && args[1] === "diff") return { code: 1 }
      return {}
    })
    try {
      await expect(
        createGitHandlers(fixture.ctx, review()).bashBeforeGit("gh pr merge 170 --merge", {}, {}),
      ).rejects.toThrow("changed file classification unavailable")
      expect(fixture.marks.at(-1)?.last_reason).toBe("merge classification unavailable")
    } finally {
      restore()
    }
  })

  test.serial("allows FULL tier PR merge after hydrating matching review evidence", async () => {
    await using fixture = await diffFixture("packages/opencode/src/fresh-review-evidence.ts")
    await Bun.$`git remote add origin git@github.com:owner/repo.git`.cwd(fixture.ctx.input.worktree).quiet()
    const calls: string[] = []
    const restore = fakePrMergeGh({
      pr: "42",
      files: ["packages/opencode/src/fresh-review-evidence.ts"],
      headRefOid: "abc123",
      author: "alice",
      approvals: ["bob"],
    })
    try {
      await expect(
        createGitHandlers(
          fixture.ctx,
          review({
            async hydrateReviewEvidence(expectedHead) {
              calls.push(expectedHead ?? "")
              await fixture.ctx.mark({
                review_glm_state: "done",
                review_codex_state: "done",
                reviewed_head_sha: "abc123",
                review_evidence_state: "restored",
                review_critical_count: 0,
                review_high_count: 0,
                edits_since_review: 0,
              })
              return true
            },
          }),
        ).bashBeforeGit("gh pr merge 42 --merge", {}, {}),
      ).resolves.toBeUndefined()

      expect(calls).toEqual(["abc123"])
      expect(fixture.marks.some((item) => item.merge_review_tier === "FULL")).toBe(true)
    } finally {
      restore()
    }
  })

  test.serial("blocks FULL tier PR merge when hydrated evidence head does not match PR head", async () => {
    await using fixture = await diffFixture("packages/opencode/src/stale-review-evidence.ts")
    await Bun.$`git remote add origin git@github.com:owner/repo.git`.cwd(fixture.ctx.input.worktree).quiet()
    const restore = fakePrMergeGh({
      pr: "42",
      files: ["packages/opencode/src/stale-review-evidence.ts"],
      headRefOid: "newhead",
    })
    try {
      await expect(
        createGitHandlers(
          fixture.ctx,
          review({
            async hydrateReviewEvidence() {
              await fixture.ctx.mark({
                review_glm_state: "done",
                review_codex_state: "done",
                reviewed_head_sha: "oldhead",
                review_evidence_state: "restored",
                review_critical_count: 0,
                review_high_count: 0,
                edits_since_review: 0,
              })
              return true
            },
          }),
        ).bashBeforeGit("gh pr merge 42 --merge", {}, {}),
      ).rejects.toThrow("restored review evidence was captured for a different PR HEAD")

      expect(fixture.marks.at(-1)?.last_reason).toBe("review evidence HEAD mismatch")
    } finally {
      restore()
    }
  })

  test.serial("blocks FULL tier PR merge when existing review state lacks reviewed HEAD evidence", async () => {
    await using fixture = await diffFixture("packages/opencode/src/done-without-head.ts")
    await Bun.$`git remote add origin git@github.com:owner/repo.git`.cwd(fixture.ctx.input.worktree).quiet()
    const restore = fakePrMergeGh({
      pr: "42",
      files: ["packages/opencode/src/done-without-head.ts"],
      headRefOid: "abc123",
    })
    try {
      await expect(
        createGitHandlers(fixture.ctx, review()).bashBeforeGit(
          "gh pr merge 42 --merge",
          {},
          {
            review_glm_state: "done",
            review_codex_state: "done",
            review_critical_count: 0,
            review_high_count: 0,
            edits_since_review: 0,
          },
        ),
      ).rejects.toThrow("restored review evidence is missing the reviewed HEAD SHA")

      expect(fixture.marks.at(-1)?.last_reason).toBe("review evidence missing reviewed HEAD SHA")
    } finally {
      restore()
    }
  })

  test.serial("blocks FULL tier PR merge when state only has generic head evidence", async () => {
    await using fixture = await diffFixture("packages/opencode/src/done-with-generic-head.ts")
    await Bun.$`git remote add origin git@github.com:owner/repo.git`.cwd(fixture.ctx.input.worktree).quiet()
    const restore = fakePrMergeGh({
      pr: "42",
      files: ["packages/opencode/src/done-with-generic-head.ts"],
      headRefOid: "abc123",
    })
    try {
      await expect(
        createGitHandlers(fixture.ctx, review()).bashBeforeGit(
          "gh pr merge 42 --merge",
          {},
          {
            review_glm_state: "done",
            review_codex_state: "done",
            head: "abc123",
            head_sha: "abc123",
            review_critical_count: 0,
            review_high_count: 0,
            edits_since_review: 0,
          },
        ),
      ).rejects.toThrow("restored review evidence is missing the reviewed HEAD SHA")

      expect(fixture.marks.at(-1)?.last_reason).toBe("review evidence missing reviewed HEAD SHA")
    } finally {
      restore()
    }
  })

  test.serial("blocks FULL tier PR merge when existing review evidence head does not match PR head", async () => {
    await using fixture = await diffFixture("packages/opencode/src/done-with-stale-head.ts")
    await Bun.$`git remote add origin git@github.com:owner/repo.git`.cwd(fixture.ctx.input.worktree).quiet()
    const restore = fakePrMergeGh({
      pr: "42",
      files: ["packages/opencode/src/done-with-stale-head.ts"],
      headRefOid: "newhead",
    })
    try {
      await expect(
        createGitHandlers(fixture.ctx, review()).bashBeforeGit(
          "gh pr merge 42 --merge",
          {},
          {
            review_glm_state: "done",
            review_codex_state: "done",
            reviewed_head_sha: "oldhead",
            review_critical_count: 0,
            review_high_count: 0,
            edits_since_review: 0,
          },
        ),
      ).rejects.toThrow("restored review evidence was captured for a different PR HEAD")

      expect(fixture.marks.at(-1)?.last_reason).toBe("review evidence HEAD mismatch")
    } finally {
      restore()
    }
  })

  test.serial("blocks FULL tier PR merge when hydrate refuses PR head mismatch", async () => {
    await using fixture = await diffFixture("packages/opencode/src/refused-review-evidence.ts")
    await Bun.$`git remote add origin git@github.com:owner/repo.git`.cwd(fixture.ctx.input.worktree).quiet()
    const calls: string[] = []
    const restore = fakePrMergeGh({
      pr: "42",
      files: ["packages/opencode/src/refused-review-evidence.ts"],
      headRefOid: "newhead",
    })
    try {
      await expect(
        createGitHandlers(
          fixture.ctx,
          review({
            async hydrateReviewEvidence(expectedHead) {
              calls.push(expectedHead ?? "")
              await fixture.ctx.mark({ review_evidence_state: "stale", review_evidence_reason: "pr_head_mismatch" })
              return false
            },
          }),
        ).bashBeforeGit("gh pr merge 42 --merge", {}, { review_codex_state: "done" }),
      ).rejects.toThrow("review evidence not accepted: pr_head_mismatch")

      expect(calls).toEqual(["newhead"])
      expect(fixture.marks.at(-1)?.last_reason).toBe(
        "FULL tier: pending: GLM code-reviewer; review evidence not accepted: pr_head_mismatch",
      )
    } finally {
      restore()
    }
  })

  test.serial("blocks FULL tier PR merge without hydrated review evidence", async () => {
    await using fixture = await diffFixture("packages/opencode/src/missing-review-evidence.ts")
    await Bun.$`git remote add origin git@github.com:owner/repo.git`.cwd(fixture.ctx.input.worktree).quiet()
    const restore = fakePrMergeGh({
      pr: "42",
      files: ["packages/opencode/src/missing-review-evidence.ts"],
      headRefOid: "abc123",
    })
    try {
      await expect(
        createGitHandlers(
          fixture.ctx,
          review({
            hydrateReviewEvidence() {},
          }),
        ).bashBeforeGit("gh pr merge 42 --merge", {}, { review_codex_state: "done" }),
      ).rejects.toThrow("pending: GLM code-reviewer")

      expect(fixture.marks.at(-1)?.last_reason).toBe("FULL tier: pending: GLM code-reviewer")
    } finally {
      restore()
    }
  })

  test("blocks full source merges when restored severe count is present without critical or high counts", async () => {
    await using fixture = await diffFixture("packages/opencode/src/severe-review-evidence.ts")
    const git = createGitHandlers(fixture.ctx, review())

    await expect(
      git.bashBeforeGit(
        "git merge dev",
        {},
        {
          review_glm_state: "done",
          review_codex_state: "done",
          reviewed_head_sha: "abc123",
          review_critical_count: 0,
          review_high_count: 0,
          review_severe_count: 1,
          edits_since_review: 0,
        },
      ),
    ).rejects.toThrow("SEVERE=1")

    expect(fixture.marks.at(-1)?.last_reason).toBe("unresolved CRITICAL=0 HIGH=0 SEVERE=1")
  })

  test.serial("keeps queued CI blocking before PR merge review hydration", async () => {
    await using fixture = await diffFixture("packages/opencode/src/ci-before-hydration.ts")
    const calls: string[] = []
    const restore = fakeGh((args) =>
      args[0] === "pr" && args[1] === "checks" ? { stdout: "build\tqueued\t0\thttps://example.test/check\n" } : {},
    )
    try {
      await expect(
        createGitHandlers(
          fixture.ctx,
          review({
            async hydrateReviewEvidence(expectedHead) {
              calls.push(expectedHead ?? "")
              await fixture.ctx.mark({
                review_glm_state: "done",
                review_codex_state: "done",
                reviewed_head_sha: "abc123",
                review_evidence_state: "restored",
              })
              return true
            },
          }),
        ).bashBeforeGit("gh pr merge 42 --merge", {}, {}),
      ).rejects.toThrow("CI checks not all green")

      expect(calls).toEqual([])
      expect(fixture.marks.at(-1)?.last_reason).toBe("CI checks not all green")
    } finally {
      restore()
    }
  })

  test("treats guardrail profile markdown as full review tier", async () => {
    await using fixture = await diffFixture("packages/guardrails/profile/commands/ship.md")
    const git = createGitHandlers(fixture.ctx, review())

    await expect(git.bashBeforeGit("git merge dev", {}, {})).rejects.toThrow("merge blocked (FULL tier)")
    expect(fixture.marks.some((item) => item.merge_review_tier === "FULL")).toBe(true)
    expect(fixture.marks.some((item) => item.merge_review_tier === "DOCS_ONLY")).toBe(false)
  })

  test("treats GitHub workflow changes as full review tier", async () => {
    await using fixture = await diffFixture(".github/workflows/ci.yml")
    const git = createGitHandlers(fixture.ctx, review())

    await expect(git.bashBeforeGit("git merge dev", {}, {})).rejects.toThrow("merge blocked (FULL tier)")
    expect(fixture.marks.some((item) => item.merge_review_tier === "FULL")).toBe(true)
    expect(fixture.marks.some((item) => item.merge_review_tier === "LIGHT")).toBe(false)
  })

  test("treats runtime config as full review tier", async () => {
    await using fixture = await diffFixture("packages/opencode/opencode.json")
    const git = createGitHandlers(fixture.ctx, review())

    await expect(git.bashBeforeGit("git merge dev", {}, {})).rejects.toThrow("merge blocked (FULL tier)")
    expect(fixture.marks.some((item) => item.merge_review_tier === "FULL")).toBe(true)
  })

  test("treats agent instructions as full review tier", async () => {
    await using fixture = await diffFixture("AGENTS.md")
    const git = createGitHandlers(fixture.ctx, review())

    await expect(git.bashBeforeGit("git merge dev", {}, {})).rejects.toThrow("merge blocked (FULL tier)")
    expect(fixture.marks.some((item) => item.merge_review_tier === "FULL")).toBe(true)
  })

  test("allows low-risk test-only merge with clean review checks", async () => {
    await using fixture = await diffFixture("packages/opencode/test/plugin/example.test.ts")
    const git = createGitHandlers(fixture.ctx, review())

    await expect(
      git.bashBeforeGit("git merge dev", {}, { review_checks_at: "2026-05-21T00:00:00.000Z" }),
    ).resolves.toBeUndefined()

    expect(fixture.marks.some((item) => item.merge_review_tier === "LIGHT")).toBe(true)
  })

  test("keeps generated and config-only merges in light review tier", async () => {
    await using fixture = await diffFixture("packages/sdk/js/src/v2/gen/types.gen.ts")
    const git = createGitHandlers(fixture.ctx, review())

    await expect(
      git.bashBeforeGit("git merge dev", {}, { review_checks_at: "2026-05-21T00:00:00.000Z" }),
    ).resolves.toBeUndefined()

    expect(fixture.marks.some((item) => item.merge_review_tier === "LIGHT")).toBe(true)
  })

  test("keeps full source merges behind both review gates", async () => {
    await using fixture = await diffFixture("packages/opencode/src/example.ts")
    const git = createGitHandlers(fixture.ctx, review())

    await expect(git.bashBeforeGit("git merge dev", {}, {})).rejects.toThrow("merge blocked (FULL tier)")

    expect(fixture.marks.some((item) => item.merge_review_tier === "FULL")).toBe(true)
  })

  test("blocks chore branch merges without lightweight review evidence", async () => {
    await using fixture = await branchFixture("chore/dependency-refresh")
    const git = createGitHandlers(fixture.ctx, review())

    await expect(git.bashBeforeGit("git merge dev", {}, {})).rejects.toThrow("merge blocked (LIGHT tier)")
    expect(String(fixture.marks.at(-1)?.last_reason)).toContain("LIGHT tier")
  })

  test("blocks fix branch merges without lightweight review evidence", async () => {
    await using fixture = await branchFixture("fix/null-state")
    const git = createGitHandlers(fixture.ctx, review())

    await expect(git.bashBeforeGit("git merge dev", {}, {})).rejects.toThrow("merge blocked (LIGHT tier)")
    expect(String(fixture.marks.at(-1)?.last_reason)).toContain("LIGHT tier")
  })

  test("blocks full source merges when code-reviewer state is missing", async () => {
    await using fixture = await diffFixture("packages/opencode/src/missing-review.ts")
    const git = createGitHandlers(fixture.ctx, review())

    await expect(git.bashBeforeGit("git merge dev", {}, { review_codex_state: "done" })).rejects.toThrow(
      "pending: GLM code-reviewer",
    )

    expect(fixture.marks.at(-1)?.last_reason).toBe("FULL tier: pending: GLM code-reviewer")
  })

  test("blocks full source merges when reviews became stale after edits", async () => {
    await using fixture = await diffFixture("packages/opencode/src/stale-after-review.ts")
    const git = createGitHandlers(fixture.ctx, review())

    await expect(
      git.bashBeforeGit(
        "git merge dev",
        {},
        {
          review_glm_state: "done",
          review_codex_state: "done",
          edits_since_review: 1,
        },
      ),
    ).rejects.toThrow("reviews are stale")

    expect(fixture.marks.at(-1)?.last_reason).toBe("FULL tier: reviews stale after 1 edit(s)")
  })

  test.serial("blocks PR merge when CI is queued", async () => {
    await using fixture = await diffFixture("packages/opencode/src/ci-queued.ts")
    const restore = fakeGh((args) =>
      args[0] === "pr" && args[1] === "checks" ? { stdout: "build\tqueued\t0\thttps://example.test/check\n" } : {},
    )
    try {
      await expect(
        createGitHandlers(fixture.ctx, review()).bashBeforeGit(
          "gh pr merge 42 --merge",
          {},
          {
            review_glm_state: "done",
            review_codex_state: "done",
          },
        ),
      ).rejects.toThrow("CI checks not all green")
      expect(fixture.marks.at(-1)?.last_reason).toBe("CI checks not all green")
    } finally {
      restore()
    }
  })

  test.serial("blocks PR merge when code was pushed after review", async () => {
    await using fixture = await diffFixture("packages/opencode/src/stale-review.ts")
    const restore = fakeGh(() => ({}))
    try {
      await expect(
        createGitHandlers(fixture.ctx, review()).bashBeforeGit(
          "gh pr merge 42 --merge",
          {},
          {
            review_glm_state: "done",
            review_codex_state: "done",
            review_at: "2026-05-21T00:00:00.000Z",
            last_push_at: "2026-05-21T01:00:00.000Z",
          },
        ),
      ).rejects.toThrow("code was pushed after the last review")
      expect(fixture.marks.at(-1)?.last_reason).toBe("stale review: push after review")
    } finally {
      restore()
    }
  })

  test.serial("blocks PR merge when the only approval is from the PR author", async () => {
    await using fixture = await diffFixture("packages/opencode/src/self-approved.ts")
    await Bun.$`git remote add origin git@github.com:owner/repo.git`.cwd(fixture.ctx.input.worktree).quiet()
    const restore = fakeGh((args) => {
      if (args[0] === "pr" && args[1] === "checks") return { stdout: "build\tpass\t0\thttps://example.test/check\n" }
      if (args[0] === "pr" && args[1] === "view" && args.includes("headRefOid")) return { stdout: "abc123\n" }
      if (args[0] === "api" && args[1] === "repos/owner/repo/pulls/42/files") {
        return { stdout: "packages/opencode/src/self-approved.ts\n" }
      }
      if (args[0] === "api" && args[1] === "repos/owner/repo/pulls/42") return { stdout: "alice\n" }
      if (args[0] === "api" && args[1] === "repos/owner/repo/pulls/42/reviews" && args[3]?.includes("APPROVED")) {
        return { stdout: "alice\n" }
      }
      if (
        args[0] === "api" &&
        args[1] === "repos/owner/repo/pulls/42/reviews" &&
        args[3]?.includes("CHANGES_REQUESTED")
      ) {
        return { stdout: "0\n" }
      }
      return {}
    })
    try {
      await expect(
        createGitHandlers(fixture.ctx, review()).bashBeforeGit(
          "gh pr merge 42 --merge",
          {},
          {
            review_glm_state: "done",
            review_codex_state: "done",
            reviewed_head_sha: "abc123",
          },
        ),
      ).rejects.toThrow("PR approval cannot come only from the PR author")
      expect(fixture.marks.at(-1)?.last_reason).toBe("only PR author approvals present")
    } finally {
      restore()
    }
  })

  test.serial("rehydrates review evidence for FULL tier PR merges after session reset", async () => {
    await using fixture = await diffFixture("packages/opencode/src/review-evidence.ts")
    await Bun.$`git remote add origin git@github.com:owner/repo.git`.cwd(fixture.ctx.input.worktree).quiet()
    const evidence = [
      'gstack-review-log {"skill":"code-reviewer","timestamp":"2026-07-01T00:00:00Z","status":"pass"}',
      'gstack-review-log {"skill":"codex-review","timestamp":"2026-07-01T00:01:00Z","status":"pass"}',
      "Review completed. CRITICAL=0 HIGH=0.",
    ].join("\n")
    const resetState = {
      review_state: "",
      review_glm_state: "",
      review_codex_state: "",
      review_at: "",
      edits_since_review: 0,
      review_critical_count: 0,
      review_high_count: 0,
      ci_green: false,
    }
    const restore = fakeGh((args) => {
      const command = args.join(" ")
      if (args[0] === "pr" && args[1] === "checks") return { stdout: "build\tpass\t0\thttps://example.test/check\n" }
      if (args[0] === "pr" && args[1] === "list") return { stdout: "" }
      if (args[0] === "pr" && args[1] === "view" && args.includes("headRefOid")) return { stdout: "abc123\n" }
      if (args[0] === "pr" && args[1] === "view" && args.includes("--json")) {
        return {
          stdout: `${JSON.stringify({
            comments: [{ body: evidence }],
            reviews: [{ author: { login: "reviewer" }, body: evidence, state: "COMMENTED" }],
          })}\n`,
        }
      }
      if (args[0] === "pr" && args[1] === "view") return { stdout: `${evidence}\n` }
      if (args[0] === "api" && args[1] === "repos/owner/repo/pulls/42/files") {
        return { stdout: "packages/opencode/src/review-evidence.ts\n" }
      }
      if (args[0] === "api" && args[1] === "repos/owner/repo/pulls/42") return { stdout: "alice\n" }
      if (args[0] === "api" && args[1] === "repos/owner/repo/issues/42/comments") {
        if (args.includes("--jq")) return { stdout: `${evidence}\n` }
        return { stdout: `${JSON.stringify([{ body: evidence }])}\n` }
      }
      if (args[0] === "api" && args[1] === "repos/owner/repo/pulls/42/reviews") {
        if (command.includes("CHANGES_REQUESTED")) return { stdout: "0\n" }
        if (command.includes("APPROVED") && command.includes("@tsv")) return { stdout: "reviewer\n" }
        if (args.includes("--jq")) return { stdout: `${evidence}\n` }
        return {
          stdout: `${JSON.stringify([
            { body: evidence, state: "COMMENTED", user: { login: "code-reviewer" } },
            { body: evidence, state: "APPROVED", user: { login: "reviewer" } },
          ])}\n`,
        }
      }
      return {}
    })
    try {
      await Bun.write(fixture.ctx.state, JSON.stringify(resetState, null, 2))

      await expect(
        createGitHandlers(
          fixture.ctx,
          review({
            async hydrateReviewEvidence(expectedHead) {
              expect(expectedHead).toBe("abc123")
              await fixture.ctx.mark({
                review_glm_state: "done",
                review_codex_state: "done",
                reviewed_head_sha: "abc123",
                review_evidence_state: "restored",
                review_critical_count: 0,
                review_high_count: 0,
                edits_since_review: 0,
              })
              return true
            },
          }),
        ).bashBeforeGit("gh pr merge 42 --merge", {}, resetState),
      ).resolves.toBeUndefined()

      expect(fixture.marks.some((item) => item.ci_green === true)).toBe(true)
      expect(fixture.marks.some((item) => item.merge_review_tier === "FULL")).toBe(true)
    } finally {
      restore()
    }
  })

  test("blocks opencode PR creation unless it targets fork dev", async () => {
    await using fixture = await opencodeFixture()
    const git = createGitHandlers(fixture.ctx, review())
    const data = { tests_executed: true, type_checked: true }

    await expect(
      git.bashBeforeGit(
        "gh pr create --repo=anomalyco/opencode --base=dev --title 'fix: guard' --body 'Closes #1'",
        {},
        data,
      ),
    ).rejects.toThrow("opencode PR creation blocked")

    await expect(
      git.bashBeforeGit(
        "gh pr create -RCor-Incorporated/opencode --base=main --title 'fix: guard' --body 'Closes #1'",
        {},
        data,
      ),
    ).rejects.toThrow("opencode PR creation blocked")

    await expect(
      git.bashBeforeGit(
        "gh pr create -R Cor-Incorporated/opencode -B dev --head=anomalyco:feature --title 'fix: guard' --body 'Closes #1'",
        {},
        data,
      ),
    ).rejects.toThrow("opencode PR creation blocked")

    await expect(
      git.bashBeforeGit(
        "gh pr create -R Cor-Incorporated/opencode -B dev --head=other-owner:feature --title 'fix: guard' --body 'Closes #1'",
        {},
        data,
      ),
    ).rejects.toThrow("opencode PR creation blocked")

    await expect(
      git.bashBeforeGit(
        "gh pr create -R Cor-Incorporated/opencode -B dev --head feature --title 'fix: guard' --body 'Closes #1'",
        {},
        data,
      ),
    ).resolves.toBeUndefined()

    await expect(
      git.bashBeforeGit(
        "gh api repos/Cor-Incorporated/opencode/pulls --method GET&&gh pr create -R anomalyco/opencode -B dev --title 'fix: guard' --body 'Closes #1'",
        {},
        data,
      ),
    ).rejects.toThrow("opencode PR creation blocked")
  })

  test("blocks opencode GitHub API PR creation bypasses", async () => {
    await using fixture = await opencodeFixture()
    const git = createGitHandlers(fixture.ctx, review())

    await expect(
      git.bashBeforeGit(
        "gh api https://api.github.com/repos/anomalyco/opencode/pulls -f title='fix: guard' -f head=feature -f base=dev",
        {},
        {},
      ),
    ).rejects.toThrow("REST pull request creation blocked")

    await expect(
      git.bashBeforeGit(
        "gh api repos/anomalyco/opencode/pulls/ -f title='fix: guard' -f head=feature -f base=dev",
        {},
        {},
      ),
    ).rejects.toThrow("REST pull request creation blocked")

    await expect(
      git.bashBeforeGit(
        "gh api /repos/Cor-Incorporated/opencode/pulls -F title='fix: guard' -F head=feature -F base=main",
        {},
        {},
      ),
    ).rejects.toThrow("REST pull request creation blocked")

    await expect(
      git.bashBeforeGit(
        "gh api repos/Cor-Incorporated/opencode/pulls --raw-field title='fix: guard' --field head=anomalyco:feature --field base=dev",
        {},
        {},
      ),
    ).rejects.toThrow("REST pull request creation blocked")

    await expect(
      git.bashBeforeGit("gh api repos/Cor-Incorporated/opencode/pulls --input payload.json", {}, {}),
    ).rejects.toThrow("REST pull request creation blocked")

    await expect(
      git.bashBeforeGit(
        "gh api repos/Cor-Incorporated/opencode/pulls -f title='fix: guard' -f head=feature -f base=dev",
        {},
        {},
      ),
    ).rejects.toThrow("REST pull request creation blocked")
  })

  test("allows read-only opencode GitHub API PR listing", async () => {
    await using fixture = await opencodeFixture()
    const git = createGitHandlers(fixture.ctx, review())

    await expect(
      git.bashBeforeGit("gh api repos/anomalyco/opencode/pulls --method GET", {}, {}),
    ).resolves.toBeUndefined()

    await expect(
      git.bashBeforeGit("gh api repos/anomalyco/opencode/pulls --method GET --input payload.json", {}, {}),
    ).resolves.toBeUndefined()
  })

  test("blocks opencode GraphQL createPullRequest mutations", async () => {
    await using fixture = await opencodeFixture()
    const git = createGitHandlers(fixture.ctx, review())
    await Bun.write(
      path.join(fixture.ctx.input.worktree, "create-pr.graphql"),
      'mutation Create { createPullRequest(input: { repositoryId: "repo", baseRefName: "main", headRefName: "feature", title: "x" }) { pullRequest { number } } }',
    )
    await Bun.write(
      path.join(fixture.ctx.input.worktree, "create-pr.json"),
      '{"query":"mutation Create { createPullRequest(input: { repositoryId: \\"repo\\" }) { clientMutationId } }"}',
    )

    await expect(
      git.bashBeforeGit(
        "gh api https://api.github.com/graphql/ -f query='mutation { createPullRequest(input: { repositoryId: \"repo\" }) { pullRequest { number } } }'",
        {},
        {},
      ),
    ).rejects.toThrow("GraphQL createPullRequest mutation blocked")

    await expect(
      git.bashBeforeGit(
        "gh api graphql --method POST --field query='mutation Create { createPullRequest(input: { repositoryId: \"repo\" }) { clientMutationId } }'",
        {},
        {},
      ),
    ).rejects.toThrow("GraphQL createPullRequest mutation blocked")

    await expect(git.bashBeforeGit("gh api graphql -F query=@create-pr.graphql", {}, {})).rejects.toThrow(
      "GraphQL createPullRequest mutation blocked",
    )

    await expect(git.bashBeforeGit("gh api graphql --input create-pr.json", {}, {})).rejects.toThrow(
      "GraphQL createPullRequest mutation blocked",
    )

    await expect(git.bashBeforeGit("gh api graphql -F query=@-", {}, {})).rejects.toThrow(
      "GraphQL createPullRequest mutation blocked",
    )

    await expect(git.bashBeforeGit("gh api graphql -f query=$QUERY", {}, {})).rejects.toThrow(
      "GraphQL createPullRequest mutation blocked",
    )

    await expect(git.bashBeforeGit('gh api graphql -f query="$(cat create-pr.graphql)"', {}, {})).rejects.toThrow(
      "GraphQL createPullRequest mutation blocked",
    )
  })

  test("allows read-only opencode GraphQL queries", async () => {
    await using fixture = await opencodeFixture()
    const git = createGitHandlers(fixture.ctx, review())
    await Bun.write(path.join(fixture.ctx.input.worktree, "viewer.graphql"), "query Viewer { viewer { login } }")
    await Bun.write(
      path.join(fixture.ctx.input.worktree, "viewer.json"),
      '{"query":"query Viewer { viewer { login } }"}',
    )

    await expect(
      git.bashBeforeGit("gh api graphql -f query='query Viewer { viewer { login } }'", {}, {}),
    ).resolves.toBeUndefined()

    await expect(
      git.bashBeforeGit(
        "gh api graphql -f query='query Viewer($login: String!) { user(login: $login) { id } }'",
        {},
        {},
      ),
    ).resolves.toBeUndefined()

    await expect(git.bashBeforeGit("gh api graphql -F query=@viewer.graphql", {}, {})).resolves.toBeUndefined()

    await expect(git.bashBeforeGit("gh api graphql --input viewer.json", {}, {})).resolves.toBeUndefined()
  })

  test("uses dev branch for PR deploy verification and main-base blocking", async () => {
    await using fixture = await diffFixture("scripts/local-dev-deploy.sh")
    const git = createGitHandlers(fixture.ctx, review())

    await expect(
      git.bashBeforeGit(
        "gh pr create --base dev --title 'fix: deploy check' --body 'Closes #1'",
        {},
        {
          tests_executed: true,
          type_checked: true,
        },
      ),
    ).resolves.toBeUndefined()
    expect(fixture.marks.some((item) => item.deploy_verify_warning === true)).toBe(true)

    await expect(
      git.bashBeforeGit(
        "gh pr create --base main --title 'fix: deploy check' --body 'Closes #1'",
        {},
        {
          tests_executed: true,
          type_checked: true,
        },
      ),
    ).rejects.toThrow("PR targeting main blocked")
  })
})
