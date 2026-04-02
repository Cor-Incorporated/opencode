import { expect, test } from "bun:test"
import { ManagedRuntime } from "effect"

import { TestLLMServer } from "./llm-server"

test("unmatched tool-result follow-up fails instead of auto-acking", async () => {
  const rt = ManagedRuntime.make(TestLLMServer.layer)

  try {
    const svc = await rt.runPromise(TestLLMServer.asEffect())
    const res = await fetch(`${svc.url}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        messages: [
          {
            role: "assistant",
            tool_calls: [{ id: "call_1", type: "function", function: { name: "bash", arguments: "{}" } }],
          },
          { role: "tool", tool_call_id: "call_1", content: "done" },
        ],
      }),
    })

    expect(res.status).toBe(500)
    expect(await res.text()).toContain("unexpected request")
    expect(await rt.runPromise(svc.misses)).toHaveLength(1)
  } finally {
    await rt.dispose()
  }
})
