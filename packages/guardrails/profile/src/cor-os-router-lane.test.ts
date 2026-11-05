/**
 * cor-os: the Cor OS router at llm.cor-jp.com (OpenAI-compatible, Cloudflare Access / Tunnel inside, Bearer
 * COR_OS_LLM_TOKEN_NEXT). Unlike cor-local, the router checks the requested model name against what it publishes, so
 * pointing cor-local at it does not work: the guardrail admits only cor-local's three llama-server ids and the
 * router answers model_not_found for them (ai-cluster PR #607, measured against a stub on 2026-10-31).
 *
 * Port of Cor-Incorporated/opencode#356 to the 2.x configuration: the runtime block lives in the native `providers`
 * schema, admission in `policies` (provider.use) and in model-policy.json (model ids). The two model ids are the
 * router's public aliases as of cor-os a43df4e; ai-cluster verify_router.py's /v1/models confirms which of them
 * production publishes.
 *
 * Run: bun test packages/guardrails/profile/src/cor-os-router-lane.test.ts
 */
import { describe, expect, test } from "bun:test"
import { ConfigNormalize } from "@opencode/core/config/normalize"
import { ManagedPolicy } from "@opencode/core/managed-policy"
import managedConfig from "../../managed/opencode.json"
import managedPolicy from "../../managed/model-policy.json"
import profileConfig from "../opencode.json"
import profilePolicy from "../model-policy.json"
import { free, paid, preview } from "./guardrail-patterns"

type Provider = {
  package?: string
  settings?: Record<string, unknown>
  models?: Record<string, { limit?: { context?: number; output?: number }; cost?: unknown }>
}
type Config = {
  policies?: { action: string; resource: string; effect: string }[]
  providers?: Record<string, Provider>
}
type Policy = { provider: Record<string, { whitelist: string[] }> }

const ids = ["cor-qwen3.6-35b", "gemma4-12b"]
const copies = [
  ["managed", managedConfig as Config, managedPolicy as Policy],
  ["profile", profileConfig as Config, profilePolicy as Policy],
] as const

describe("cor-os (Cor OS router, llm.cor-jp.com)", () => {
  for (const [name, config, policy] of copies) {
    const provider = config.providers?.["cor-os"] ?? {}

    // Judged by upstream's own evaluator (last match wins), so a trailing `*` rule in either direction fails here.
    test(`${name}: provider.use allows cor-os and still denies a provider that is not listed`, () => {
      const policies = (config.policies ?? []) as Parameters<typeof ManagedPolicy.decision>[0]
      expect(ManagedPolicy.decision(policies, "provider.use", "cor-os")).toBe("allow")
      expect(ManagedPolicy.decision(policies, "provider.use", "zai")).toBe("deny")
      expect(ManagedPolicy.decision(policies, "provider.use", "unlisted-provider")).toBe("deny")
    })

    test(`${name}: admission is exactly the router's public aliases and each one is defined`, () => {
      expect(policy.provider["cor-os"]?.whitelist).toEqual(ids)
      expect(Object.keys(provider.models ?? {}).sort()).toEqual(ids)
    })

    // The token never lives in the config: {env:VAR} splices the environment value. An unset variable becomes "",
    // which the 2.x resolver drops (core model-resolver.ts prepareRuntimeModel), so no token is ever sent.
    test(`${name}: baseURL is the production router and apiKey is the COR_OS_LLM_TOKEN_NEXT substitution`, () => {
      expect(provider.package).toBe("@opencode/ai/providers/openai-compatible")
      expect(provider.settings?.baseURL).toBe("https://llm.cor-jp.com/v1")
      expect(provider.settings?.apiKey).toBe("{env:COR_OS_LLM_TOKEN_NEXT}")
    })

    // The production runner is `-c 32768 -np 1` (ai-cluster research/local-llm/runs/20261030); a larger
    // limit.context would let opencode send requests the router's backend truncates.
    for (const id of ids) {
      test(`${name}: ${id} limit is context 32768 / output 8192 and has no cost`, () => {
        expect(provider.models?.[id]?.limit).toEqual({ context: 32768, output: 8192 })
        expect(provider.models?.[id]?.cost).toBeUndefined()
      })
    }

    test(`${name}: the production normalizer keeps the cor-os block without diagnostics`, () => {
      const result = ConfigNormalize.normalize(config)
      expect(result.type).toBe("normalized")
      if (result.type !== "normalized") throw new Error("profile rejected")
      expect(result.diagnostics).toEqual([])
      expect(result.encoded).toMatchObject({
        providers: { "cor-os": { settings: { baseURL: "https://llm.cor-jp.com/v1", provider: "cor-os" } } },
      })
    })
  }

  test("managed and profile carry the same cor-os block", () => {
    expect((profileConfig as Config).providers?.["cor-os"]).toEqual((managedConfig as Config).providers?.["cor-os"])
  })

  for (const id of ids) {
    test(`${id}: classified in paid, so free() is false even with a zero cost`, () => {
      expect(paid["cor-os"]?.has(id)).toBe(true)
      expect(free({ providerID: "cor-os", id, cost: { input: 0, output: 0, cache: { read: 0, write: 0 } } })).toBe(
        false,
      )
    })

    test(`${id}: preview() is false`, () => {
      expect(preview({ id, status: "active" })).toBe(false)
    })
  }
})
