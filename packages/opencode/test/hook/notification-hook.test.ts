import { describe, expect, test } from "bun:test"
import { runHooks, type HookEnv } from "../../src/hook"
import type { HookEntry } from "../../src/hook"

function makeNotificationEnv(overrides?: Partial<HookEnv>): HookEnv {
  return {
    OPENCODE_HOOK_EVENT: "Notification",
    OPENCODE_TOOL_INPUT: JSON.stringify({ title: "opencode", body: "session completed" }),
    OPENCODE_PROJECT_DIR: "/tmp/test",
    OPENCODE_SESSION_ID: "test-session-id",
    ...overrides,
  }
}

describe("hook.notification", () => {
  describe("Notification hook env vars", () => {
    test("receives OPENCODE_HOOK_EVENT as Notification", async () => {
      const entry: HookEntry = {
        command: 'test "$OPENCODE_HOOK_EVENT" = "Notification" && exit 0 || exit 1',
      }
      const result = await runHooks([entry], "", makeNotificationEnv())
      expect(result.action).toBe("pass")
    })

    test("receives OPENCODE_TOOL_INPUT with title and body", async () => {
      const entry: HookEntry = {
        command: 'echo "$OPENCODE_TOOL_INPUT" >&2; exit 0',
      }
      const env = makeNotificationEnv({
        OPENCODE_TOOL_INPUT: JSON.stringify({ title: "opencode", body: "test completed" }),
      })
      const result = await runHooks([entry], "", env)
      expect(result.action).toBe("pass")
      expect(result.message).toContain("opencode")
      expect(result.message).toContain("test completed")
    })

    test("receives OPENCODE_PROJECT_DIR", async () => {
      const entry: HookEntry = {
        command: 'echo "$OPENCODE_PROJECT_DIR" >&2; exit 0',
      }
      const env = makeNotificationEnv({ OPENCODE_PROJECT_DIR: "/my/project" })
      const result = await runHooks([entry], "", env)
      expect(result.action).toBe("pass")
      expect(result.message).toBe("/my/project")
    })

    test("receives OPENCODE_SESSION_ID", async () => {
      const entry: HookEntry = {
        command: 'echo "$OPENCODE_SESSION_ID" >&2; exit 0',
      }
      const env = makeNotificationEnv({ OPENCODE_SESSION_ID: "sess-abc123" })
      const result = await runHooks([entry], "", env)
      expect(result.action).toBe("pass")
      expect(result.message).toBe("sess-abc123")
    })

    test("OPENCODE_TOOL_NAME is not set for notification hooks", async () => {
      const entry: HookEntry = {
        command: 'test -z "$OPENCODE_TOOL_NAME" && echo "empty" >&2 || echo "set" >&2; exit 0',
      }
      const result = await runHooks([entry], "", makeNotificationEnv())
      expect(result.action).toBe("pass")
      expect(result.message).toBe("empty")
    })
  })

  describe("block action suppresses notification", () => {
    test("exit 2 returns block", async () => {
      const entries: HookEntry[] = [
        { command: 'echo "suppressed" >&2; exit 2' },
      ]
      const result = await runHooks(entries, "", makeNotificationEnv())
      expect(result.action).toBe("block")
      expect(result.message).toBe("suppressed")
    })

    test("first entry passes, second blocks", async () => {
      const entries: HookEntry[] = [
        { command: 'echo "logging" >&2; exit 0' },
        { command: 'echo "blocked" >&2; exit 2' },
      ]
      const result = await runHooks(entries, "", makeNotificationEnv())
      expect(result.action).toBe("block")
      expect(result.message).toBe("logging\nblocked")
    })
  })

  describe("pass action allows notification", () => {
    test("exit 0 returns pass", async () => {
      const entries: HookEntry[] = [{ command: "exit 0" }]
      const result = await runHooks(entries, "", makeNotificationEnv())
      expect(result.action).toBe("pass")
    })

    test("multiple passing entries all run", async () => {
      const entries: HookEntry[] = [
        { command: 'echo "first" >&2; exit 0' },
        { command: 'echo "second" >&2; exit 0' },
      ]
      const result = await runHooks(entries, "", makeNotificationEnv())
      expect(result.action).toBe("pass")
      expect(result.message).toBe("first\nsecond")
    })

    test("unexpected exit code (1) treated as pass", async () => {
      const entries: HookEntry[] = [{ command: "exit 1" }]
      const result = await runHooks(entries, "", makeNotificationEnv())
      expect(result.action).toBe("pass")
    })
  })

  describe("empty/undefined entries", () => {
    test("undefined entries returns pass", async () => {
      const result = await runHooks(undefined, "", makeNotificationEnv())
      expect(result.action).toBe("pass")
    })

    test("empty entries returns pass", async () => {
      const result = await runHooks([], "", makeNotificationEnv())
      expect(result.action).toBe("pass")
    })
  })

  describe("matcher is ignored for notification hooks (toolName is empty)", () => {
    test("entries with matcher still run when toolName is empty", async () => {
      const entries: HookEntry[] = [
        { command: 'echo "ran" >&2; exit 0', matcher: "bash" },
      ]
      // matcher "bash" does not match empty string toolName, so this entry is skipped
      const result = await runHooks(entries, "", makeNotificationEnv())
      expect(result.action).toBe("pass")
      expect(result.message).toBeUndefined()
    })

    test("entries without matcher run for notification hooks", async () => {
      const entries: HookEntry[] = [
        { command: 'echo "global" >&2; exit 0' },
      ]
      const result = await runHooks(entries, "", makeNotificationEnv())
      expect(result.action).toBe("pass")
      expect(result.message).toBe("global")
    })
  })
})
