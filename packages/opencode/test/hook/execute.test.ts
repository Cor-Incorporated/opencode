import { describe, expect, test } from "bun:test"
import { runHook, runHooks, matchesTool, safeToolInput, type HookEnv } from "../../src/hook"
import type { HookEntry } from "../../src/hook"

function makeEnv(overrides?: Partial<HookEnv>): HookEnv {
  return {
    OPENCODE_HOOK_EVENT: "PreToolUse",
    OPENCODE_TOOL_NAME: "bash",
    OPENCODE_TOOL_INPUT: "{}",
    OPENCODE_PROJECT_DIR: "/tmp/test",
    OPENCODE_SESSION_ID: "test-session-id",
    ...overrides,
  }
}

describe("hook.execute", () => {
  describe("runHook", () => {
    test("exit 0 returns pass", async () => {
      const entry: HookEntry = { command: "exit 0" }
      const result = await runHook(entry, makeEnv())
      expect(result.action).toBe("pass")
    })

    test("exit 0 with stderr returns pass with message", async () => {
      const entry: HookEntry = { command: 'echo "info message" >&2; exit 0' }
      const result = await runHook(entry, makeEnv())
      expect(result.action).toBe("pass")
      expect(result.message).toBe("info message")
    })

    test("exit 2 returns block with stderr", async () => {
      const entry: HookEntry = { command: 'echo "not allowed" >&2; exit 2' }
      const result = await runHook(entry, makeEnv())
      expect(result.action).toBe("block")
      expect(result.message).toBe("not allowed")
    })

    test("exit 2 without stderr returns block with default message", async () => {
      const entry: HookEntry = { command: "exit 2" }
      const result = await runHook(entry, makeEnv())
      expect(result.action).toBe("block")
      expect(result.message).toBe("Blocked by hook")
    })

    test("exit 1 returns pass (unexpected code warning)", async () => {
      const entry: HookEntry = { command: "exit 1" }
      const result = await runHook(entry, makeEnv())
      expect(result.action).toBe("pass")
    })

    test("exit 3 returns pass (unexpected code warning)", async () => {
      const entry: HookEntry = { command: "exit 3" }
      const result = await runHook(entry, makeEnv())
      expect(result.action).toBe("pass")
    })

    test("timeout returns pass", async () => {
      const entry: HookEntry = { command: "sleep 10", timeout: 200 }
      const result = await runHook(entry, makeEnv())
      expect(result.action).toBe("pass")
    }, 5000)

    test("passes environment variables to script", async () => {
      const entry: HookEntry = { command: 'echo "$OPENCODE_TOOL_NAME" >&2' }
      const result = await runHook(entry, makeEnv({ OPENCODE_TOOL_NAME: "test_tool" }))
      expect(result.action).toBe("pass")
      expect(result.message).toBe("test_tool")
    })

    test("nonexistent command returns pass", async () => {
      const entry: HookEntry = { command: "/nonexistent/path/script.sh" }
      const result = await runHook(entry, makeEnv())
      expect(result.action).toBe("pass")
    })
  })

  describe("matchesTool", () => {
    test("undefined matcher matches all", () => {
      expect(matchesTool(undefined, "bash")).toBe(true)
      expect(matchesTool(undefined, "read")).toBe(true)
    })

    test("exact match", () => {
      expect(matchesTool("bash", "bash")).toBe(true)
      expect(matchesTool("bash", "read")).toBe(false)
    })

    test("glob match with trailing wildcard", () => {
      expect(matchesTool("bash*", "bash")).toBe(true)
      expect(matchesTool("bash*", "bash_tool")).toBe(true)
      expect(matchesTool("bash*", "read")).toBe(false)
    })

    test("glob prefix match", () => {
      expect(matchesTool("mcp_*", "mcp_server")).toBe(true)
      expect(matchesTool("mcp_*", "mcp_")).toBe(true)
      expect(matchesTool("mcp_*", "other")).toBe(false)
    })
  })

  describe("runHooks", () => {
    test("empty entries returns pass", async () => {
      const result = await runHooks([], "bash", makeEnv())
      expect(result.action).toBe("pass")
      expect(result.message).toBeUndefined()
    })

    test("undefined entries returns pass", async () => {
      const result = await runHooks(undefined, "bash", makeEnv())
      expect(result.action).toBe("pass")
      expect(result.message).toBeUndefined()
    })

    test("runs multiple entries and collects messages", async () => {
      const entries: HookEntry[] = [
        { command: 'echo "first" >&2; exit 0' },
        { command: 'echo "second" >&2; exit 0' },
      ]
      const result = await runHooks(entries, "bash", makeEnv())
      expect(result.action).toBe("pass")
      expect(result.message).toBe("first\nsecond")
    })

    test("stops at first block", async () => {
      const entries: HookEntry[] = [
        { command: 'echo "ok" >&2; exit 0' },
        { command: 'echo "blocked" >&2; exit 2' },
        { command: 'echo "never" >&2; exit 0' },
      ]
      const result = await runHooks(entries, "bash", makeEnv())
      expect(result.action).toBe("block")
      expect(result.message).toBe("ok\nblocked")
    })

    test("skips entries that do not match tool name", async () => {
      const entries: HookEntry[] = [
        { command: 'echo "matched" >&2; exit 0', matcher: "bash" },
        { command: 'echo "skipped" >&2; exit 2', matcher: "read" },
      ]
      const result = await runHooks(entries, "bash", makeEnv())
      expect(result.action).toBe("pass")
      expect(result.message).toBe("matched")
    })

    test("entries without matcher run for all tools", async () => {
      const entries: HookEntry[] = [{ command: 'echo "global" >&2; exit 0' }]
      const result = await runHooks(entries, "any_tool", makeEnv())
      expect(result.action).toBe("pass")
      expect(result.message).toBe("global")
    })
  })

  describe("safeToolInput", () => {
    test("returns JSON for small input", () => {
      const result = safeToolInput({ key: "value" })
      expect(result).toBe('{"key":"value"}')
    })

    test("truncates input exceeding 128KB", () => {
      const largeArgs = { data: "x".repeat(256 * 1024) }
      const result = safeToolInput(largeArgs)
      expect(result.length).toBeLessThanOrEqual(128 * 1024 + 12) // 128KB + "\n[truncated]"
      expect(result).toEndWith("\n[truncated]")
    })

    test("does not truncate input exactly at 128KB", () => {
      // Create input that serializes to exactly 128KB
      const targetLen = 128 * 1024
      const overhead = '{"d":""}'.length
      const filler = "a".repeat(targetLen - overhead)
      const result = safeToolInput({ d: filler })
      expect(result).not.toContain("[truncated]")
    })
  })
})
