import { describe, expect, test } from "bun:test"
import { createAccessHandlers } from "../../../../packages/guardrails/profile/plugins/guardrail-access"
import type { GuardrailContext } from "../../../../packages/guardrails/profile/plugins/guardrail-context"

function context() {
  const marks: Record<string, unknown>[] = []
  const ctx: GuardrailContext = {
    input: {
      client: {} as GuardrailContext["input"]["client"],
      directory: "/tmp/project",
      worktree: "/tmp/project",
    },
    mode: "enforced",
    root: "/tmp/project/.opencode/guardrails",
    log: "/tmp/project/.opencode/guardrails/events.jsonl",
    state: "/tmp/project/.opencode/guardrails/state.json",
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
  return { ctx, marks }
}

describe("guardrail-access", () => {
  test("allows read-only shell access to .opencode/guardrails", async () => {
    const { ctx, marks } = context()
    const access = createAccessHandlers(ctx)

    await expect(
      access.toolBeforeAccess(
        { tool: "bash", args: { command: "ls -la .opencode/guardrails/" } },
        { args: { command: "ls -la .opencode/guardrails/" } },
      ),
    ).resolves.toBeUndefined()

    expect(marks).toHaveLength(0)
  })

  test("blocks mutating shell access to .opencode/guardrails", async () => {
    const { ctx, marks } = context()
    const access = createAccessHandlers(ctx)

    await expect(
      access.toolBeforeAccess(
        { tool: "bash", args: { command: "rm -rf .opencode/guardrails/" } },
        { args: { command: "rm -rf .opencode/guardrails/" } },
      ),
    ).rejects.toThrow("protected runtime or config mutation")

    expect(marks).toHaveLength(1)
    expect(marks[0]?.last_reason).toBe("protected runtime or config mutation")
  })
})
