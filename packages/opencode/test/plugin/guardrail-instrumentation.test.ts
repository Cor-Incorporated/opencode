import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { createInstrumentationHandlers } from "../../../../packages/guardrails/profile/plugins/guardrail-instrumentation"
import type { GuardrailContext } from "../../../../packages/guardrails/profile/plugins/guardrail-context"
import { tmpdir } from "../fixture/fixture"

async function context() {
  const tmp = await tmpdir()
  const marks: Record<string, unknown>[] = []
  const events: Record<string, unknown>[] = []
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
  return {
    ctx,
    events,
    marks,
    [Symbol.asyncDispose]: async () => {
      await tmp[Symbol.asyncDispose]()
    },
  }
}

async function gitFixture() {
  const fixture = await context()
  await Bun.$`git init`.cwd(fixture.ctx.input.worktree).quiet()
  await Bun.$`git config core.fsmonitor false`.cwd(fixture.ctx.input.worktree).quiet()
  await Bun.$`git config commit.gpgsign false`.cwd(fixture.ctx.input.worktree).quiet()
  await Bun.$`git config user.email "test@opencode.test"`.cwd(fixture.ctx.input.worktree).quiet()
  await Bun.$`git config user.name "Test"`.cwd(fixture.ctx.input.worktree).quiet()
  await Bun.$`git commit --allow-empty -m root`.cwd(fixture.ctx.input.worktree).quiet()
  await Bun.$`git branch -M dev`.cwd(fixture.ctx.input.worktree).quiet()
  await Bun.$`git update-ref refs/remotes/origin/dev HEAD`.cwd(fixture.ctx.input.worktree).quiet()
  await Bun.$`git checkout -b feat/instrumentation-gate`.cwd(fixture.ctx.input.worktree).quiet()
  return fixture
}

async function commitFile(dir: string, file: string, content: string) {
  await fs.mkdir(path.dirname(path.join(dir, file)), { recursive: true })
  await Bun.write(path.join(dir, file), content)
  await Bun.$`git add ${file}`.cwd(dir).quiet()
}

describe("guardrail instrumentation gate", () => {
  test("blocks global monkey patches in instrumentation edits", async () => {
    await using fixture = await context()
    const instrumentation = createInstrumentationHandlers(fixture.ctx)

    await expect(
      instrumentation.toolBeforeInstrumentation(
        {
          tool: "edit",
          args: {
            filePath: path.join(fixture.ctx.input.worktree, "src", "instrumentation.ts"),
            newString: "globalThis.fetch = wrapFetch\nexport const metrics = []\n",
          },
        },
        {
          args: {
            filePath: path.join(fixture.ctx.input.worktree, "src", "instrumentation.ts"),
            newString: "globalThis.fetch = wrapFetch\nexport const metrics = []\n",
          },
        },
      ),
    ).rejects.toThrow("global monkey patching is prohibited")

    expect(fixture.marks.at(-1)?.instrumentation_policy).toBe("source_hooks_required")
  })

  test("does not treat JSX spans or process equality as instrumentation patches", async () => {
    await using fixture = await context()
    const instrumentation = createInstrumentationHandlers(fixture.ctx)

    await instrumentation.toolAfterInstrumentation(
      {
        tool: "edit",
        args: {
          filePath: path.join(fixture.ctx.input.worktree, "src", "ui", "Widget.tsx"),
          newString: "export function Widget() { return <span>Ready</span> }\n",
        },
      },
      { output: "", metadata: {} },
      {},
    )

    await expect(
      instrumentation.toolBeforeInstrumentation(
        {
          tool: "edit",
          args: {
            filePath: path.join(fixture.ctx.input.worktree, "src", "instrumentation", "platform.ts"),
            newString:
              "export const platformMetric = process.platform === 'darwin' ? { metric: 'agent.platform' } : { metric: 'agent.platform' }\n",
          },
        },
        {
          args: {
            filePath: path.join(fixture.ctx.input.worktree, "src", "instrumentation", "platform.ts"),
            newString:
              "export const platformMetric = process.platform === 'darwin' ? { metric: 'agent.platform' } : { metric: 'agent.platform' }\n",
          },
        },
      ),
    ).resolves.toBeUndefined()

    expect(fixture.marks).toHaveLength(0)
  })

  test("blocks bash mutations that add instrumentation monkey patches", async () => {
    await using fixture = await context()
    const instrumentation = createInstrumentationHandlers(fixture.ctx)

    await expect(
      instrumentation.bashBeforeInstrumentation(
        "cat > src/instrumentation.ts <<'EOF'\nglobalThis.fetch = wrapFetch\nexport const metrics = []\nEOF",
        {},
      ),
    ).rejects.toThrow("global monkey patching is prohibited")

    expect(fixture.marks.at(-1)?.last_block).toBe("bash")
  })

  test("blocks null unavailable reasons and unmeasurable metric claims", async () => {
    await using fixture = await context()
    const instrumentation = createInstrumentationHandlers(fixture.ctx)

    await expect(
      instrumentation.toolBeforeInstrumentation(
        {
          tool: "edit",
          args: {
            filePath: path.join(fixture.ctx.input.worktree, "src", "instrumentation", "metrics.ts"),
            newString: "export const metrics = { unavailable_reason: null }\n",
          },
        },
        {
          args: {
            filePath: path.join(fixture.ctx.input.worktree, "src", "instrumentation", "metrics.ts"),
            newString: "export const metrics = { unavailable_reason: null }\n",
          },
        },
      ),
    ).rejects.toThrow("explicit reason")

    await expect(
      instrumentation.toolBeforeInstrumentation(
        {
          tool: "edit",
          args: {
            filePath: path.join(fixture.ctx.input.worktree, "src", "instrumentation", "metrics.ts"),
            newString: "export const metrics = estimateAgentCost()\n",
          },
        },
        {
          args: {
            filePath: path.join(fixture.ctx.input.worktree, "src", "instrumentation", "metrics.ts"),
            newString: "export const metrics = estimateAgentCost()\n",
          },
        },
      ),
    ).rejects.toThrow("not directly measurable")
  })

  test("blocks instrumentation PR creation without quality-gate evidence", async () => {
    await using fixture = await gitFixture()
    await commitFile(
      fixture.ctx.input.worktree,
      "src/instrumentation/agent-metrics.ts",
      "export function collectAgentMetrics() { return { metric: 'agent.latency' } }\n",
    )
    await Bun.$`git commit -m instrumentation`.cwd(fixture.ctx.input.worktree).quiet()
    const instrumentation = createInstrumentationHandlers(fixture.ctx)

    await expect(instrumentation.bashBeforeInstrumentation("gh pr create --title 'feat: metrics'", {})).rejects.toThrow(
      "AI agent instrumentation quality gate failed",
    )

    expect(String(fixture.marks.at(-1)?.last_reason)).toContain("instrumentation quality gate")
    expect(fixture.marks.at(-1)?.instrumentation_quality_state).toBe("blocked")
  })

  test("blocks instrumentation resources without cleanup in the source file", async () => {
    await using fixture = await gitFixture()
    await commitFile(
      fixture.ctx.input.worktree,
      "src/instrumentation/agent-metrics.ts",
      [
        "export async function collectAgentMetrics(dependency: { requestCount?: () => number } | undefined) {",
        '  const unavailable_reason = "agent metrics dependency missing"',
        "  const dependencyAvailabilityProbe = dependency !== undefined",
        "  const controller = new AbortController()",
        "  if (!dependencyAvailabilityProbe) return { unavailable: true, unavailable_reason }",
        "  return { metric: 'agent.request.count', semantics: 'completed AI agent requests', codePath: 'src/instrumentation/agent-metrics.ts#collectAgentMetrics', signal: controller.signal }",
        "}",
        "",
      ].join("\n"),
    )
    await commitFile(
      fixture.ctx.input.worktree,
      "docs/agent-instrumentation.md",
      [
        "# Agent Instrumentation",
        "",
        "## Traceability Matrix",
        "",
        "| Acceptance Criteria | Implementation code path |",
        "| --- | --- |",
        "| source-level hooks only | src/instrumentation/agent-metrics.ts#collectAgentMetrics |",
        "",
        "Metric semantics: agent.request.count means completed AI agent requests.",
        "Metric code path: src/instrumentation/agent-metrics.ts#collectAgentMetrics.",
        "Dependency availability probe: the dependency is checked before use and unavailable_reason explains missing data.",
        "",
      ].join("\n"),
    )
    await commitFile(
      fixture.ctx.input.worktree,
      "test/agent-instrumentation.integration.test.ts",
      [
        "import { expect, test } from 'bun:test'",
        "import { collectAgentMetrics } from '../src/instrumentation/agent-metrics'",
        "",
        "test('agent instrumentation unavailable reason', async () => {",
        "  await expect(collectAgentMetrics(undefined)).resolves.toMatchObject({ unavailable_reason: 'agent metrics dependency missing' })",
        "})",
        "",
      ].join("\n"),
    )
    await Bun.$`git commit -m instrumentation-gates`.cwd(fixture.ctx.input.worktree).quiet()
    const instrumentation = createInstrumentationHandlers(fixture.ctx)

    await expect(instrumentation.bashBeforeInstrumentation("gh pr create --title 'feat: metrics'", {})).rejects.toThrow(
      "resource lifecycle needs cleanup/finally evidence",
    )
  })

  test("passes instrumentation PR creation with traceability, tests, probes, semantics, and cleanup", async () => {
    await using fixture = await gitFixture()
    await commitFile(
      fixture.ctx.input.worktree,
      "src/instrumentation/agent-metrics.ts",
      [
        "export async function collectAgentMetrics(dependency: { requestCount?: () => number } | undefined) {",
        '  const unavailable_reason = "agent metrics dependency missing"',
        "  const dependencyAvailabilityProbe = dependency !== undefined",
        "  const controller = new AbortController()",
        "  try {",
        "    if (!dependencyAvailabilityProbe) return { unavailable: true, unavailable_reason }",
        "    return { metric: 'agent.request.count', semantics: 'completed AI agent requests', codePath: 'src/instrumentation/agent-metrics.ts#collectAgentMetrics' }",
        "  } finally {",
        "    controller.abort()",
        "  }",
        "}",
        "",
      ].join("\n"),
    )
    await commitFile(
      fixture.ctx.input.worktree,
      "docs/agent-instrumentation.md",
      [
        "# Agent Instrumentation",
        "",
        "## Traceability Matrix",
        "",
        "| Acceptance Criteria | Implementation code path |",
        "| --- | --- |",
        "| source-level hooks only | src/instrumentation/agent-metrics.ts#collectAgentMetrics |",
        "",
        "Metric semantics: agent.request.count means completed AI agent requests.",
        "Metric code path: src/instrumentation/agent-metrics.ts#collectAgentMetrics.",
        "Dependency availability probe: the dependency is checked before use and unavailable_reason explains missing data.",
        "",
      ].join("\n"),
    )
    await commitFile(
      fixture.ctx.input.worktree,
      "test/agent-instrumentation.integration.test.ts",
      [
        "import { expect, test } from 'bun:test'",
        "import { collectAgentMetrics } from '../src/instrumentation/agent-metrics'",
        "",
        "test('agent instrumentation unavailable reason', async () => {",
        "  await expect(collectAgentMetrics(undefined)).resolves.toMatchObject({ unavailable_reason: 'agent metrics dependency missing' })",
        "})",
        "",
      ].join("\n"),
    )
    await Bun.$`git commit -m instrumentation-gates`.cwd(fixture.ctx.input.worktree).quiet()
    const instrumentation = createInstrumentationHandlers(fixture.ctx)

    await expect(
      instrumentation.bashBeforeInstrumentation("gh pr create --title 'feat: metrics'", {}),
    ).resolves.toBeUndefined()

    expect(fixture.marks.at(-1)?.instrumentation_quality_state).toBe("done")
    expect(fixture.events.at(-1)?.type).toBe("instrumentation.quality_gate_passed")
  })

  test("passes instrumentation PR creation with Python integration test evidence", async () => {
    await using fixture = await gitFixture()
    await commitFile(
      fixture.ctx.input.worktree,
      "src/instrumentation/agent_metrics.py",
      [
        "def collect_agent_metrics(dependency=None):",
        '    unavailable_reason = "agent metrics dependency missing"',
        "    dependency_availability_probe = dependency is not None",
        "    try:",
        "        if not dependency_availability_probe:",
        '            return {"unavailable": True, "unavailable_reason": unavailable_reason}',
        '        return {"metric": "agent.request.count", "semantics": "completed AI agent requests", "codePath": "src/instrumentation/agent_metrics.py#collect_agent_metrics"}',
        "    finally:",
        "        pass",
        "",
      ].join("\n"),
    )
    await commitFile(
      fixture.ctx.input.worktree,
      "docs/agent-instrumentation.md",
      [
        "# Agent Instrumentation",
        "",
        "## Traceability Matrix",
        "",
        "| Acceptance Criteria | Implementation code path |",
        "| --- | --- |",
        "| source-level hooks only | src/instrumentation/agent_metrics.py#collect_agent_metrics |",
        "",
        "Metric semantics: agent.request.count means completed AI agent requests.",
        "Metric code path: src/instrumentation/agent_metrics.py#collect_agent_metrics.",
        "Dependency availability probe: the dependency is checked before use and unavailable_reason explains missing data.",
        "",
      ].join("\n"),
    )
    await commitFile(
      fixture.ctx.input.worktree,
      "tests/test_agent_instrumentation.py",
      [
        "from src.instrumentation.agent_metrics import collect_agent_metrics",
        "",
        "def test_agent_instrumentation_unavailable_reason():",
        '    assert collect_agent_metrics(None)["unavailable_reason"] == "agent metrics dependency missing"',
        "",
      ].join("\n"),
    )
    await Bun.$`git commit -m instrumentation-gates`.cwd(fixture.ctx.input.worktree).quiet()
    const instrumentation = createInstrumentationHandlers(fixture.ctx)

    await expect(
      instrumentation.bashBeforeInstrumentation("gh pr create --title 'feat: metrics'", {}),
    ).resolves.toBeUndefined()

    expect(fixture.marks.at(-1)?.instrumentation_quality_state).toBe("done")
    expect(fixture.events.at(-1)?.type).toBe("instrumentation.quality_gate_passed")
  })
})
