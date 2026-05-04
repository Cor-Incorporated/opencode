import { describe, expect, test } from "bun:test"

import { ANCHOR_REGEX, annotateLines, formatAnchor, parseAnchor } from "../anchor.js"
import { hashLine } from "../hash.js"

describe("ANCHOR_REGEX", () => {
  test("matches valid anchors", () => {
    expect(ANCHOR_REGEX.test("1#ZZ")).toBe(true)
    expect(ANCHOR_REGEX.test("42#KT")).toBe(true)
    expect(ANCHOR_REGEX.test("999999#HH")).toBe(true)
  })

  test("rejects malformed anchors", () => {
    expect(ANCHOR_REGEX.test("42")).toBe(false)
    expect(ANCHOR_REGEX.test("42#AC")).toBe(false) // A and C not in alphabet
    expect(ANCHOR_REGEX.test("42#IO")).toBe(false) // I and O excluded
    expect(ANCHOR_REGEX.test("42#LL")).toBe(false) // L excluded
    expect(ANCHOR_REGEX.test("0#KT")).toBe(false) // line 0 invalid
    expect(ANCHOR_REGEX.test("42# KT")).toBe(false) // whitespace
    expect(ANCHOR_REGEX.test("042#KT")).toBe(false) // leading zero
    expect(ANCHOR_REGEX.test("42#K")).toBe(false) // hash too short
    expect(ANCHOR_REGEX.test("42#KTX")).toBe(false) // hash too long
    expect(ANCHOR_REGEX.test("42#kt")).toBe(false) // lowercase
    expect(ANCHOR_REGEX.test("-1#KT")).toBe(false) // negative
    expect(ANCHOR_REGEX.test("")).toBe(false)
  })
})

describe("parseAnchor", () => {
  test("parses valid anchors", () => {
    expect(parseAnchor("1#ZZ")).toEqual({ line: 1, hash: "ZZ" })
    expect(parseAnchor("42#KT")).toEqual({ line: 42, hash: "KT" })
  })

  test("returns null for malformed input", () => {
    expect(parseAnchor("42")).toBeNull()
    expect(parseAnchor("42#AC")).toBeNull() // A and C not in alphabet
    expect(parseAnchor("42#IO")).toBeNull() // I and O excluded
    expect(parseAnchor("0#KT")).toBeNull()
    expect(parseAnchor("42# KT")).toBeNull()
    expect(parseAnchor("")).toBeNull()
  })

  test("returns null for non-string input", () => {
    // @ts-expect-error — runtime guard
    expect(parseAnchor(42)).toBeNull()
    // @ts-expect-error — runtime guard
    expect(parseAnchor(null)).toBeNull()
    // @ts-expect-error — runtime guard
    expect(parseAnchor(undefined)).toBeNull()
  })
})

describe("formatAnchor", () => {
  test("round-trips via parseAnchor", () => {
    const samples: Array<[number, string]> = [
      [1, ""],
      [42, "  export function foo() {"],
      [100, "}"],
      [7, "console.log('hi')"],
    ]
    for (const [line, content] of samples) {
      const formatted = formatAnchor(line, content)
      const parsed = parseAnchor(formatted)
      expect(parsed).not.toBeNull()
      expect(parsed!.line).toBe(line)
      expect(parsed!.hash).toBe(hashLine(content))
    }
  })

  test("throws on invalid line numbers", () => {
    expect(() => formatAnchor(0, "x")).toThrow()
    expect(() => formatAnchor(-1, "x")).toThrow()
    expect(() => formatAnchor(1.5, "x")).toThrow()
    expect(() => formatAnchor(Number.NaN, "x")).toThrow()
  })
})

describe("annotateLines", () => {
  test("produces LINE#ID|content for each line", () => {
    const lines = ["alpha", "beta", "gamma"]
    const out = annotateLines(lines)
    expect(out).toHaveLength(3)
    for (let i = 0; i < lines.length; i++) {
      const expectedAnchor = formatAnchor(i + 1, lines[i]!)
      expect(out[i]).toBe(`${expectedAnchor}|${lines[i]!}`)
    }
  })

  test("handles empty input", () => {
    expect(annotateLines([])).toEqual([])
  })

  test("handles empty lines (line 1 of an empty file is '')", () => {
    const out = annotateLines([""])
    expect(out).toHaveLength(1)
    expect(out[0]).toBe(`${formatAnchor(1, "")}|`)
  })
})
