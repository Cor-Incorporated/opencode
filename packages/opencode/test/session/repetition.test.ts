import { describe, test, expect } from "bun:test"
import { detectRepetition } from "../../src/session/repetition"
import { REPETITION_THRESHOLD, REPETITION_WINDOW } from "../../src/session/repetition"

describe("session.detectRepetition", () => {
  test("no repetition returns false", () => {
    // Use diverse characters so no 4-200 char pattern repeats 50+ times at the tail
    let text = ""
    for (let i = 0; i < 8100; i++) {
      text += String.fromCharCode(65 + (i % 26)) + String(i % 10)
    }
    expect(text.length).toBeGreaterThanOrEqual(REPETITION_WINDOW)
    expect(detectRepetition(text)).toBe(false)
  })

  test("short text (< 8000 chars) returns false regardless of content", () => {
    const shortRepeated = "abcd".repeat(100)
    expect(shortRepeated.length).toBeLessThan(REPETITION_WINDOW)
    expect(detectRepetition(shortRepeated)).toBe(false)
  })

  test("50+ repetitions of a pattern returns true", () => {
    const pattern = "loop"
    const repeated = pattern.repeat(REPETITION_THRESHOLD + 10)
    const prefix = "x".repeat(REPETITION_WINDOW - repeated.length + 100)
    const text = prefix + repeated
    expect(text.length).toBeGreaterThanOrEqual(REPETITION_WINDOW)
    expect(detectRepetition(text)).toBe(true)
  })

  test("normal text with some repetition (< 50) returns false", () => {
    const pattern = "test"
    const repeated = pattern.repeat(30)
    const filler = "unique content that does not repeat at all here ".repeat(200)
    const text = filler + repeated
    expect(text.length).toBeGreaterThanOrEqual(REPETITION_WINDOW)
    expect(detectRepetition(text)).toBe(false)
  })

  test("repetition exactly at threshold boundary returns true", () => {
    const pattern = "abcd"
    const repeated = pattern.repeat(REPETITION_THRESHOLD)
    const prefix = "z".repeat(REPETITION_WINDOW)
    const text = prefix + repeated
    expect(detectRepetition(text)).toBe(true)
  })

  test("repetition just below threshold returns false", () => {
    const pattern = "abcd"
    const repeated = pattern.repeat(REPETITION_THRESHOLD - 1)
    let diverse = ""
    for (let i = 0; i < 10000; i++) {
      diverse += String.fromCharCode(48 + (i % 75))
    }
    const text = diverse + "XXXX" + repeated
    expect(text.length).toBeGreaterThanOrEqual(REPETITION_WINDOW)
    expect(detectRepetition(text)).toBe(false)
  })

  test("100-char pattern repeated 50+ times is detected", () => {
    const pattern = "a".repeat(50) + "b".repeat(50)
    const repeated = pattern.repeat(REPETITION_THRESHOLD + 5)
    const prefix = "c".repeat(REPETITION_WINDOW)
    const text = prefix + repeated
    expect(detectRepetition(text)).toBe(true)
  })

  test("varied content that happens to end with short repetition is not falsely detected", () => {
    const ending = "abcd".repeat(10)
    let diverse = ""
    for (let i = 0; i < 10000; i++) {
      diverse += String.fromCharCode(65 + (i % 26))
    }
    const text = diverse + ending
    expect(text.length).toBeGreaterThanOrEqual(REPETITION_WINDOW)
    expect(detectRepetition(text)).toBe(false)
  })
})
