import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { terminal, xml, Notification } from "../src/notification"
import { Process } from "../src/util/process"

describe("notification", () => {
  test("matches known terminal apps exactly after normalization", () => {
    expect(terminal("Terminal")).toBe(true)
    expect(terminal("Visual Studio Code")).toBe(true)
    expect(terminal("Visual Studio Code - Insiders")).toBe(true)
    expect(terminal("Xcode")).toBe(false)
  })

  test("escapes xml payload for windows toasts", () => {
    expect(xml('A&B "title"', "<tag> & 'quote'")).toContain(
      "<text id='1'>A&amp;B &quot;title&quot;</text><text id='2'>&lt;tag&gt; &amp; &apos;quote&apos;</text>",
    )
  })
})

describe("terminalIsFocused", () => {
  let origText: typeof Process.text

  beforeEach(() => {
    origText = Process.text
  })

  afterEach(() => {
    ;(Process as Record<string, unknown>).text = origText
  })

  test("returns false on win32 (allow notifications since show() works)", async () => {
    const result = await Notification.terminalIsFocused("win32")
    expect(result).toBe(false)
  })

  test("returns true on unsupported platforms (freebsd)", async () => {
    const result = await Notification.terminalIsFocused("freebsd")
    expect(result).toBe(true)
  })

  test("linux: returns true when xdotool fails (not installed)", async () => {
    ;(Process as Record<string, unknown>).text = mock(async () => ({
      code: 1,
      stdout: Buffer.alloc(0),
      stderr: Buffer.from("command not found"),
      text: "",
    }))
    const result = await Notification.terminalIsFocused("linux")
    expect(result).toBe(true)
  })

  test("linux: returns true when xdotool returns matching PID", async () => {
    ;(Process as Record<string, unknown>).text = mock(async () => ({
      code: 0,
      stdout: Buffer.from(String(process.pid) + "\n"),
      stderr: Buffer.alloc(0),
      text: String(process.pid) + "\n",
    }))
    const result = await Notification.terminalIsFocused("linux")
    expect(result).toBe(true)
  })

  test("linux: returns false when xdotool returns non-matching PID", async () => {
    const fakePid = 99999
    ;(Process as Record<string, unknown>).text = mock(async () => ({
      code: 0,
      stdout: Buffer.from(String(fakePid) + "\n"),
      stderr: Buffer.alloc(0),
      text: String(fakePid) + "\n",
    }))
    const result = await Notification.terminalIsFocused("linux")
    expect(result).toBe(false)
  })

  test("linux: returns true when xdotool returns non-numeric output", async () => {
    ;(Process as Record<string, unknown>).text = mock(async () => ({
      code: 0,
      stdout: Buffer.from("not-a-number\n"),
      stderr: Buffer.alloc(0),
      text: "not-a-number\n",
    }))
    const result = await Notification.terminalIsFocused("linux")
    expect(result).toBe(true)
  })
})
