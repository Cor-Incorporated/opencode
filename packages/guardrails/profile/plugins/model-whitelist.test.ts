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
import { free, paid, preview } from "./guardrail-patterns"

type ModelLimit = { context?: number; output?: number }
type Config = {
  provider?: Record<
    string,
    {
      whitelist?: string[]
      models?: Record<string, { limit?: ModelLimit }>
      options?: Record<string, unknown>
    }
  >
}

const providers = (config: Config) => Object.keys(config.provider ?? {})
const whitelist = (config: Config, id: string) => config.provider?.[id]?.whitelist ?? []
const modelLimit = (config: Config, providerID: string, modelID: string) =>
  config.provider?.[providerID]?.models?.[modelID]?.limit ?? {}
const providerOptions = (config: Config, providerID: string) => config.provider?.[providerID]?.options ?? {}

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

  // The three copies agreeing with each other says nothing about whether they
  // agree with the catalog -- on 2026-09-02 all three were stale together. The
  // committed snapshot is what makes that answerable offline, and this is the
  // check that fails when a model reaches the catalog and not the whitelist.
  test("the whitelist covers every model in the committed catalog snapshot", () => {
    const script = new URL("../../../../scripts/sync-model-whitelist.py", import.meta.url).pathname
    const run = Bun.spawnSync(["python3", script])
    const output = new TextDecoder().decode(run.stdout) + new TextDecoder().decode(run.stderr)
    expect(output).not.toContain("snapshot missing")
    expect(run.exitCode, `sync-model-whitelist.py --check failed:\n${output}`).toBe(0)
  })

  test("Codex subscription models survive catalog-driven edits", () => {
    // models.dev does not list the gpt-5.x-codex ids, which are reachable only
    // through the Codex OAuth flow. A refresh that syncs blindly to the catalog
    // deletes them and quietly removes the subscription route.
    for (const model of ["gpt-5.1-codex", "gpt-5.1-codex-max", "gpt-5.2-codex", "gpt-5.3-codex"]) {
      expect(whitelist(managed as Config, "openai")).toContain(model)
    }
  })

  // Packet P5: cor-local (llama-server router, Mac Studio, fully offline/opt-in).
  // These ids report cost 0 because the router is self-hosted, not because
  // they are a free tier -- pin the whitelist and the preview()/free() truth
  // table so a future edit cannot silently let denyFree block the local lane
  // or denyPreview reject these ids as previews.
  describe("cor-local (local llama-server router)", () => {
    const ids = ["deepseek-v4-flash-0731", "glm53-flash", "qwen3.8-27b"]

    test("whitelist is exactly the 3 local model ids in both copies", () => {
      expect(whitelist(managed as Config, "cor-local")).toEqual(ids)
      expect(whitelist(profile as Config, "cor-local")).toEqual(ids)
    })

    // Packet A3b (2026-09-05): baseURL/apiKey moved from the hardcoded
    // `http://127.0.0.1:18082/v1` / no-key pair to `{env:...}` substitution
    // so a MacBook can reach the router over tailnet with one key, without
    // touching this repo. `{env:VAR}` resolves an unset var to "" (see
    // packages/opencode/src/config/variable.ts) rather than erroring, so the
    // live wrapper (scripts/local-dev-deploy.sh) must supply a default for
    // baseURL -- pin the `{env:...}` form here so a future edit cannot
    // silently reintroduce a hardcoded URL/key and orphan the wrapper's
    // defaulting logic (covered separately in
    // cor-local-wrapper-env-defaults.test.ts).
    test("baseURL/apiKey are {env:...} substitutions in both copies", () => {
      for (const config of [managed as Config, profile as Config]) {
        const options = providerOptions(config, "cor-local")
        expect(options.baseURL).toBe("{env:COR_LOCAL_BASE_URL}")
        expect(options.apiKey).toBe("{env:COR_LOCAL_API_KEY}")
      }
    })

    // 2026-09-03: with limit.context at 32768, the guardrails profile's
    // AGENTS.md + system prompt + tool schemas left so little headroom that
    // opencode's compaction (packages/opencode/src/session/compaction.ts)
    // fired its synthetic "Continue if you have next steps..." after every
    // single step -- qwen3.8-27b and glm53-flash both fixed the target bug
    // (pytest green) but looped re-planning and never terminated. The router
    // (ai-cluster repo, llama-server launcher) moved to `-c 65536`; this pins
    // limit.context to the same value so the two sides cannot drift again.
    for (const id of ids) {
      test(`${id}: limit.context is 65536 (router -c) and limit.output is 16384 in both copies`, () => {
        expect(modelLimit(managed as Config, "cor-local", id)).toEqual({
          context: 65536,
          output: 16384,
        })
        expect(modelLimit(profile as Config, "cor-local", id)).toEqual({
          context: 65536,
          output: 16384,
        })
      })
    }

    for (const id of ids) {
      test(`${id}: preview() is false`, () => {
        expect(preview({ id, status: "active" })).toBe(false)
      })

      test(`${id}: free() is false (self-hosted, not free-tier)`, () => {
        expect(
          free({
            providerID: "cor-local",
            id,
            cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
          }),
        ).toBe(false)
      })
    }
  })
})
