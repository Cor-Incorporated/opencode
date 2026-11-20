/**
 * Flash-Next's client window must be the server slot, not the total KV.
 *
 * Measured 2026-11-20T16:51:18Z on evo-x2-2: llama-server was started with
 * --ctx-size 131072 --parallel 4, and the journal said
 * n_slots = 4, n_ctx_slot = 32768, kv_unified = false.
 * A compaction of 31700 input tokens then had about 1068 tokens of output
 * left and finished because it hit the length limit.
 * parallel 1 keeps the same KV (131072) and gives one request the whole window.
 * output stays 16384. A context of 32768 fails this test.
 *
 * Run: bun test ./profile/src/cor-local-context.test.ts
 * (from packages/guardrails; this file imports only the two json copies)
 */
import { expect, test } from "bun:test"
import managed from "../../managed/opencode.json"
import profile from "../opencode.json"

const measuredCompactionInput = 31_700
const ids = ["flint-40b-a2.5b-abliterated", "gemma4-26b-a4b-unc", "qwen3.8-27b-unc", "qwen3.8-flash-next"] as const

test("both cor-local copies give every id a 131072 window and 16384 output", () => {
  for (const config of [managed, profile]) {
    const provider = config.providers["cor-local"]
    expect(provider.name).toBe("Cor local (EVO-X2 router)")
    for (const id of ids) {
      const limit = provider.models[id].limit
      expect(limit).toEqual({ context: 131072, output: 16384 })
      expect(limit.context - measuredCompactionInput).toBeGreaterThanOrEqual(limit.output)
    }
  }
})
