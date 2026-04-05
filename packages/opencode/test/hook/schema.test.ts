import { describe, expect, test } from "bun:test"
import { HOOK_EVENTS } from "../../src/hook"
import { HookEntrySchema, HookConfigSchema } from "../../src/hook"

describe("hook.schema", () => {
  describe("HOOK_EVENTS", () => {
    test("contains expected events", () => {
      expect(HOOK_EVENTS).toEqual(["PreToolUse", "PostToolUse", "SessionStart", "Notification"])
    })
  })

  describe("HookEntry", () => {
    test("validates minimal entry", () => {
      const result = HookEntrySchema.safeParse({ command: "echo hello" })
      expect(result.success).toBe(true)
    })

    test("validates full entry", () => {
      const result = HookEntrySchema.safeParse({
        command: "echo hello",
        matcher: "bash*",
        timeout: 5000,
      })
      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data.command).toBe("echo hello")
        expect(result.data.matcher).toBe("bash*")
        expect(result.data.timeout).toBe(5000)
      }
    })

    test("rejects missing command", () => {
      const result = HookEntrySchema.safeParse({})
      expect(result.success).toBe(false)
    })

    test("rejects negative timeout", () => {
      const result = HookEntrySchema.safeParse({ command: "echo", timeout: -1 })
      expect(result.success).toBe(false)
    })

    test("rejects zero timeout", () => {
      const result = HookEntrySchema.safeParse({ command: "echo", timeout: 0 })
      expect(result.success).toBe(false)
    })

    test("rejects non-integer timeout", () => {
      const result = HookEntrySchema.safeParse({ command: "echo", timeout: 1.5 })
      expect(result.success).toBe(false)
    })
  })

  describe("HookConfig", () => {
    test("accepts valid config with all events", () => {
      const result = HookConfigSchema.safeParse({
        PreToolUse: [{ command: "echo pre" }],
        PostToolUse: [{ command: "echo post" }],
        SessionStart: [{ command: "echo start" }],
        Notification: [{ command: "echo notify" }],
      })
      expect(result.success).toBe(true)
    })

    test("accepts partial config", () => {
      const result = HookConfigSchema.safeParse({
        PreToolUse: [{ command: "echo pre" }],
      })
      expect(result.success).toBe(true)
    })

    test("accepts undefined", () => {
      const result = HookConfigSchema.safeParse(undefined)
      expect(result.success).toBe(true)
    })

    test("rejects invalid event name", () => {
      const result = HookConfigSchema.safeParse({
        InvalidEvent: [{ command: "echo" }],
      })
      expect(result.success).toBe(false)
    })

    test("rejects invalid entry in array", () => {
      const result = HookConfigSchema.safeParse({
        PreToolUse: [{ notcommand: "echo" }],
      })
      expect(result.success).toBe(false)
    })
  })
})
