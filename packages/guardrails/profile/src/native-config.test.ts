import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { ConfigNormalize } from "@opencode/core/config/normalize"
import managed from "../../managed/opencode.json"
import profile from "../opencode.json"
import { profileConfig } from "../plugins/guardrail"

describe("packaged 2.x provider configuration", () => {
  for (const [name, config] of Object.entries({ managed, profile })) {
    test(`${name}: the production normalizer preserves native settings without diagnostics`, () => {
      const result = ConfigNormalize.normalize(config)
      expect(result.type).toBe("normalized")
      if (result.type !== "normalized") throw new Error("profile rejected")
      expect(result.diagnostics).toEqual([])
      expect(result.encoded).toMatchObject({
        model: { providerID: "zai-coding-plan", model: "glm-5.3" },
        providers: {
          "zai-coding-plan": {
            models: {
              "glm-5.2-highspeed": { disabled: true },
              "glm-5.3-highspeed": { disabled: true },
            },
          },
          "cor-local": {
            package: "@opencode/ai/providers/openai-compatible",
            settings: { baseURL: "{env:COR_LOCAL_BASE_URL}", apiKey: "{env:COR_LOCAL_API_KEY}", provider: "cor-local" },
            models: {
              "deepseek-v4-flash-0731": { capabilities: { reasoning: { supported: true } } },
              "glm53-flash": { capabilities: { reasoning: { supported: true } } },
              "qwen3.8-27b": { capabilities: { reasoning: { supported: true } } },
            },
          },
        },
      })
    })
  }

  test("the admission policy loader rejects absent or malformed policies", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "guardrail-policy-"))
    try {
      writeFileSync(path.join(dir, "opencode.json"), JSON.stringify({ providers: { openai: {} } }))
      expect(() => profileConfig(dir)).toThrow()
      writeFileSync(path.join(dir, "model-policy.json"), JSON.stringify({ provider: { openai: { whitelist: [] } } }))
      expect(() => profileConfig(dir)).toThrow(/model policy/)
      writeFileSync(
        path.join(dir, "model-policy.json"),
        JSON.stringify({ provider: { openai: { whitelist: ["gpt-5.3-codex"] } } }),
      )
      expect(profileConfig(dir)).toEqual({ provider: { openai: { whitelist: ["gpt-5.3-codex"] } } })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  for (const [name, provider] of Object.entries({
    "array instead of a provider record": [{ whitelist: ["glm-5.3"] }],
    "missing a natively configured provider": { openai: { whitelist: ["gpt-5.3-codex"] } },
  })) {
    test(`the admission policy loader rejects ${name}`, () => {
      const dir = mkdtempSync(path.join(tmpdir(), "guardrail-policy-coverage-"))
      try {
        writeFileSync(
          path.join(dir, "opencode.json"),
          JSON.stringify({ providers: { openai: {}, "zai-coding-plan": {} } }),
        )
        writeFileSync(path.join(dir, "model-policy.json"), JSON.stringify({ provider }))
        expect(() => profileConfig(dir)).toThrow(/model policy/)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })
  }

  test("coverage follows explicitly configured providers instead of a fixed packaged provider list", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "guardrail-policy-custom-provider-"))
    const provider = {
      openai: { whitelist: ["gpt-5.3-codex"] },
      custom: { whitelist: ["custom-model"] },
    }
    try {
      writeFileSync(path.join(dir, "opencode.json"), JSON.stringify({ providers: { openai: {}, custom: {} } }))
      writeFileSync(path.join(dir, "model-policy.json"), JSON.stringify({ provider }))
      expect(profileConfig(dir)).toEqual({ provider })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
