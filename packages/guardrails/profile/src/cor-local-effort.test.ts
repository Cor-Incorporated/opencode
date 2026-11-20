/**
 * OpenCode sends each listed effort as reasoning_effort with no remap
 * (packages/core/src/variant.ts), and the selected variant is shared across
 * model switches.
 *
 * Measured 2026-11-21 against the live entrance, max_tokens=16:
 * qwen3.8-27b-unc and qwen3.8-flash-next return HTTP 500 for "high"
 * (Jinja: supported types are xhigh, medium, and low).
 * gemma4-26b-a4b-unc accepts "high" (HTTP 200), so this test does not claim
 * that every model rejects it. The advertised list is the intersection.
 * A list that still contains "high" fails. Provider id stays cor-local.
 *
 * Run: bun test profile/src/cor-local-effort.test.ts
 * (from packages/guardrails; this file imports only the two json copies)
 */
import { expect, test } from "bun:test"
import managed from "../../managed/opencode.json"
import profile from "../opencode.json"

const reasoningIds = ["gemma4-26b-a4b-unc", "qwen3.8-27b-unc", "qwen3.8-flash-next"] as const
const want = ["low", "medium", "xhigh"]

test("both cor-local copies advertise low/medium/xhigh and not high", () => {
  for (const config of [managed, profile]) {
    const provider = config.providers["cor-local"]
    expect(provider.name).toBe("Cor local (EVO-X2 router)")
    const models = provider.models
    for (const id of reasoningIds) {
      const effort = models[id].capabilities.reasoning.effort
      expect(effort).toEqual(want)
      expect(effort).not.toContain("high")
    }
    expect("reasoning" in models["flint-40b-a2.5b-abliterated"].capabilities).toBe(false)
  }
})
