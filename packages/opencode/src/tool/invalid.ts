import { Effect, Schema } from "effect"
import * as Tool from "./tool"

const MAX_ERROR_CHARS = 4000
const MAX_INPUT_CHARS = 2400
const MAX_PREVIEW_LINES = 80
const TEXT_MARKER = "Text: "
const ERROR_MARKER = "\nError message:"

export const Parameters = Schema.Struct({
  tool: Schema.String,
  error: Schema.String,
})

function compactNoise(text: string) {
  return text
    .replace(/(?:\\[tnr]){80,}/g, (match) => {
      const head = Array.from(match).slice(0, 80).join("")
      return `${head}[${Array.from(match).length - Array.from(head).length} escaped whitespace characters omitted]`
    })
    .replace(/[\t\r\n]{80,}/g, (match) => {
      const head = Array.from(match).slice(0, 80).join("")
      return `${head}[${Array.from(match).length - Array.from(head).length} whitespace characters omitted]`
    })
}

function preview(text: string, limit: number) {
  const compacted = compactNoise(text)
  const chars = Array.from(compacted)
  const head = chars.length > limit ? chars.slice(0, limit).join("") : compacted
  const lines = head.split("\n")
  const value = (lines.length > MAX_PREVIEW_LINES ? lines.slice(0, MAX_PREVIEW_LINES).join("\n") : head).trimEnd()
  return {
    value,
    omitted: Array.from(text).length - Array.from(value).length,
  }
}

export function formatInvalidToolError(error: string) {
  const normalized = error.replaceAll("\r\n", "\n")
  const inputStart = normalized.indexOf(TEXT_MARKER)
  if (inputStart === -1) {
    const summary = preview(normalized, MAX_ERROR_CHARS)
    if (!summary.omitted) return summary.value
    return `${summary.value}\n\n[invalid tool error truncated: ${summary.omitted} characters omitted]`
  }

  const rest = normalized.slice(inputStart + TEXT_MARKER.length)
  const errorStart = rest.lastIndexOf(ERROR_MARKER)
  const input = errorStart === -1 ? rest : rest.slice(0, errorStart)
  const tail = errorStart === -1 ? "" : rest.slice(errorStart).trim()
  const summary = preview(input, MAX_INPUT_CHARS)
  return [
    normalized.slice(0, inputStart).trimEnd(),
    "Tool input preview:",
    summary.value,
    summary.omitted ? `[invalid tool input truncated: ${summary.omitted} characters omitted]` : "",
    tail,
  ]
    .filter(Boolean)
    .join("\n")
}

export const InvalidTool = Tool.define(
  "invalid",
  Effect.succeed({
    description: "Do not use",
    parameters: Parameters,
    execute: (params: { tool: string; error: string }) =>
      Effect.succeed({
        title: "Invalid Tool",
        output: `The arguments provided to the tool are invalid:\n${formatInvalidToolError(params.error)}`,
        metadata: {},
      }),
  }),
)
