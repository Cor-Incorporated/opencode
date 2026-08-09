import { describe, expect, test } from "bun:test"
import { createAccessHandlers } from "../../../../packages/guardrails/profile/plugins/guardrail-access"
import type { GuardrailContext } from "../../../../packages/guardrails/profile/plugins/guardrail-context"

function context(deny?: GuardrailContext["deny"]) {
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
    deny: deny ?? (() => undefined),
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
  test("allows read tool access to team run metadata json", async () => {
    const { ctx, marks } = context((file, kind) => {
      const rel = file.replace("/tmp/project/", "")
      if (kind === "read" && /^\.opencode\/guardrails\/team-runs\/[^/]+\.json$/i.test(rel)) return
      if (rel.startsWith(".opencode/guardrails/")) return "guardrail runtime state is plugin-owned"
    })
    const access = createAccessHandlers(ctx)

    await expect(
      access.toolBeforeAccess(
        { tool: "read", args: { filePath: "/tmp/project/.opencode/guardrails/team-runs/run-1.json" } },
        { args: { filePath: "/tmp/project/.opencode/guardrails/team-runs/run-1.json" } },
      ),
    ).resolves.toBeUndefined()

    expect(marks).toHaveLength(0)
  })

  test("blocks read tool access to other guardrail runtime state", async () => {
    const { ctx, marks } = context((file) => {
      if (file.replace("/tmp/project/", "").startsWith(".opencode/guardrails/")) {
        return "guardrail runtime state is plugin-owned"
      }
    })
    const access = createAccessHandlers(ctx)

    await expect(
      access.toolBeforeAccess(
        { tool: "read", args: { filePath: "/tmp/project/.opencode/guardrails/state.json" } },
        { args: { filePath: "/tmp/project/.opencode/guardrails/state.json" } },
      ),
    ).rejects.toThrow("guardrail runtime state is plugin-owned")

    expect(marks).toHaveLength(1)
    expect(marks[0]?.last_reason).toBe("guardrail runtime state is plugin-owned")
  })

  test("blocks write tool access to review evidence runtime state", async () => {
    const { ctx, marks } = context((file, kind) => {
      const rel = file.replace("/tmp/project/", "")
      if (kind === "edit" && rel.startsWith(".opencode/guardrails/")) {
        return "guardrail runtime state is plugin-owned"
      }
    })
    const access = createAccessHandlers(ctx)

    await expect(
      access.toolBeforeAccess(
        { tool: "write", args: { filePath: "/tmp/project/.opencode/guardrails/review-evidence.json", content: "{}" } },
        { args: { filePath: "/tmp/project/.opencode/guardrails/review-evidence.json", content: "{}" } },
      ),
    ).rejects.toThrow("guardrail runtime state is plugin-owned")

    expect(marks).toHaveLength(1)
    expect(marks[0]).toEqual(
      expect.objectContaining({
        last_block: "write",
        last_file: ".opencode/guardrails/review-evidence.json",
        last_reason: "guardrail runtime state is plugin-owned",
      }),
    )
  })

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

  test("blocks mutating shell access to review evidence runtime state", async () => {
    const { ctx, marks } = context()
    const access = createAccessHandlers(ctx)
    const command = "printf '{}' > .opencode/guardrails/review-evidence.json"

    await expect(
      access.toolBeforeAccess(
        { tool: "bash", args: { command } },
        { args: { command } },
      ),
    ).rejects.toThrow("protected runtime or config mutation")

    expect(marks).toHaveLength(1)
    expect(marks[0]).toEqual(
      expect.objectContaining({
        last_block: "bash",
        last_command: command,
        last_reason: "protected runtime or config mutation",
      }),
    )
  })

  test("blocks interpreter shell writes to review evidence runtime state", async () => {
    const { ctx, marks } = context()
    const access = createAccessHandlers(ctx)
    const command =
      "python -c \"from pathlib import Path; Path('.opencode/guardrails/review-evidence.json').write_text('{}')\""

    await expect(
      access.toolBeforeAccess(
        { tool: "bash", args: { command } },
        { args: { command } },
      ),
    ).rejects.toThrow("protected runtime or config mutation")

    expect(marks).toHaveLength(1)
    expect(marks[0]).toEqual(
      expect.objectContaining({
        last_block: "bash",
        last_command: command,
        last_reason: "protected runtime or config mutation",
      }),
    )
  })

  test("allows inline interpreter shell when guardrail runtime path is assembled dynamically (accepted C15 limitation)", async () => {
    // OC-D1/D2 (PR #298): 検知は `inlineInterpreterShell(cmd) && cmd.includes(".opencode/guardrails")`
    // の条件結合に緩和された。動的組み立てパス（文字列分割）は表面形検知では原理的に閉じない
    // （C15: シェルの表現力 > 検知空間）。根本保証はファイルシステム側（state/events への書込を
    // guardrail.ts の mark/seen 経路に限定する構造）に置く。rollout/opencode.md §3 D2 参照。
    const { ctx, marks } = context()
    const access = createAccessHandlers(ctx)
    const command =
      "python -c \"from pathlib import Path; Path('.open'+'code/guard'+'rails/review-evidence.json').write_text('{}')\""

    await expect(
      access.toolBeforeAccess(
        { tool: "bash", args: { command } },
        { args: { command } },
      ),
    ).resolves.toBeUndefined()

    expect(marks).toHaveLength(0)
  })

  test("clears stale review evidence state after mutating tool edits", async () => {
    const { ctx, marks } = context()
    ctx.hasCodexMcp = true
    const access = createAccessHandlers(ctx)

    await access.toolAfterAccess(
      { tool: "edit", args: { filePath: "/tmp/project/src/policy.ts", oldString: "old", newString: "new" } },
      { title: "Edited", output: "", metadata: {} },
      {
        edited_files: ["src/old.ts"],
        edit_count: 1,
        edit_count_since_check: 2,
        edits_since_review: 0,
        reviewed: true,
        review_at: "2026-07-01T00:00:00.000Z",
        review_agent: "code-reviewer",
        review_glm_state: "done",
        review_codex_state: "done",
        review_state: "done",
        review_glm_at: "2026-07-01T00:00:00.000Z",
        review_codex_at: "2026-07-01T00:00:01.000Z",
        review_checks_at: "2026-07-01T00:00:02.000Z",
        review_pr_number: "42",
      },
    )

    expect(marks.at(-1)).toEqual(
      expect.objectContaining({
        edited_files: ["src/old.ts", "src/policy.ts"],
        edit_count: 2,
        edit_count_since_check: 3,
        edits_since_review: 1,
        last_edit: "src/policy.ts",
        reviewed: false,
        review_at: "",
        review_agent: "",
        review_glm_state: "",
        review_codex_state: "",
        review_state: "",
        review_glm_at: "",
        review_codex_at: "",
        review_checks_at: "",
        review_pr_number: "",
      }),
    )
  })

  test("clears stale review evidence state after shell mutations", async () => {
    const { ctx, marks } = context()
    ctx.hasCodexMcp = true
    const access = createAccessHandlers(ctx)

    await access.toolAfterAccess(
      { tool: "bash", args: { command: "printf 'new' > src/policy.ts" } },
      { title: "bash", output: "", metadata: { exitCode: 0 } },
      {
        edits_since_review: 2,
        reviewed: true,
        review_at: "2026-07-01T00:00:00.000Z",
        review_agent: "code-reviewer",
        review_glm_state: "done",
        review_codex_state: "done",
        review_state: "done",
        review_glm_at: "2026-07-01T00:00:00.000Z",
        review_codex_at: "2026-07-01T00:00:01.000Z",
        review_checks_at: "2026-07-01T00:00:02.000Z",
        review_pr_number: "42",
      },
    )

    expect(marks.at(-1)).toEqual(
      expect.objectContaining({
        edits_since_review: 3,
        reviewed: false,
        review_at: "",
        review_agent: "",
        review_glm_state: "",
        review_codex_state: "",
        review_state: "",
        review_glm_at: "",
        review_codex_at: "",
        review_checks_at: "",
        review_pr_number: "",
      }),
    )
  })
})
