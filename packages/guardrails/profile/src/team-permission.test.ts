/**
 * T5-1: worker permission must not blanket-allow.
 * Run: bun test packages/guardrails/profile/plugins/team-permission.test.ts
 * (or tsx/node if bun unavailable — pure unit, no OpenCode runtime)
 */
import { describe, expect, test } from "bun:test"
import { isBlanketAllow, workerPermission } from "./team"

type Rule = { permission: string; pattern: string; action: "allow" | "deny" | "ask" }

describe("T5-1 worker permission inheritance", () => {
  test("pre-fix shape: blanket allow is detectable", () => {
    const old: Rule[] = [
      { permission: "*", pattern: "*", action: "allow" },
      { permission: "edit", pattern: "*", action: "allow" },
      { permission: "external_directory", pattern: "*", action: "allow" },
      { permission: "bash", pattern: "*", action: "allow" },
    ]
    expect(isBlanketAllow(old)).toBe(true)
  })

  test("workerPermission never returns blanket allow", () => {
    const rules = workerPermission()
    expect(isBlanketAllow(rules)).toBe(false)
  })

  test("workerPermission inherits parent rules when present", () => {
    const parent: Rule[] = [
      { permission: "bash", pattern: "git push --force*", action: "deny" },
      { permission: "bash", pattern: "git push *", action: "ask" },
      { permission: "bash", pattern: "*", action: "ask" },
      { permission: "edit", pattern: "*", action: "ask" },
      { permission: "external_directory", pattern: "*", action: "ask" },
    ]
    const rules = workerPermission(parent)
    expect(rules).toEqual(parent)
    expect(isBlanketAllow(rules)).toBe(false)
  })

  test("empty parent still denies force-push and rm -rf", () => {
    const rules = workerPermission([])
    const denials = rules.filter((r) => r.action === "deny")
    expect(denials.some((r) => r.pattern.includes("force"))).toBe(true)
    expect(denials.some((r) => r.pattern.includes("rm -rf"))).toBe(true)
    // no blanket allow
    expect(rules.every((r) => !(r.permission === "*" && r.action === "allow"))).toBe(true)
  })

  test("false positive: normal feature push stays ask not deny when parent says so", () => {
    const parent: Rule[] = [
      { permission: "bash", pattern: "git push --force*", action: "deny" },
      { permission: "bash", pattern: "git push *", action: "ask" },
    ]
    const rules = workerPermission(parent)
    const feature = rules.find((r) => r.pattern === "git push *")
    expect(feature?.action).toBe("ask")
  })
})
