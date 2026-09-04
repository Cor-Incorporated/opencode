import { afterEach, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { tmpdir } from "../fixture/fixture"
import type { GuardrailContext } from "../../../../packages/guardrails/profile/plugins/guardrail-context"
import { guardrail } from "../../../../packages/guardrails/profile/plugins/guardrail"
import {
  assertVersionPinsEqual,
  collectTouchedPaths,
  createSsotHandlers,
  evaluateSsotDrift,
  extractVersionPins,
  formatSsotAdvisory,
  matchGlob,
  ssotGuardDisabled,
} from "../../../../packages/guardrails/profile/plugins/ssot-guard"

const profileRoot = path.resolve(import.meta.dir, "../../../../packages/guardrails/profile")
const previous = process.env.OPENCODE_SSOT_GUARD

afterEach(() => {
  if (previous === undefined) delete process.env.OPENCODE_SSOT_GUARD
  else process.env.OPENCODE_SSOT_GUARD = previous
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

describe("anti-pattern K — SSOT drift detection", () => {
  test("glob matching is path/structure based", () => {
    expect(matchGlob("services/api/migrations/000060_drop.up.sql", "**/migrations/**")).toBe(true)
    expect(matchGlob("packages/contracts/initial-schema.sql", "**/initial-schema.sql")).toBe(true)
    expect(matchGlob("README.md", "**/migrations/**")).toBe(false)
    expect(matchGlob("note-with-high-severity.md", "**/migrations/**")).toBe(false)
  })

  test("positive: migration-only change drifts against SSOT side", () => {
    const advisories = evaluateSsotDrift(["services/api/migrations/000060_drop.up.sql"])
    expect(advisories.some((item) => item.set.id === "db-schema")).toBe(true)
    const db = advisories.find((item) => item.set.id === "db-schema")
    expect(db?.touched).toContain("migrations")
    expect(db?.missing).toContain("ssot")
    expect(formatSsotAdvisory(advisories)).toContain("SSOT SYNC ADVISORY")
  })

  test("negative: migration + SSOT together produces no db-schema advisory", () => {
    const advisories = evaluateSsotDrift([
      "services/api/migrations/000060_drop.up.sql",
      "packages/contracts/initial-schema.sql",
    ])
    expect(advisories.some((item) => item.set.id === "db-schema")).toBe(false)
  })

  test("positive: single version-pin file drifts; all four sides synced does not", () => {
    const half = evaluateSsotDrift(["deploy/grift-deployment-policies.json"])
    expect(half.some((item) => item.set.id === "version-pins")).toBe(true)

    const full = evaluateSsotDrift([
      "deploy/grift-deployment-policies.json",
      "internal/alpha_migration_preflight.go",
      "scripts/check-v2-alpha-deployment-contract.mjs",
      ".github/workflows/v2-alpha-cd.yml",
    ])
    expect(full.some((item) => item.set.id === "version-pins")).toBe(false)
  })

  test("unrelated edits and high-word paths do not advise", () => {
    expect(evaluateSsotDrift(["src/app.ts", "docs/high-priority.md"])).toEqual([])
  })
})

describe("version-pin wiring (pattern K / F-style)", () => {
  test("equal pins pass; drifted pins fail", () => {
    const equal = extractVersionPins([
      { file: "policy.json", text: '{"expected_version": 60}' },
      { file: "preflight.go", text: "const expectedVersion = 60" },
      { file: "contract.mjs", text: "expected_version: 60," },
      { file: "cd.yml", text: "EXPECTED_VERSION: 60" },
    ])
    // cd.yml may not match default patterns — assert on the ones extracted
    const ok = assertVersionPinsEqual(equal.filter((pin) => ["policy.json", "preflight.go", "contract.mjs"].includes(pin.file)))
    expect(ok.ok).toBe(true)

    const drifted = assertVersionPinsEqual([
      { file: "policy.json", value: "60" },
      { file: "preflight.go", value: "59" },
      { file: "contract.mjs", value: "59" },
      { file: "cd.yml", value: "59" },
    ])
    expect(drifted.ok).toBe(false)
    expect(drifted.detail).toContain("version pin drift")
  })

  test("falsify: ignoring pin equality would hide the #1761 half-bump", () => {
    const pins = [
      { file: "policy.json", value: "59" },
      { file: "preflight.go", value: "59" },
      { file: "contract.mjs", value: "59" },
      { file: "cd.yml", value: "60" },
    ]
    expect(assertVersionPinsEqual(pins).ok).toBe(false)
  })
})

describe("ssot plugin behavior (advise, do not block)", () => {
  test("advisory is appended and never throws", async () => {
    await using fixture = await context()
    delete process.env.OPENCODE_SSOT_GUARD
    const ssot = createSsotHandlers(fixture.ctx)
    const out = { args: { filePath: "services/api/migrations/000060.up.sql" }, output: "wrote file" }
    await expect(ssot.afterMutatingTool({ tool: "write", args: out.args }, out)).resolves.toBeUndefined()
    expect(out.output).toContain("SSOT SYNC ADVISORY")
    expect(fixture.marks.some((mark) => typeof mark.ssot_advisory === "string" && String(mark.ssot_advisory).includes("SSOT"))).toBe(
      true,
    )
  })

  test("falsify: OPENCODE_SSOT_GUARD=off suppresses advisory", async () => {
    await using fixture = await context()
    process.env.OPENCODE_SSOT_GUARD = "off"
    expect(ssotGuardDisabled()).toBe(true)
    const ssot = createSsotHandlers(fixture.ctx)
    const out = { args: { filePath: "services/api/migrations/000060.up.sql" }, output: "wrote file" }
    await ssot.afterMutatingTool({ tool: "write", args: out.args }, out)
    expect(out.output).toBe("wrote file")
  })

  test("negative: synced migration+SSOT clears advisory message", async () => {
    await using fixture = await context()
    delete process.env.OPENCODE_SSOT_GUARD
    const ssot = createSsotHandlers(fixture.ctx)
    await ssot.afterMutatingTool(
      { tool: "write", args: { filePath: "services/api/migrations/000060.up.sql" } },
      { args: { filePath: "services/api/migrations/000060.up.sql" }, output: "a" },
    )
    const out = { args: { filePath: "packages/contracts/initial-schema.sql" }, output: "b" }
    await ssot.afterMutatingTool({ tool: "write", args: out.args }, out)
    expect(out.output.includes("SSOT SYNC ADVISORY")).toBe(false)
  })

  test("collectTouchedPaths only considers mutating tools", () => {
    expect(collectTouchedPaths({ tool: "read", args: { filePath: "x.sql" } })).toEqual([])
    expect(collectTouchedPaths({ tool: "write", args: { path: "a.sql" } })).toEqual(["a.sql"])
  })

  test("aggregate guardrail wires advisory through tool.execute.after", async () => {
    await using tmp = await tmpdir({ git: true })
    delete process.env.OPENCODE_SSOT_GUARD
    const plugin = await guardrail(
      {
        client: {
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
        },
        directory: tmp.path,
        worktree: tmp.path,
      },
      {},
    )
    await plugin.event({ event: { type: "session.created", properties: { sessionID: "ses_ssot" } } })
    const out = {
      title: "write",
      output: "ok",
      metadata: {},
      args: { filePath: "services/x/migrations/0001.up.sql" },
    }
    await plugin["tool.execute.after"]({ tool: "write", args: { filePath: "services/x/migrations/0001.up.sql" } }, out)
    expect(out.output).toContain("SSOT SYNC ADVISORY")
  })
})

describe("command / skill assets", () => {
  test("ssot-check command and ssot-sync skill exist", async () => {
    const command = await Bun.file(path.join(profileRoot, "commands", "ssot-check.md")).text()
    expect(command).toContain("SSOT")
    expect(command.toLowerCase()).toContain("mirror")
    const skill = await Bun.file(path.join(profileRoot, "skills", "ssot-sync", "SKILL.md")).text()
    expect(skill).toContain("name: ssot-sync")
    expect(skill).toContain("pattern K")
  })
})
