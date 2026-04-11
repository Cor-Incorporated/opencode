import { describe, expect, test } from "bun:test"
import { HOOK_EVENTS } from "../../src/hook"
import { HookEntrySchema, HookConfigSchema } from "../../src/hook"

describe("hook.schema", () => {
  describe("HOOK_EVENTS", () => {
    test("contains all 7 events", () => {
      expect(HOOK_EVENTS).toEqual([
        "PreToolUse", "PostToolUse", "SessionStart", "Notification",
        "SessionEnd", "PreCompact", "PostCompact",
      ])
    })

    test("includes new lifecycle events", () => {
      expect(HOOK_EVENTS).toContain("SessionEnd")
      expect(HOOK_EVENTS).toContain("PreCompact")
      expect(HOOK_EVENTS).toContain("PostCompact")
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

    test("rejects empty object (command required for default type)", () => {
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

    test("rejects empty command string", () => {
      const result = HookEntrySchema.safeParse({ command: "" })
      expect(result.success).toBe(false)
    })

    test("type is undefined when omitted (runtime defaults to command)", () => {
      const result = HookEntrySchema.safeParse({ command: "echo hello" })
      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data.type).toBeUndefined()
      }
    })

    test("validates prompt type with prompt field", () => {
      const result = HookEntrySchema.safeParse({
        type: "prompt",
        prompt: "Check {{TOOL_NAME}} usage",
      })
      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data.type).toBe("prompt")
        expect(result.data.prompt).toBe("Check {{TOOL_NAME}} usage")
      }
    })

    test("rejects prompt type without prompt field", () => {
      const result = HookEntrySchema.safeParse({ type: "prompt" })
      expect(result.success).toBe(false)
    })

    test("rejects prompt type with empty prompt", () => {
      const result = HookEntrySchema.safeParse({ type: "prompt", prompt: "" })
      expect(result.success).toBe(false)
    })

    test("rejects command type without command field", () => {
      const result = HookEntrySchema.safeParse({ type: "command" })
      expect(result.success).toBe(false)
    })

    test("accepts explicit type: command", () => {
      const result = HookEntrySchema.safeParse({ type: "command", command: "exit 0" })
      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data.type).toBe("command")
        expect(result.data.command).toBe("exit 0")
      }
    })

    test("backward compat: entry without type is valid", () => {
      const result = HookEntrySchema.safeParse({ command: "exit 0" })
      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data.type).toBeUndefined()
        expect(result.data.command).toBe("exit 0")
      }
    })
  })

  describe("HookConfig", () => {
    test("accepts valid config with all events", () => {
      const result = HookConfigSchema.safeParse({
        PreToolUse: [{ command: "echo pre" }],
        PostToolUse: [{ command: "echo post" }],
        SessionStart: [{ command: "echo start" }],
        Notification: [{ command: "echo notify" }],
        SessionEnd: [{ command: "echo end" }],
        PreCompact: [{ command: "echo precompact" }],
        PostCompact: [{ command: "echo postcompact" }],
      })
      expect(result.success).toBe(true)
    })

    test("accepts config with new events only", () => {
      const result = HookConfigSchema.safeParse({
        SessionEnd: [{ command: "echo end" }],
        PreCompact: [{ command: "echo precompact" }],
        PostCompact: [{ command: "echo postcompact" }],
      })
      expect(result.success).toBe(true)
    })

    test("accepts prompt-type entries in config", () => {
      const result = HookConfigSchema.safeParse({
        PreToolUse: [{ type: "prompt", prompt: "Be careful with {{TOOL_NAME}}" }],
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

    test("rejects non-object entry in array", () => {
      const result = HookConfigSchema.safeParse({
        PreToolUse: ["not-an-object"],
      })
      expect(result.success).toBe(false)
    })
  })
})
