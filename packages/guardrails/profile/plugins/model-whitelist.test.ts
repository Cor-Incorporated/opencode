/**
 * The model whitelist lives in three places that must move together:
 *
 *   1. packages/guardrails/managed/opencode.json   (admin profile)
 *   2. packages/guardrails/profile/opencode.json   (packaged profile)
 *   3. guardrail-patterns.ts `paid`                (free-vs-paid classification)
 *
 * 2026-09-02: all three were stale. `glm-5.3-flash` (released 2026-08-26) was
 * absent everywhere, as were `claude-opus-5`, `claude-sonnet-5` and
 * `gpt-5.6-luna` -- the last being the model Codex itself runs. The provider
 * *routes* were all present, which is what made the staleness easy to miss:
 * checking "is deepseek wired up?" says yes while the model list rots.
 *
 * `--check-openrouter-catalog` compares the whitelist against the live catalog,
 * but needs network and only covers openrouter. These tests are offline and
 * cover the drift that actually breaks the runtime: a model offered by one copy
 * and rejected by another.
 *
 * Run: bun test packages/guardrails/profile/plugins/model-whitelist.test.ts
 */
import { describe, expect, test } from "bun:test"
import managed from "../../managed/opencode.json"
import profile from "../opencode.json"
import { paid } from "./guardrail-patterns"

type Config = { provider?: Record<string, { whitelist?: string[] }> }

const providers = (config: Config) => Object.keys(config.provider ?? {})
const whitelist = (config: Config, id: string) => config.provider?.[id]?.whitelist ?? []

describe("model whitelist stays consistent across its copies", () => {
  test("managed and packaged profiles declare the same providers", () => {
    expect(providers(profile as Config).sort()).toEqual(providers(managed as Config).sort())
  })

  for (const id of providers(managed as Config)) {
    test(`${id}: managed and packaged whitelists match`, () => {
      // A model offered by one copy and missing from the other is silently
      // unusable: the CLI lists it, the guardrail rejects it.
      expect(whitelist(profile as Config, id)).toEqual(whitelist(managed as Config, id))
    })
  }

  // `paid` answers "is this zero-cost model actually free?". Plan-covered models
  // report cost 0 -- zai-coding-plan/glm-5.3-flash does -- so a model missing
  // from `paid` is misclassified as free and skips the paid-model handling.
  for (const id of Object.keys(paid)) {
    test(`${id}: every whitelisted model is classified in paid`, () => {
      const declared = whitelist(managed as Config, id)
      expect(declared.length).toBeGreaterThan(0)
      const unclassified = declared.filter((model) => !paid[id].has(model))
      expect(unclassified).toEqual([])
    })
  }

  test("models the user explicitly asked for are present", () => {
    // Regression pins for 2026-09-02. glm-5.3-flash is the model whose absence
    // surfaced the staleness; gpt-5.6-luna is what Codex runs today.
    expect(whitelist(managed as Config, "zai-coding-plan")).toContain("glm-5.3-flash")
    expect(whitelist(managed as Config, "zai")).toContain("glm-5.3-flash")
    expect(whitelist(managed as Config, "openrouter")).toContain("z-ai/glm-5.3-flash")
    expect(whitelist(managed as Config, "openai")).toContain("gpt-5.6-luna")
  })

  test("Codex subscription models survive catalog-driven edits", () => {
    // models.dev does not list the gpt-5.x-codex ids, which are reachable only
    // through the Codex OAuth flow. A refresh that syncs blindly to the catalog
    // deletes them and quietly removes the subscription route.
    for (const model of ["gpt-5.1-codex", "gpt-5.1-codex-max", "gpt-5.2-codex", "gpt-5.3-codex"]) {
      expect(whitelist(managed as Config, "openai")).toContain(model)
    }
  })
})
