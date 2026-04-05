import { describe, expect, test } from "bun:test"
import { terminal, xml } from "../src/notification"

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
