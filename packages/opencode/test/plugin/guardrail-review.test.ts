import { expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { createReviewPipeline } from "../../../../packages/guardrails/profile/plugins/guardrail-review"
import type { GuardrailContext } from "../../../../packages/guardrails/profile/plugins/guardrail-context"
import { tmpdir } from "../fixture/fixture"

async function context(state: string) {
  const events: Record<string, unknown>[] = []
  const ctx: GuardrailContext = {
    input: {
      client: {} as GuardrailContext["input"]["client"],
      directory: path.dirname(path.dirname(path.dirname(state))),
      worktree: path.dirname(path.dirname(path.dirname(state))),
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

test("external opencode review marks GLM review done", async () => {
  await using tmp = await tmpdir()
  const state = path.join(tmp.path, ".opencode", "guardrails", "state.json")
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

test("external claude code-reviewer marks GLM review done", async () => {
  await using tmp = await tmpdir()
  const state = path.join(tmp.path, ".opencode", "guardrails", "state.json")
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
  const state = path.join(tmp.path, ".opencode", "guardrails", "state.json")
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
  const state = path.join(tmp.path, ".opencode", "guardrails", "state.json")
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

test("syncs verified Claude hook lock into OpenCode GLM review state", async () => {
  await using tmp = await tmpdir()
  const state = path.join(tmp.path, ".opencode", "guardrails", "state.json")
  await fs.mkdir(path.dirname(state), { recursive: true })
  await fs.mkdir(path.join(tmp.path, ".claude", "state"), { recursive: true })
  await Bun.write(state, JSON.stringify({ review_codex_state: "done" }))
  await Bun.write(
    path.join(tmp.path, ".claude", "state", "pr-review-lock.json"),
    JSON.stringify({ "76": { verified: true, review_lgtm: true } }),
  )
  const { ctx, events } = await context(state)

  await createReviewPipeline(ctx).syncExternalReviewState(await Bun.file(state).json(), {
    branch: "develop",
    pr: "76",
  })

  const data = await Bun.file(state).json()
  expect(data.review_glm_state).toBe("done")
  expect(data.review_codex_state).toBe("done")
  expect(data.review_state).toBe("done")
  expect(data.review_agent).toBe("claude-hooks")
  expect(events.some((item) => item.type === "claude_review_state.synced")).toBe(true)
})

test("syncs Claude review-status branch records into both review gates", async () => {
  await using tmp = await tmpdir()
  const state = path.join(tmp.path, ".opencode", "guardrails", "state.json")
  await fs.mkdir(path.dirname(state), { recursive: true })
  await fs.mkdir(path.join(tmp.path, ".claude", "state"), { recursive: true })
  await Bun.write(state, JSON.stringify({}))
  await Bun.write(
    path.join(tmp.path, ".claude", "state", "review-status.json"),
    JSON.stringify({ "feature/sync": { code_review: true, codex_review: true } }),
  )
  const { ctx } = await context(state)

  await createReviewPipeline(ctx).syncExternalReviewState(await Bun.file(state).json(), {
    branch: "feature/sync",
  })

  const data = await Bun.file(state).json()
  expect(data.review_glm_state).toBe("done")
  expect(data.review_codex_state).toBe("done")
  expect(data.review_state).toBe("done")
})

test("failed gstack review log does not mark review done", async () => {
  await using tmp = await tmpdir()
  const state = path.join(tmp.path, ".opencode", "guardrails", "state.json")
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
  const state = path.join(tmp.path, ".opencode", "guardrails", "state.json")
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
