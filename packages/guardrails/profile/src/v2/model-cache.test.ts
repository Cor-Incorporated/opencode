import { afterEach, beforeEach, describe, expect, setSystemTime, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import guardrail from "../guardrail"
import { bridge, v1Input } from "./adapter"

const start = Date.UTC(2026, 10, 4)
const ttl = 60_000
const gates = ["context", "compaction", "generate", "title"] as const
const cleanups: Array<() => Promise<void>> = []

beforeEach(() => setSystemTime(new Date(start)))
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
  setSystemTime()
})

type Request = {
  sessionID: string
  agent: string
  model: { id: string; providerID: string }
  system: Array<{ type: "text"; text: string }>
  messages: never[]
  options: Record<string, unknown>
  tools: Record<string, never>
}

function model(status = "active", input = 1) {
  return { id: "catalog-model", providerID: "cache-test", status, cost: [{ input, output: input }] }
}

async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "guardrails-model-cache-"))
  const hooks = new Map<string, (event: Request) => void | Promise<void>>()
  const state = { models: [model()], calls: 0, failure: undefined as Error | undefined }
  let closed = false
  let wake: (() => void) | undefined
  const stream = (async function* () {
    while (!closed) {
      await new Promise<void>((resolve) => (wake = resolve))
      if (!closed) yield { type: "cache-test" }
    }
  })()
  const ctx = {
    location: { directory, project: { directory } },
    session: {
      hook: async (name: string, callback: (event: Request) => void | Promise<void>) => {
        hooks.set(name, callback)
      },
    },
    model: {
      list: async () => {
        state.calls++
        if (state.failure) throw state.failure
        return { data: structuredClone(state.models) }
      },
    },
    tool: { hook: async () => {} },
    shell: { hook: async () => {} },
    event: { subscribe: () => stream },
  }
  const input = v1Input(ctx)
  const stop = await bridge(ctx, await guardrail.server(input), { input })
  cleanups.push(async () => {
    await stop()
    closed = true
    wake?.()
    rmSync(directory, { recursive: true, force: true })
  })
  return {
    state,
    request: async (gate: (typeof gates)[number]) => {
      const hook = hooks.get(gate)
      if (!hook) throw new Error(`Missing ${gate} hook`)
      await hook({
        sessionID: "ses_cache",
        agent: "implement",
        model: { id: "catalog-model", providerID: "cache-test" },
        system: [],
        messages: [],
        options: {},
        tools: {},
      })
    },
  }
}

describe("model catalog cache through the real guardrail gates", () => {
  test.each(gates)(
    "%s reuses the snapshot before TTL and refreshes an existing model's cost after TTL",
    async (gate) => {
      const f = await fixture()
      await f.request(gate)
      expect(f.state.calls).toBe(1)
      f.state.models = [model("active", 0)]
      setSystemTime(new Date(start + ttl - 1))
      await f.request(gate)
      expect(f.state.calls).toBe(1)
      setSystemTime(new Date(start + ttl + 1))
      await expect(f.request(gate)).rejects.toThrow(/free-tier/)
      expect(f.state.calls).toBe(2)
    },
  )

  test.each(gates)("%s refreshes an existing model's preview status after TTL", async (gate) => {
    const f = await fixture()
    await f.request(gate)
    f.state.models = [model("beta")]
    setSystemTime(new Date(start + ttl + 1))
    await expect(f.request(gate)).rejects.toThrow(/preview-only/)
    expect(f.state.calls).toBe(2)
  })

  test.each(gates)("%s removes absent models from a refreshed snapshot", async (gate) => {
    const f = await fixture()
    f.state.models = [model("beta")]
    await expect(f.request(gate)).rejects.toThrow(/preview-only/)
    f.state.models = []
    setSystemTime(new Date(start + ttl + 1))
    // An absent model has unknown status/cost; it must not retain an old preview classification.
    await f.request(gate)
    expect(f.state.calls).toBe(2)
  })

  test.each(gates)("%s retains the last policy snapshot on refresh failure and retries after TTL", async (gate) => {
    const f = await fixture()
    f.state.models = [model("beta")]
    await expect(f.request(gate)).rejects.toThrow(/preview-only/)
    f.state.models = [model()]
    f.state.failure = new Error("catalog unavailable")
    setSystemTime(new Date(start + ttl + 1))
    await expect(f.request(gate)).rejects.toThrow(/preview-only/)
    expect(f.state.calls).toBe(2)
    f.state.failure = undefined
    setSystemTime(new Date(start + ttl + 2))
    await expect(f.request(gate)).rejects.toThrow(/preview-only/)
    expect(f.state.calls).toBe(2)
    setSystemTime(new Date(start + 2 * ttl + 2))
    await f.request(gate)
    expect(f.state.calls).toBe(3)
  })
})
