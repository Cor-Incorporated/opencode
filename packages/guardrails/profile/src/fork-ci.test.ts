import { describe, expect, test } from "bun:test"
import { existsSync, readFileSync, readdirSync } from "node:fs"
import path from "node:path"

const root = path.resolve(import.meta.dir, "../../../..")
const directory = path.join(root, ".github/workflows")
const upstream = "anomalyco/opencode"
const fork = "Cor-Incorporated/opencode"

type Job = {
  "runs-on"?: string
  if?: string
  strategy?: {
    matrix?: Record<string, unknown>
  }
  steps?: {
    name?: string
    id?: string
    if?: string
    run?: string
    uses?: string
    with?: Record<string, string | number>
    env?: Record<string, string>
  }[]
}

type Workflow = { on?: unknown; jobs: Record<string, Job> }

function workflow(...names: string[]) {
  const name = names.find((name) => existsSync(path.join(directory, name)))
  if (!name) throw new Error(`Missing workflow: ${names.join(" / ")}`)
  return Bun.YAML.parse(readFileSync(path.join(directory, name), "utf8")) as Workflow
}

// These workflow expressions use the shared JavaScript/GitHub subset: property access, strings, ==, && and ||.
// Evaluate the actual YAML expressions, not a second runner-selection implementation.
function evaluate(
  value: unknown,
  repository: string,
  name = "linux",
  event = "push",
  base = "",
  inputs: Record<string, boolean> = { quarantine: false, release_gate: false },
  matrix: Record<string, unknown> = {},
): unknown {
  if (value === undefined) return true
  if (typeof value === "number") return value
  if (typeof value !== "string") return value
  if (!value.includes("${{") && !value.includes("github.")) return value
  const expression = value.replace(/^\$\{\{\s*|\s*\}\}$/g, "")
  return new Function("github", "matrix", "steps", "inputs", "fromJSON", "cancelled", `return (${expression})`)(
    {
      repository,
      event_name: event,
      ref: "refs/heads/dev",
      event: { pull_request: { draft: false } },
    },
    { settings: { name, host: `blacksmith-4vcpu-${name === "windows" ? "windows-2025" : "ubuntu-2404"}` }, ...matrix },
    { lint_base: { outputs: { base } } },
    inputs,
    JSON.parse,
    () => false,
  )
}

// A push reaches this repository on dev. Tag-only pushes and other branches do not run the fork's checks.
function triggers(config: Workflow, event: "pull_request" | "push") {
  const on = config.on
  if (typeof on === "string") return on === event
  if (Array.isArray(on)) return on.includes(event)
  if (!on || typeof on !== "object") return false
  const value = (on as Record<string, unknown>)[event]
  if (!(event in (on as Record<string, unknown>))) return false
  if (event === "pull_request") return true
  if (value === null || value === undefined) return true
  if (typeof value !== "object" || Array.isArray(value)) return true
  const push = value as Record<string, unknown>
  if (push.branches !== undefined) return Array.isArray(push.branches) && push.branches.includes("dev")
  return push.tags === undefined
}

// Expand the matrix the way GitHub does for these workflows: every axis value, plus explicit include rows.
function matrixRows(matrix: unknown, repository: string, event: string): Record<string, unknown>[] {
  if (!matrix || typeof matrix !== "object" || Array.isArray(matrix)) return [{}]
  const entries = Object.entries(matrix as Record<string, unknown>).filter(([key]) => key !== "include" && key !== "exclude")
  const rows = entries.reduce<Record<string, unknown>[]>(
    (rows, [key, value]) =>
      rows.flatMap((row) =>
        (Array.isArray(value) ? value : [value]).map((item) => ({
          ...row,
          [key]: typeof item === "string" ? evaluate(item, repository, "linux", event) : item,
        })),
      ),
    [{}],
  )
  const include = (matrix as Record<string, unknown>).include
  if (Array.isArray(include)) {
    for (const entry of include) {
      if (!entry || typeof entry !== "object") continue
      rows.push(
        Object.fromEntries(
          Object.entries(entry).map(([key, value]) => [
            key,
            typeof value === "string" ? evaluate(value, repository, "linux", event) : value,
          ]),
        ),
      )
    }
  }
  return rows
}

function runsInFork(job: Job, event: string, matrix: Record<string, unknown>) {
  try {
    return evaluate(job.if, fork, "linux", event, "", undefined, matrix) !== false
  } catch {
    // An expression the evaluator does not model (for example needs.*) cannot prove the job is skipped.
    return true
  }
}

describe("fork CI runner eligibility", () => {
  for (const names of [
    ["check.yml"],
    ["check-test.yml", "test.yml"],
    ["check-nix.yml", "nix-eval.yml"],
    ["storybook.yml"],
  ]) {
    if (names[0] === "storybook.yml" && !existsSync(path.join(directory, names[0]))) continue
    for (const [id, job] of Object.entries(workflow(...names).jobs)) {
      test(`${names[0]} / ${id} keeps upstream runners and uses standard fork runners`, () => {
        for (const name of ["linux", "windows"]) {
          expect(["ubuntu-24.04", "windows-2025"]).toContain(evaluate(job["runs-on"], fork, name))
          expect(String(evaluate(job["runs-on"], upstream, name))).toStartWith("blacksmith-")
        }
      })
    }
  }
  test("clean unit runners install verified ripgrep before exercising the real search tools", () => {
    const steps = workflow("check-test.yml", "test.yml").jobs.unit.steps ?? []
    for (const os of ["Linux", "Windows"]) {
      const install = steps.find((step) => step.name === `Prepare ripgrep (${os})`)
      expect(install?.if).toBe(`runner.os == '${os}'`)
      expect(install?.run).toContain("https://github.com/BurntSushi/ripgrep/releases/download/15.1.0/")
      expect(install?.run).toMatch(/[a-f0-9]{64}/)
    }
    const verify = steps.find((step) => step.name === "Verify search tool prerequisites")
    expect(verify?.run).toContain("script/test.ts test/ripgrep.test.ts test/tool-search.test.ts")
    expect(steps.indexOf(verify!)).toBeLessThan(steps.findIndex((step) => step.name === "Run unit tests"))
  })
  test("guardrails installs the frozen workspace before importing the native normalizer", () => {
    const steps = workflow("guardrails.yml").jobs.test.steps ?? []
    const install = steps.find((step) => step.run === "bun install --frozen-lockfile")
    const run = steps.findIndex((step) => step.run === "bun test profile/src profile/plugins")
    expect(install).toBeDefined()
    expect(steps.indexOf(install!)).toBeLessThan(run)
  })
  test("fork pull requests keep complete history without changing upstream checkout depth", () => {
    const checkout = workflow("check.yml").jobs.check.steps?.find((step) => step.name === "Checkout repository")
    expect(evaluate(checkout?.with?.["fetch-depth"], fork, "linux", "pull_request")).toBe("0")
    expect(String(evaluate(checkout?.with?.["fetch-depth"], fork))).toBe("2")
    expect(String(evaluate(checkout?.with?.["fetch-depth"], upstream, "linux", "pull_request"))).toBe("2")
  })
  test("only fork pull requests resolve and consume the upstream merge base", () => {
    const steps = workflow("check.yml").jobs.check.steps ?? []
    const resolve = steps.find((step) => step.id === "lint_base")
    const lint = steps.find((step) => step.name === "Lint changed files")
    expect(resolve).toBeDefined()
    expect(evaluate(resolve?.if, fork, "linux", "pull_request")).toBe(true)
    expect(evaluate(resolve?.if, upstream, "linux", "pull_request")).toBe(false)
    expect(evaluate(resolve?.if, fork)).toBe(false)
    expect(steps.indexOf(resolve!)).toBeLessThan(steps.indexOf(lint!))
    const sha = "55276f2108c8853f94cf16dc530e7754a6ce8318"
    expect(evaluate(lint?.env?.LINT_BASE, fork, "linux", "pull_request", sha)).toBe(sha)
    expect(evaluate(lint?.env?.LINT_BASE, upstream, "linux", "pull_request", sha)).toBe("HEAD^1")
    expect(evaluate(lint?.env?.LINT_BASE, fork, "linux", "pull_request")).toBe("")
  })
})

describe("fork workflow runners", () => {
  test("no job that runs on a fork pull request or dev push waits for an upstream runner", () => {
    const violations: string[] = []
    const files = readdirSync(directory)
      .filter((file) => file.endsWith(".yml") || file.endsWith(".yaml"))
      .sort()
    for (const file of files) {
      const config = Bun.YAML.parse(readFileSync(path.join(directory, file), "utf8")) as Workflow
      for (const event of ["pull_request", "push"] as const) {
        if (!triggers(config, event)) continue
        for (const [id, job] of Object.entries(config.jobs ?? {})) {
          if (!job || typeof job !== "object" || job["runs-on"] === undefined) continue
          for (const matrix of matrixRows(job.strategy?.matrix, fork, event)) {
            if (!runsInFork(job, event, matrix)) continue
            const runner = evaluate(job["runs-on"], fork, "linux", event, "", undefined, matrix)
            for (const name of Array.isArray(runner) ? runner : [runner]) {
              if (typeof name === "string" && name.startsWith("blacksmith")) violations.push(`${file} / ${id} / ${name}`)
            }
          }
        }
      }
    }
    expect([...new Set(violations)].sort()).toEqual([])
  })
})

describe("fork pull request test tier", () => {
  const jobs = workflow("check-test.yml", "test.yml").jobs

  function runs(expression: string | number | undefined, repository: string, event: string) {
    return Boolean(evaluate(expression, repository, "linux", event))
  }

  function unitRunners(repository: string, event: string) {
    const settings = jobs.unit.strategy?.matrix?.settings
    if (typeof settings !== "string") return []
    const value = evaluate(settings, repository, "linux", event)
    const rows = Array.isArray(value) ? value : typeof value === "string" ? JSON.parse(value) : []
    return (rows as { name: string }[]).map((entry) => entry.name)
  }

  for (const event of ["pull_request", "push"]) {
    for (const repository of [fork, upstream]) {
      test(`${repository} ${event}: affected, unit (windows), build and e2e run in the expected tier`, () => {
        const expected = repository === fork || event === "push"
        const actual = {
          "affected packages": runs(jobs.affected.if, repository, event),
          "unit (windows)": unitRunners(repository, event).includes("windows"),
          "build (linux)": runs(jobs.build.if, repository, event),
          "build (windows)": runs(jobs.build.if, repository, event),
          "e2e (linux)": runs(jobs.e2e.if, repository, event),
          "e2e (windows)": runs(jobs.e2e.if, repository, event),
        }
        expect(actual).toEqual(Object.fromEntries(Object.keys(actual).map((job) => [job, expected])))
      })
    }
  }
})

describe("upstream-only automation", () => {
  test("process daemon publishing is upstream-only while fork builds remain eligible", () => {
    const jobs = workflow("release-process-daemon.yml").jobs
    expect(evaluate(jobs.release.if, fork)).toBe(false)
    expect(evaluate(jobs.release.if, upstream)).toBe(true)
    for (const id of ["checks", "build", "build-windows"]) expect(evaluate(jobs[id].if, fork)).toBe(true)
  })
  for (const names of [
    ["triage-close-prs.yml", "close-prs.yml"],
    ["triage-close-issues.yml", "close-issues.yml"],
  ]) {
    test(`${names[0]} cannot operate on the upstream repository from a fork`, () => {
      expect(evaluate(workflow(...names).jobs.close.if, fork)).toBe(false)
      expect(evaluate(workflow(...names).jobs.close.if, upstream)).toBe(true)
    })
  }
  test("fork-owned compliance automation remains available", () => {
    const config = workflow("triage-compliance-close.yml", "compliance-close.yml")
    expect(Object.values(config.jobs).some((job) => evaluate(job.if, fork) !== false)).toBe(true)
  })
  for (const names of [["triage.yml"], ["bot-nix-hashes.yml", "nix-hashes.yml"]]) {
    if (!names.some((name) => existsSync(path.join(directory, name)))) continue
    test(`${names[0]} does not start upstream credential or model automation on a fork`, () => {
      for (const job of Object.values(workflow(...names).jobs)) {
        expect(evaluate(job.if, fork)).toBe(false)
        expect(evaluate(job.if, upstream)).toBe(true)
      }
    })
  }
})
