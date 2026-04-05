import { describe, expect, test } from "bun:test"
import { runHooks, type HookEnv } from "../../src/hook"
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

/**
 * Applies PreToolUse hook context injection to built-in tool output.
 * Mirrors the logic in prompt.ts Site 1.
 */
function injectPreToolUseContext(
  hookMessage: string | undefined,
  originalOutput: string,
): string {
  if (hookMessage) {
    return `<hook-context>\n${hookMessage}\n</hook-context>\n\n${originalOutput}`
  }
  return originalOutput
}

/**
 * Applies PostToolUse hook context injection to built-in tool output.
 * Mirrors the logic in prompt.ts Site 2.
 */
function injectPostToolUseContext(
  hookMessage: string | undefined,
  currentOutput: string,
): string {
  if (hookMessage) {
    return `${currentOutput}\n\n<hook-context>\n${hookMessage}\n</hook-context>`
  }
  return currentOutput
}

describe("hook context injection", () => {
  describe("PreToolUse pass-with-message injects <hook-context>", () => {
    test("stderr message from exit 0 produces hook-context prefix", async () => {
      const entries: HookEntry[] = [
        { command: 'echo "security warning: path is sensitive" >&2; exit 0' },
      ]
      const result = await runHooks(entries, "bash", makeEnv())

      expect(result.action).toBe("pass")
      expect(result.message).toBe("security warning: path is sensitive")

      const toolOutput = "file contents here"
      const injected = injectPreToolUseContext(result.message, toolOutput)
      expect(injected).toBe(
        `<hook-context>\nsecurity warning: path is sensitive\n</hook-context>\n\n${toolOutput}`,
      )
    })

    test("multiple hook messages are joined and wrapped", async () => {
      const entries: HookEntry[] = [
        { command: 'echo "check-1: ok" >&2; exit 0' },
        { command: 'echo "check-2: warning" >&2; exit 0' },
      ]
      const result = await runHooks(entries, "bash", makeEnv())

      expect(result.action).toBe("pass")
      expect(result.message).toBe("check-1: ok\ncheck-2: warning")

      const toolOutput = "tool result"
      const injected = injectPreToolUseContext(result.message, toolOutput)
      expect(injected).toContain("<hook-context>")
      expect(injected).toContain("check-1: ok\ncheck-2: warning")
      expect(injected).toEndWith(toolOutput)
    })
  })

  describe("pass-without-message leaves output unchanged", () => {
    test("exit 0 without stderr produces no injection", async () => {
      const entries: HookEntry[] = [{ command: "exit 0" }]
      const result = await runHooks(entries, "bash", makeEnv())

      expect(result.action).toBe("pass")
      expect(result.message).toBeUndefined()

      const toolOutput = "original output"
      const injected = injectPreToolUseContext(result.message, toolOutput)
      expect(injected).toBe(toolOutput)
    })

    test("empty entries produce no injection", async () => {
      const result = await runHooks([], "bash", makeEnv())

      expect(result.action).toBe("pass")
      expect(result.message).toBeUndefined()

      const toolOutput = "original output"
      const injected = injectPreToolUseContext(result.message, toolOutput)
      expect(injected).toBe(toolOutput)
    })
  })

  describe("block still works as before", () => {
    test("exit 2 returns block and does not reach injection", async () => {
      const entries: HookEntry[] = [
        { command: 'echo "forbidden" >&2; exit 2' },
      ]
      const result = await runHooks(entries, "bash", makeEnv())

      expect(result.action).toBe("block")
      expect(result.message).toBe("forbidden")

      // In prompt.ts, block returns early before injection code runs.
      // Verify the block message is usable as-is for the error output.
      expect(result.message).not.toContain("<hook-context>")
    })
  })

  describe("PostToolUse context injection", () => {
    test("post-hook message is appended as suffix", async () => {
      const entries: HookEntry[] = [
        { command: 'echo "audit: file was read" >&2; exit 0' },
      ]
      const result = await runHooks(
        entries,
        "bash",
        makeEnv({ OPENCODE_HOOK_EVENT: "PostToolUse" }),
      )

      expect(result.action).toBe("pass")
      expect(result.message).toBe("audit: file was read")

      const toolOutput = "file contents here"
      const injected = injectPostToolUseContext(result.message, toolOutput)
      expect(injected).toBe(
        `${toolOutput}\n\n<hook-context>\naudit: file was read\n</hook-context>`,
      )
    })

    test("post-hook without message leaves output unchanged", async () => {
      const entries: HookEntry[] = [{ command: "exit 0" }]
      const result = await runHooks(
        entries,
        "bash",
        makeEnv({ OPENCODE_HOOK_EVENT: "PostToolUse" }),
      )

      expect(result.action).toBe("pass")
      expect(result.message).toBeUndefined()

      const toolOutput = "original output"
      const injected = injectPostToolUseContext(result.message, toolOutput)
      expect(injected).toBe(toolOutput)
    })
  })

  describe("combined Pre + Post injection", () => {
    test("both hooks inject context around tool output", async () => {
      const preEntries: HookEntry[] = [
        { command: 'echo "pre-context: checking" >&2; exit 0' },
      ]
      const postEntries: HookEntry[] = [
        { command: 'echo "post-context: logged" >&2; exit 0' },
      ]

      const preResult = await runHooks(preEntries, "bash", makeEnv())
      const postResult = await runHooks(
        postEntries,
        "bash",
        makeEnv({ OPENCODE_HOOK_EVENT: "PostToolUse" }),
      )

      let output = "tool execution result"
      output = injectPreToolUseContext(preResult.message, output)
      output = injectPostToolUseContext(postResult.message, output)

      expect(output).toStartWith("<hook-context>\npre-context: checking\n</hook-context>")
      expect(output).toContain("tool execution result")
      expect(output).toEndWith("<hook-context>\npost-context: logged\n</hook-context>")
    })
  })
})
