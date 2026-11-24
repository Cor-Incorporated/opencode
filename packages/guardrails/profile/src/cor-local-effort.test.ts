// The profiles advertise shared reasoning choices because OpenCode forwards
// the selected variant as reasoning_effort across model switches.
import { expect, test } from "bun:test"
import managed from "../../managed/opencode.json"
import profile from "../opencode.json"

const reasoningIds = ["gemma4-26b-a4b-unc", "inkling-2-mini-abliterated", "qwen3.8-27b-unc", "qwen3.8-flash-next"] as const
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
