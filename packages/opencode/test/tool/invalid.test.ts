import { describe, expect, test } from "bun:test"
import { formatInvalidToolError } from "@/tool/invalid"

describe("invalid tool", () => {
  test("compacts malformed JSON input while preserving the parser message", () => {
    const error = [
      "Invalid input for tool team: JSON parsing failed: Text: ",
      `{"strategy":"parallel","tasks":[${"\\t\\n".repeat(100_000)}`,
      "\nError message: JSON Parse error: Expected ':' before value in object property definition",
    ].join("")
    const formatted = formatInvalidToolError(error)

    expect(formatted).toContain("Invalid input for tool team: JSON parsing failed:")
    expect(formatted).toContain("Tool input preview:")
    expect(formatted).toContain("[invalid tool input truncated:")
    expect(formatted).toContain("Error message: JSON Parse error")
    expect(formatted.length).toBeLessThan(3200)
    expect(formatted).not.toContain("\\t\\n".repeat(200))
  })

  test("compacts long validation errors without raw tool input markers", () => {
    const formatted = formatInvalidToolError(`schema mismatch: ${"x".repeat(10_000)}`)

    expect(formatted).toContain("schema mismatch:")
    expect(formatted).toContain("[invalid tool error truncated:")
    expect(formatted.length).toBeLessThan(4300)
  })
})
