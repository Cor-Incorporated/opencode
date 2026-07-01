import { describe, expect, test } from "bun:test"
import { Session } from "@/session/session"

describe("session default title detection", () => {
  test("treats stable placeholder titles as default", () => {
    expect(Session.isDefaultTitle("Untitled session")).toBe(true)
    expect(Session.isDefaultTitle("Untitled child session")).toBe(true)
  })

  test("keeps legacy timestamp placeholders eligible for title replacement", () => {
    expect(Session.isDefaultTitle("New session - 2026-07-01T00:00:00.000Z")).toBe(true)
    expect(Session.isDefaultTitle("Child session - 2026-07-01T00:00:00.000Z")).toBe(true)
  })
})
