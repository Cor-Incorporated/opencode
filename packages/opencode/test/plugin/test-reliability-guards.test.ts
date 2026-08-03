import { afterEach, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { tmpdir } from "../fixture/fixture"
import type { GuardrailContext } from "../../../../packages/guardrails/profile/plugins/guardrail-context"
import {
  isTestCommand,
  missingCiDbEnv,
  parseSkipSummary,
  testHonestyAdvisory,
  testHonestyGuardDisabled,
  createTestHonestyHandlers,
} from "../../../../packages/guardrails/profile/plugins/test-honesty"
import {
  isWorktreeAddCommand,
  needsNodeModulesProvision,
  parseWorktreeAddPath,
  worktreeBootstrapAdvisory,
  worktreeBootstrapGuardDisabled,
  createWorktreeBootstrapHandlers,
} from "../../../../packages/guardrails/profile/plugins/worktree-bootstrap"
import {
  hasHermeticMock,
  needsEnvHermeticMock,
  scanEnvHermeticViolations,
  usesEnvGatedPath,
} from "../../../../packages/guardrails/profile/plugins/env-hermetic"

const profileRoot = path.resolve(import.meta.dir, "../../../../packages/guardrails/profile")

const prevHonesty = process.env.OPENCODE_TEST_HONESTY_GUARD
const prevBootstrap = process.env.OPENCODE_WORKTREE_BOOTSTRAP_GUARD

afterEach(() => {
  if (prevHonesty === undefined) delete process.env.OPENCODE_TEST_HONESTY_GUARD
  else process.env.OPENCODE_TEST_HONESTY_GUARD = prevHonesty
  if (prevBootstrap === undefined) delete process.env.OPENCODE_WORKTREE_BOOTSTRAP_GUARD
  else process.env.OPENCODE_WORKTREE_BOOTSTRAP_GUARD = prevBootstrap
})

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
    path: tmp.path,
    [Symbol.asyncDispose]: async () => {
      await tmp[Symbol.asyncDispose]()
    },
  }
}

describe("anti-pattern L — test honesty / silent skips", () => {
  test("detects structural test commands, not unrelated high words", () => {
    expect(isTestCommand("go test ./...")).toBe(true)
    expect(isTestCommand("mise run test")).toBe(true)
    expect(isTestCommand("bun test packages/foo")).toBe(true)
    expect(isTestCommand("echo high priority review")).toBe(false)
    expect(isTestCommand("git status")).toBe(false)
  })

  test("positive: skip summary with DB critical skips advises incomplete verification", () => {
    const output = `
--- SKIP: TestConversationTurnSeq (0.00s)
    store_test.go:12: TEST_DATABASE_URL not set
ok  	github.com/org/repo/store	0.012s
7 passed, 0 failed, 7 skipped
`
    const summary = parseSkipSummary(output)
    expect(summary.skipped).toBeGreaterThan(0)
    expect(summary.criticalSkips.length).toBeGreaterThan(0)
    expect(testHonestyAdvisory(summary)).toContain("TEST HONESTY")
  })

  test("negative: clean run with zero skips produces no advisory", () => {
    const summary = parseSkipSummary("18 pass\n0 fail\n0 skipped\n")
    expect(summary.skipped).toBe(0)
    expect(testHonestyAdvisory(summary)).toBeUndefined()
  })

  test("falsify: disabling the guard suppresses advisory after bash test", async () => {
    await using fixture = await context()
    process.env.OPENCODE_TEST_HONESTY_GUARD = "off"
    expect(testHonestyGuardDisabled()).toBe(true)
    const handlers = createTestHonestyHandlers(fixture.ctx)
    const out = {
      output: "--- SKIP: TestX\nTEST_DATABASE_URL not set\n7 passed, 7 skipped\n",
    }
    await handlers.afterBash({ tool: "bash", args: { command: "go test ./..." } }, out)
    expect(out.output.includes("TEST HONESTY")).toBe(false)
  })

  test("plugin appends advisory and never throws", async () => {
    await using fixture = await context()
    delete process.env.OPENCODE_TEST_HONESTY_GUARD
    const handlers = createTestHonestyHandlers(fixture.ctx)
    const out = { output: "ok\n--- SKIP: TestDB (postgres unavailable)\n5 passed, 2 skipped\n" }
    await expect(handlers.afterBash({ tool: "bash", args: { command: "mise run test" } }, out)).resolves.toBeUndefined()
    expect(out.output).toContain("TEST HONESTY")
  })

  test("CI wiring helper: missing DB env keys are reported", () => {
    expect(missingCiDbEnv({ TEST_DATABASE_URL: "postgres://x" }, ["TEST_DATABASE_URL", "DATABASE_URL"])).toEqual([
      "DATABASE_URL",
    ])
    expect(missingCiDbEnv({ TEST_DATABASE_URL: "postgres://x", DATABASE_URL: "postgres://y" })).toEqual([])
  })
})

describe("anti-pattern M — worktree bootstrap", () => {
  test("detects worktree add structurally", () => {
    expect(isWorktreeAddCommand("git worktree add ../wt feature")).toBe(true)
    expect(isWorktreeAddCommand("git -C repo worktree add -b feat ../wt")).toBe(true)
    expect(isWorktreeAddCommand("git worktree list")).toBe(false)
    expect(parseWorktreeAddPath("git worktree add ../.worktrees/foo")).toBe("../.worktrees/foo")
  })

  test("positive: package.json without node_modules needs provision", async () => {
    await using tmp = await tmpdir()
    await Bun.write(path.join(tmp.path, "package.json"), '{"name":"x"}\n')
    expect(needsNodeModulesProvision(tmp.path)).toBe(true)
    expect(worktreeBootstrapAdvisory(tmp.path, "/repo")).toContain("WORKTREE BOOTSTRAP")
    expect(worktreeBootstrapAdvisory(tmp.path, "/repo")).toContain("ln -s")
  })

  test("negative: node_modules present needs no provision", async () => {
    await using tmp = await tmpdir()
    await Bun.write(path.join(tmp.path, "package.json"), '{"name":"x"}\n')
    await fs.mkdir(path.join(tmp.path, "node_modules"))
    expect(needsNodeModulesProvision(tmp.path)).toBe(false)
  })

  test("falsify: guard off skips afterBash advisory", async () => {
    await using fixture = await context()
    process.env.OPENCODE_WORKTREE_BOOTSTRAP_GUARD = "off"
    expect(worktreeBootstrapGuardDisabled()).toBe(true)
    await Bun.write(path.join(fixture.path, "package.json"), '{"name":"x"}\n')
    const wt = path.join(fixture.path, "wt")
    await fs.mkdir(wt)
    await Bun.write(path.join(wt, "package.json"), '{"name":"x"}\n')
    const handlers = createWorktreeBootstrapHandlers(fixture.ctx)
    const out = { output: "Preparing worktree" }
    await handlers.afterBash({ tool: "bash", args: { command: `git worktree add ${wt}` } }, out)
    expect(out.output.includes("WORKTREE BOOTSTRAP")).toBe(false)
  })
})

describe("anti-pattern N — harness API gotcha skill", () => {
  test("skill documents fireEvent isComposing limitation and falsify checklist", async () => {
    const skill = await Bun.file(path.join(profileRoot, "skills", "harness-api-gotcha", "SKILL.md")).text()
    expect(skill).toContain("name: harness-api-gotcha")
    expect(skill).toContain("isComposing")
    expect(skill).toContain("KeyboardEvent")
    expect(skill.toLowerCase()).toContain("falsify")
    const falsifiable = await Bun.file(path.join(profileRoot, "skills", "falsifiable-change", "SKILL.md")).text()
    expect(falsifiable).toContain("harness-api-gotcha")
  })
})

describe("anti-pattern O — env-hermetic tests", () => {
  test("positive: gate without mock is a violation", () => {
    const source = `
import { render } from "@testing-library/react"
import { stream } from "./client"
test("stream", async () => {
  if (isClerkConfigured()) await stream()
})
`
    expect(usesEnvGatedPath(source)).toBe(true)
    expect(hasHermeticMock(source)).toBe(false)
    expect(needsEnvHermeticMock(source)).toBe(true)
  })

  test("negative: gate with vi.mock is hermetic", () => {
    const source = `
vi.mock("./runtime-config", () => ({ isClerkConfigured: () => false }))
test("stream", async () => {
  expect(isClerkConfigured()).toBe(false)
})
`
    expect(needsEnvHermeticMock(source)).toBe(false)
  })

  test("negative: unrelated tests are not flagged", () => {
    expect(needsEnvHermeticMock("test('adds', () => expect(1+1).toBe(2))")).toBe(false)
  })

  test("scan helper lists only violating files (CI wiring shape)", () => {
    const files = scanEnvHermeticViolations([
      { file: "bad.test.ts", text: "isClerkConfigured(); expect(true).toBe(true)" },
      { file: "good.test.ts", text: "vi.mock('x'); isClerkConfigured()" },
      { file: "plain.test.ts", text: "expect(1).toBe(1)" },
    ])
    expect(files).toEqual(["bad.test.ts"])
  })

  test("skill exists", async () => {
    const skill = await Bun.file(path.join(profileRoot, "skills", "env-hermetic-tests", "SKILL.md")).text()
    expect(skill).toContain("name: env-hermetic-tests")
    expect(skill).toContain("vi.mock")
  })
})

describe("commands / plan-light wiring", () => {
  test("test-honesty command and plan-light mention L-O", async () => {
    const command = await Bun.file(path.join(profileRoot, "commands", "test-honesty.md")).text()
    expect(command).toContain("skipped")
    const plan = await Bun.file(path.join(profileRoot, "commands", "plan-light.md")).text()
    expect(plan).toContain("patterns L–O")
  })
})
