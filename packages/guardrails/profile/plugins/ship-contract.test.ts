import { afterAll, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { guardrail } from "./guardrail"
import type { GuardrailInput } from "./guardrail-context"

const root = await mkdtemp(path.join(tmpdir(), "opencode-ship-contract-"))
// This hook must not query an LLM or network service.
function unexpectedClientCall(): never {
  throw new Error("Ship context must not call a client")
}
const client: GuardrailInput["client"] = {
  session: {
    create: unexpectedClientCall,
    promptAsync: unexpectedClientCall,
    prompt: unexpectedClientCall,
    status: unexpectedClientCall,
    messages: unexpectedClientCall,
    abort: unexpectedClientCall,
  },
}

afterAll(() => rm(root, { recursive: true, force: true }))

describe("ship instructions match the retired receipt policy", () => {
  test("command requires actual current-head reviews, not a retired receipt producer", async () => {
    const text = await Bun.file(new URL("../commands/ship.md", import.meta.url)).text()
    expect(text).toContain("code-reviewer and Codex")
    expect(text).toContain("current PR head")
    expect(text).toContain("required by the selected tier")
    expect(text).toContain("Legacy runtime review fields are advisory")
    expect(text).toContain("--match-head-commit")
    expect(text).not.toContain("Verify the guardrail review_state")
    expect(text).not.toContain("plugin enforces this at merge time")
  })

  test("ship agent preserves independent reviews and GitHub checks without false enforcement claims", async () => {
    const text = await Bun.file(new URL("../agents/ship.md", import.meta.url)).text()
    expect(text).toContain("code-reviewer and Codex")
    expect(text).toContain("current PR head")
    expect(text).toContain("GitHub branch protection and required checks")
    expect(text).toContain("Legacy runtime review fields are advisory")
    expect(text).not.toContain('review_state must be "done"')
    expect(text).not.toContain("plugin enforces merge gates at the tool level")
    expect(text).toContain('"gh pr merge * --admin*": deny')
    expect(text).toContain('"gh pr merge * --auto*": deny')
  })

  test("actual command hook labels legacy review telemetry advisory while retaining the fact gate", async () => {
    const plugin = await guardrail({ client, directory: root, worktree: root })
    const output = { parts: [{ type: "subtask", prompt: "Verify the current PR before merging." }] }
    await plugin["command.execute.before"](
      { command: "ship", sessionID: "test-ship-contract", arguments: "" },
      output,
    )
    expect(output.parts[0].prompt).toContain("Legacy review telemetry is not merge admission")
    expect(output.parts[0].prompt).toContain("actual reviews of the current PR head")
    expect(output.parts[0].prompt).toContain("tier's actual reviews")
    expect(output.parts[0].prompt).toContain("Treat missing or stale fact-check state as an explicit gate")
    expect(output.parts[0].prompt).not.toContain("fact-check/review state as an explicit gate")
  })
})
