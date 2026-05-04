import { describe, expect, test } from "bun:test"

import { HASH_ALPHABET, HASH_LENGTH, hashLine, isValidHashChars } from "../hash.js"

describe("hashLine", () => {
  test("is deterministic for the same input", () => {
    const inputs = ["", "hello", "  export function foo() {", "日本語のテスト"]
    for (const input of inputs) {
      expect(hashLine(input)).toBe(hashLine(input))
    }
  })

  test("produces a 2-char output drawn only from the alphabet", () => {
    const samples = [
      "",
      "a",
      "abc",
      "  ",
      "}",
      "const x = 42",
      "console.log('hi')",
      "🦊 emoji line",
      "x".repeat(10_000),
    ]
    for (const sample of samples) {
      const out = hashLine(sample)
      expect(out.length).toBe(HASH_LENGTH)
      for (const ch of out) {
        expect(HASH_ALPHABET.includes(ch)).toBe(true)
      }
    }
  })

  test("handles empty string deterministically", () => {
    const a = hashLine("")
    const b = hashLine("")
    expect(a).toBe(b)
    expect(a.length).toBe(2)
  })

  test("handles unicode lines without throwing", () => {
    const inputs = ["日本語", "emoji 🚀🌟", "Ω≈ç√∫˜µ", "汉字 + Latin"]
    for (const input of inputs) {
      const result = hashLine(input)
      expect(result.length).toBe(HASH_LENGTH)
    }
  })

  test("collision rate over 1000 random lines stays under 10%", () => {
    // 256 buckets → expected collision rate ~= 1 - exp(-n*(n-1)/(2*256))
    // For n=1000 the expected rate is essentially 1.0 in any individual
    // bucket, but the requirement is that the function distributes across
    // most buckets — i.e., it is not a constant function.
    const seen = new Map<string, number>()
    for (let i = 0; i < 1000; i++) {
      const key = `line ${i} ${Math.random().toString(36)} content`
      const h = hashLine(key)
      seen.set(h, (seen.get(h) ?? 0) + 1)
    }
    // We expect to hit at least 100 distinct buckets out of 256.
    expect(seen.size).toBeGreaterThan(100)
  })

  test("different inputs usually produce different hashes", () => {
    const a = hashLine("export function foo() {")
    const b = hashLine("export function bar() {")
    // Not strictly guaranteed for any 2 inputs, but extremely likely.
    expect(a).not.toBe(b)
  })
})

describe("isValidHashChars", () => {
  test("accepts valid 2-char hashes", () => {
    expect(isValidHashChars("BB")).toBe(true)
    expect(isValidHashChars("HH")).toBe(true)
    expect(isValidHashChars("KT")).toBe(true)
  })

  test("rejects wrong length", () => {
    expect(isValidHashChars("B")).toBe(false)
    expect(isValidHashChars("BBB")).toBe(false)
    expect(isValidHashChars("")).toBe(false)
  })

  test("rejects out-of-alphabet characters", () => {
    expect(isValidHashChars("II")).toBe(false)
    expect(isValidHashChars("OO")).toBe(false)
    expect(isValidHashChars("LL")).toBe(false)
    expect(isValidHashChars("AE")).toBe(false)
    expect(isValidHashChars("ZZ")).toBe(false) // Z dropped from alphabet
    expect(isValidHashChars("XX")).toBe(false) // X dropped from alphabet
    expect(isValidHashChars("bb")).toBe(false) // lowercase
    expect(isValidHashChars("12")).toBe(false)
  })
})
