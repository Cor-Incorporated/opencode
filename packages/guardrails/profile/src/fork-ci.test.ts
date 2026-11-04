import { describe, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import path from "node:path"

const root = path.resolve(import.meta.dir, "../../../..")
const directory = path.join(root, ".github/workflows")
const upstream = "anomalyco/opencode"
const fork = "Cor-Incorporated/opencode"

type Job = { "runs-on"?: string; if?: string; steps?: { name?: string; if?: string; run?: string; uses?: string }[] }

function workflow(...names: string[]) {
  const name = names.find((name) => existsSync(path.join(directory, name)))
  if (!name) throw new Error(`Missing workflow: ${names.join(" / ")}`)
  return Bun.YAML.parse(readFileSync(path.join(directory, name), "utf8")) as { jobs: Record<string, Job> }
}

// These workflow expressions use the shared JavaScript/GitHub subset: property access, strings, ==, && and ||.
// Evaluate the actual YAML expressions, not a second runner-selection implementation.
function evaluate(value: string | undefined, repository: string, name = "linux") {
  if (value === undefined) return true
  if (!value.includes("${{") && !value.includes("github.")) return value
  const expression = value.replace(/^\$\{\{\s*|\s*\}\}$/g, "")
  return new Function("github", "matrix", `return (${expression})`)(
    { repository, event_name: "push", ref: "refs/heads/dev" },
    { settings: { name, host: `blacksmith-4vcpu-${name === "windows" ? "windows-2025" : "ubuntu-2404"}` } },
  ) as string | boolean
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
})

describe("upstream-only automation", () => {
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
