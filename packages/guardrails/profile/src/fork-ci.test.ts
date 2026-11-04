import { describe, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import path from "node:path"

const root = path.resolve(import.meta.dir, "../../../..")
const directory = path.join(root, ".github/workflows")
const upstream = "anomalyco/opencode"
const fork = "Cor-Incorporated/opencode"

type Job = { "runs-on"?: string; if?: string }

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
    { repository, event_name: "push" },
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
  for (const name of ["triage.yml", "nix-hashes.yml"]) {
    if (!existsSync(path.join(directory, name))) continue
    test(`${name} does not start upstream credential or model automation on a fork`, () => {
      for (const job of Object.values(workflow(name).jobs)) {
        expect(evaluate(job.if, fork)).toBe(false)
        expect(evaluate(job.if, upstream)).toBe(true)
      }
    })
  }
})
