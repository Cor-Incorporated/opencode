import { describe, test, expect } from "bun:test"
import { stripThinkTags } from "../../src/util/format"

describe("util.format.stripThinkTags", () => {
  test("strips <think>...</think> tags and returns reasoning and content", () => {
    const input = "<think>This is reasoning</think>This is the response"
    const result = stripThinkTags(input)
    expect(result.reasoning).toBe("This is reasoning")
    expect(result.content).toBe("This is the response")
  })

  test("strips <thinking>...</thinking> tags", () => {
    const input = "<thinking>Deep thought</thinking>Final answer"
    const result = stripThinkTags(input)
    expect(result.reasoning).toBe("Deep thought")
    expect(result.content).toBe("Final answer")
  })

  test("handles unclosed <think> tags (truncated stream)", () => {
    const input = "Before <think>partial reasoning without closing tag"
    const result = stripThinkTags(input)
    expect(result.content).toBe("Before ")
    expect(result.reasoning).toBe("")
  })

  test("no tags returns content unchanged and reasoning empty", () => {
    const input = "Just plain content with no special tags"
    const result = stripThinkTags(input)
    expect(result.content).toBe("Just plain content with no special tags")
    expect(result.reasoning).toBe("")
  })

  test("multiple thinking blocks concatenates all reasoning", () => {
    const input = "<think>First thought</think>Middle text<think>Second thought</think>End text"
    const result = stripThinkTags(input)
    expect(result.reasoning).toBe("First thought\nSecond thought")
    expect(result.content).toBe("Middle textEnd text")
  })

  test("handles empty think tags", () => {
    const input = "<think></think>Content after empty think"
    const result = stripThinkTags(input)
    expect(result.reasoning).toBe("")
    expect(result.content).toBe("Content after empty think")
  })

  test("handles multiline reasoning content", () => {
    const input = "<think>\nLine 1\nLine 2\nLine 3\n</think>Response"
    const result = stripThinkTags(input)
    expect(result.reasoning).toBe("Line 1\nLine 2\nLine 3")
    expect(result.content).toBe("Response")
  })

  test("handles mixed think and thinking tags", () => {
    const input = "<think>First</think>Middle<thinking>Second</thinking>End"
    const result = stripThinkTags(input)
    expect(result.reasoning).toBe("First\nSecond")
    expect(result.content).toBe("MiddleEnd")
  })

  test("unclosed thinking tag at end", () => {
    const input = "Content<thinking>reasoning that never closes"
    const result = stripThinkTags(input)
    expect(result.content).toBe("Content")
    expect(result.reasoning).toBe("")
  })
})
