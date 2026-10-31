/**
 * cor-os: the Cor OS router at llm.cor-jp.com (OpenAI-compatible, Cloudflare Access / Tunnel inside, Bearer
 * COR_OS_LLM_TOKEN_NEXT). Unlike cor-local, the router checks the requested model name against what it publishes, so
 * pointing cor-local at it does not work: the guardrail admits only cor-local's three llama-server ids and the
 * router answers model_not_found for them (ai-cluster PR #607, measured against a stub on 2026-10-31).
 *
 * The block mirrors ai-cluster ops/opencode-pi/opencode.cor-os.json, which render_client_config.py generates from
 * ops/opencode-pi/cor-os-models.json. The two model ids are the router's public aliases as of cor-os a43df4e;
 * verify_router.py's /v1/models confirms which of them production publishes.
 *
 * Run: bun test packages/guardrails/profile/src/cor-os-router-lane.test.ts
 */
import { describe, expect, test } from "bun:test"
import managed from "../../managed/opencode.json"
import profile from "../opencode.json"
import { free, paid, preview } from "./guardrail-patterns"

type Provider = {
  whitelist?: string[]
  models?: Record<string, { limit?: { context?: number; output?: number }; cost?: unknown }>
  options?: Record<string, unknown>
}
type Config = { enabled_providers?: string[]; disabled_providers?: string[]; provider?: Record<string, Provider> }

const ids = ["cor-qwen3.6-35b", "gemma4-12b"]
const copies = [
  ["managed", managed as Config],
  ["profile", profile as Config],
] as const

describe("cor-os (Cor OS router, llm.cor-jp.com)", () => {
  for (const [name, config] of copies) {
    const provider = config.provider?.["cor-os"] ?? {}

    test(`${name}: enabled and not disabled`, () => {
      expect(config.enabled_providers ?? []).toContain("cor-os")
      expect(config.disabled_providers ?? []).not.toContain("cor-os")
    })

    test(`${name}: whitelist is exactly the router's public aliases and each one is defined`, () => {
      expect(provider.whitelist).toEqual(ids)
      expect(Object.keys(provider.models ?? {}).sort()).toEqual(ids)
    })

    // The token never lives in the config: {env:VAR} splices the environment value, and an unset variable becomes
    // "" so @ai-sdk/openai-compatible sends no Authorization header and the router answers 401.
    test(`${name}: baseURL is the production router and apiKey is the COR_OS_LLM_TOKEN_NEXT substitution`, () => {
      expect(provider.options?.baseURL).toBe("https://llm.cor-jp.com/v1")
      expect(provider.options?.apiKey).toBe("{env:COR_OS_LLM_TOKEN_NEXT}")
    })

    // The production runner is `-c 32768 -np 1` (ai-cluster research/local-llm/runs/20261030); a larger
    // limit.context would let opencode send requests the router's backend truncates.
    for (const id of ids) {
      test(`${name}: ${id} limit is context 32768 / output 8192 and has no cost`, () => {
        expect(provider.models?.[id]?.limit).toEqual({ context: 32768, output: 8192 })
        expect(provider.models?.[id]?.cost).toBeUndefined()
      })
    }
  }

  test("managed and profile carry the same cor-os block", () => {
    expect((profile as Config).provider?.["cor-os"]).toEqual((managed as Config).provider?.["cor-os"])
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
