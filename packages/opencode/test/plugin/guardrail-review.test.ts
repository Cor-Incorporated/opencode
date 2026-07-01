import { expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { createReviewPipeline } from "../../../../packages/guardrails/profile/plugins/guardrail-review"
import type { GuardrailContext } from "../../../../packages/guardrails/profile/plugins/guardrail-context"
import { tmpdir } from "../fixture/fixture"

async function gitOutput(dir: string, args: string[]) {
  const proc = Bun.spawn(["git", ...args], {
    cwd: dir,
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  if (code !== 0) throw new Error(stderr || `git ${args.join(" ")} failed`)
  return stdout.trim()
}

function statePath(dir: string) {
  return path.join(dir, ".opencode", "guardrails", "state.json")
}

function evidencePath(dir: string) {
  return path.join(dir, ".opencode", "guardrails", "review-evidence.json")
}

async function context(state: string, worktree = path.dirname(path.dirname(path.dirname(state)))) {
  const events: Record<string, unknown>[] = []
  const ctx: GuardrailContext = {
    input: {
      client: {} as GuardrailContext["input"]["client"],
      directory: worktree,
      worktree,
    },
    mode: "enforced",
    root: path.dirname(state),
    log: path.join(path.dirname(state), "events.jsonl"),
    state,
    allow: {},
    hasCodexMcp: true,
    maxParallelTasks: 5,
    maxSessionCost: 10,
    agentModelTier: {},
    tierModels: {},
    domainDirs: {},
    async mark(data) {
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
    async seen(type, data) {
      events.push({ type, ...data })
    },
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
  return { ctx, events }
}

test("external opencode review saves durable evidence for current HEAD", async () => {
  await using tmp = await tmpdir({ git: true })
  const state = statePath(tmp.path)
  await fs.mkdir(path.dirname(state), { recursive: true })
  await Bun.write(state, JSON.stringify({ review_codex_state: "done" }))
  const { ctx } = await context(state, tmp.path)

  await createReviewPipeline(ctx).handleExternalReviewDetection(
    { tool: "bash", args: { command: "opencode run /review" } },
    { output: "Review completed. No critical or high issues found.", metadata: { exitCode: 0 } },
  )

  const evidence = await Bun.file(evidencePath(tmp.path)).json()
  expect(evidence.reviewed_head_sha).toBe(await gitOutput(tmp.path, ["rev-parse", "HEAD"]))
  expect(evidence.review_branch).toBe(await gitOutput(tmp.path, ["branch", "--show-current"]))
  expect(evidence.review_worktree_clean).toBe(true)
  expect(evidence.review_dirty_count).toBe(0)
  expect(evidence.review_glm_state).toBe("done")
  expect(evidence.review_codex_state).toBe("done")
  expect(evidence.review_state).toBe("done")
  expect(evidence.review_agent).toBe("opencode:review")
  expect(evidence.review_critical_count).toBe(0)
  expect(evidence.review_high_count).toBe(0)
  expect(evidence.review_severe_count).toBe(0)
})

test("codex review saves durable evidence for current HEAD", async () => {
  await using tmp = await tmpdir({ git: true })
  const state = statePath(tmp.path)
  await fs.mkdir(path.dirname(state), { recursive: true })
  await Bun.write(state, JSON.stringify({ review_glm_state: "done" }))
  const { ctx } = await context(state, tmp.path)

  await createReviewPipeline(ctx).handleCodexDetection(
    { tool: "mcp__codex__codex", args: { prompt: "review the diff" } },
    { output: "Codex review completed. No CRITICAL or HIGH issues were identified." },
  )

  const evidence = await Bun.file(evidencePath(tmp.path)).json()
  expect(evidence.reviewed_head_sha).toBe(await gitOutput(tmp.path, ["rev-parse", "HEAD"]))
  expect(evidence.review_codex_state).toBe("done")
  expect(evidence.review_state).toBe("done")
  expect(evidence.review_agent).toBe("codex:mcp")
  expect(evidence.review_worktree_clean).toBe(true)
})

test("review evidence restores for same HEAD and clean worktree", async () => {
  await using tmp = await tmpdir({ git: true })
  const state = statePath(tmp.path)
  await fs.mkdir(path.dirname(state), { recursive: true })
  await Bun.write(state, JSON.stringify({ review_codex_state: "done" }))
  const { ctx } = await context(state, tmp.path)
  const review = createReviewPipeline(ctx)

  await review.handleExternalReviewDetection(
    { tool: "bash", args: { command: "opencode run /review" } },
    { output: "Review completed. No critical or high issues found.", metadata: { exitCode: 0 } },
  )
  await Bun.write(state, JSON.stringify({}))

  expect(await review.restoreReviewEvidence()).toBe(true)

  const data = await Bun.file(state).json()
  expect(data.review_glm_state).toBe("done")
  expect(data.review_codex_state).toBe("done")
  expect(data.review_state).toBe("done")
  expect(data.review_agent).toBe("opencode:review")
  expect(data.reviewed_head_sha).toBe(await gitOutput(tmp.path, ["rev-parse", "HEAD"]))
  expect(data.edits_since_review).toBe(0)
})

test("review evidence is not restored when HEAD changes", async () => {
  await using tmp = await tmpdir({ git: true })
  const state = statePath(tmp.path)
  await fs.mkdir(path.dirname(state), { recursive: true })
  await Bun.write(state, JSON.stringify({ review_codex_state: "done" }))
  const { ctx, events } = await context(state, tmp.path)
  const review = createReviewPipeline(ctx)

  await review.handleExternalReviewDetection(
    { tool: "bash", args: { command: "opencode run /review" } },
    { output: "Review completed. No critical or high issues found.", metadata: { exitCode: 0 } },
  )
  await Bun.write(path.join(tmp.path, "changed.txt"), "changed")
  await gitOutput(tmp.path, ["add", "changed.txt"])
  await gitOutput(tmp.path, ["commit", "-m", "change head"])
  await Bun.write(state, JSON.stringify({}))

  expect(await review.restoreReviewEvidence()).toBe(false)

  const data = await Bun.file(state).json()
  expect(review.reviewGate(data)).toEqual({
    done: false,
    pending: ["GLM code-reviewer", "Codex review"],
    message: "pending: GLM code-reviewer and Codex review",
  })
  expect(events.some((item) => item.type === "review_evidence.not_restored" && item.reason === "head_mismatch")).toBe(
    true,
  )
})

test("review evidence is not restored for dirty worktree", async () => {
  await using tmp = await tmpdir({ git: true })
  const state = statePath(tmp.path)
  await fs.mkdir(path.dirname(state), { recursive: true })
  await Bun.write(state, JSON.stringify({ review_codex_state: "done" }))
  const { ctx, events } = await context(state, tmp.path)
  const review = createReviewPipeline(ctx)

  await review.handleExternalReviewDetection(
    { tool: "bash", args: { command: "opencode run /review" } },
    { output: "Review completed. No critical or high issues found.", metadata: { exitCode: 0 } },
  )
  await Bun.write(path.join(tmp.path, "dirty.txt"), "dirty")
  await Bun.write(state, JSON.stringify({}))

  expect(await review.restoreReviewEvidence()).toBe(false)

  const data = await Bun.file(state).json()
  expect(review.reviewGate(data)).toEqual({
    done: false,
    pending: ["GLM code-reviewer", "Codex review"],
    message: "pending: GLM code-reviewer and Codex review",
  })
  expect(events.some((item) => item.type === "review_evidence.not_restored" && item.reason === "dirty_worktree")).toBe(
    true,
  )
})

test("external opencode review marks GLM review done", async () => {
  await using tmp = await tmpdir()
  const state = statePath(tmp.path)
  await fs.mkdir(path.dirname(state), { recursive: true })
  await Bun.write(state, JSON.stringify({ review_codex_state: "done" }))
  const { ctx, events } = await context(state)

  await createReviewPipeline(ctx).handleExternalReviewDetection(
    { tool: "bash", args: { command: "opencode run /review" } },
    { output: "Review completed. No critical or high issues found.", metadata: { exitCode: 0 } },
  )

  const data = await Bun.file(state).json()
  expect(data.review_glm_state).toBe("done")
  expect(data.review_state).toBe("done")
  expect(data.review_agent).toBe("opencode:review")
  expect(events.some((item) => item.type === "external_review.completed")).toBe(true)
})

test("review gate blocks when code-reviewer state is missing", async () => {
  await using tmp = await tmpdir()
  const state = statePath(tmp.path)
  await fs.mkdir(path.dirname(state), { recursive: true })
  await Bun.write(state, JSON.stringify({ review_codex_state: "done" }))
  const { ctx } = await context(state)
  const review = createReviewPipeline(ctx)

  expect(review.reviewGate({ review_codex_state: "done" })).toEqual({
    done: false,
    pending: ["GLM code-reviewer"],
    message: "pending: GLM code-reviewer",
  })

  await review.syncReviewState()
  expect((await Bun.file(state).json()).review_state).toBe("")
})

test("checklist blocks stale review state after edits", async () => {
  await using tmp = await tmpdir()
  const state = statePath(tmp.path)
  await fs.mkdir(path.dirname(state), { recursive: true })
  const { ctx } = await context(state)

  expect(
    createReviewPipeline(ctx).checklist({
      tests_executed: true,
      ci_green: true,
      review_glm_state: "done",
      review_codex_state: "done",
      edits_since_review: 1,
    }).blocking,
  ).toContain("review_fresh")
})

test("external claude code-reviewer marks GLM review done", async () => {
  await using tmp = await tmpdir()
  const state = statePath(tmp.path)
  await fs.mkdir(path.dirname(state), { recursive: true })
  await Bun.write(state, JSON.stringify({ review_codex_state: "done" }))
  const { ctx } = await context(state)

  await createReviewPipeline(ctx).handleExternalReviewDetection(
    { tool: "bash", args: { command: "claude --agent code-reviewer review this PR" } },
    { output: "Approve. No CRITICAL or HIGH findings were identified.", metadata: { exitCode: 0 } },
  )

  const data = await Bun.file(state).json()
  expect(data.review_glm_state).toBe("done")
  expect(data.review_agent).toBe("claude:code-reviewer")
})

test("external code-reviewer scripts mark GLM review done", async () => {
  await using tmp = await tmpdir()
  const state = statePath(tmp.path)
  await fs.mkdir(path.dirname(state), { recursive: true })
  await Bun.write(state, JSON.stringify({ review_codex_state: "done" }))
  const { ctx, events } = await context(state)

  await createReviewPipeline(ctx).handleExternalReviewDetection(
    { tool: "bash", args: { command: "python ~/.claude/skills/code-reviewer/scripts/pr_analyzer.py --pr 65" } },
    { output: "Review completed. No CRITICAL or HIGH findings were identified.", metadata: { exitCode: 0 } },
  )

  const data = await Bun.file(state).json()
  expect(data.review_glm_state).toBe("done")
  expect(data.review_state).toBe("done")
  expect(data.review_agent).toBe("code-reviewer:scripts")
  expect(events.some((item) => item.type === "external_review.completed")).toBe(true)
})

test("gstack review log marks matching review gates done", async () => {
  await using tmp = await tmpdir()
  const state = statePath(tmp.path)
  await fs.mkdir(path.dirname(state), { recursive: true })
  await Bun.write(state, JSON.stringify({}))
  const { ctx, events } = await context(state)
  const review = createReviewPipeline(ctx)

  await review.handleExternalReviewDetection(
    {
      tool: "bash",
      args: {
        command:
          '~/.claude/skills/gstack/bin/gstack-review-log \'{"skill":"code-reviewer","timestamp":"2026-04-26T00:00:00Z","status":"pass"}\'',
      },
    },
    { output: "", metadata: { exitCode: 0 } },
  )
  await review.handleExternalReviewDetection(
    {
      tool: "bash",
      args: {
        command:
          '~/.claude/skills/gstack/bin/gstack-review-log \'{"skill":"codex-review","timestamp":"2026-04-26T00:00:00Z","status":"pass"}\'',
      },
    },
    { output: "", metadata: { exitCode: 0 } },
  )

  const data = await Bun.file(state).json()
  expect(data.review_glm_state).toBe("done")
  expect(data.review_codex_state).toBe("done")
  expect(data.review_state).toBe("done")
  expect(events.filter((item) => item.type === "gstack_review.completed")).toHaveLength(2)
})

test("failed gstack review log does not mark review done", async () => {
  await using tmp = await tmpdir()
  const state = statePath(tmp.path)
  await fs.mkdir(path.dirname(state), { recursive: true })
  await Bun.write(state, JSON.stringify({}))
  const { ctx, events } = await context(state)

  await createReviewPipeline(ctx).handleExternalReviewDetection(
    {
      tool: "bash",
      args: {
        command:
          '~/.claude/skills/gstack/bin/gstack-review-log \'{"skill":"code-reviewer","timestamp":"2026-04-26T00:00:00Z","status":"failed"}\'',
      },
    },
    { output: "", metadata: { exitCode: 0 } },
  )

  const data = await Bun.file(state).json()
  expect(data.review_glm_state).toBeUndefined()
  expect(events.some((item) => item.type === "gstack_review.not_passed")).toBe(true)
})

test("external review abort output does not mark review done", async () => {
  await using tmp = await tmpdir()
  const state = statePath(tmp.path)
  await fs.mkdir(path.dirname(state), { recursive: true })
  await Bun.write(state, JSON.stringify({ review_codex_state: "done" }))
  const { ctx, events } = await context(state)

  await createReviewPipeline(ctx).handleExternalReviewDetection(
    { tool: "bash", args: { command: "opencode run /review" } },
    { output: "Tool execution aborted", metadata: { exitCode: 0 } },
  )

  const data = await Bun.file(state).json()
  expect(data.review_glm_state).toBeUndefined()
  expect(events.some((item) => item.type === "external_review.empty_or_aborted")).toBe(true)
})
