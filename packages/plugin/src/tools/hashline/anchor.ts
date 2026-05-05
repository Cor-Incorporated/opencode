/**
 * Clean-room implementation. Functional spec inspired by the public README of
 * oh-my-openagent (SUL-1.0). Implementation, constants (alphabet, separator),
 * and structure are independently chosen. MIT-licensed under
 * Cor-Incorporated/opencode.
 *
 * Anchor format helpers.
 *
 * An anchor is the string form `<line>#<hash>`, where `<line>` is a
 * 1-based decimal line number and `<hash>` is the 2-character content
 * hash produced by `./hash`.
 *
 * Format examples:
 *   "1#BB"
 *   "42#KT"
 *
 * The `annotateLines` helper renders one annotated line as
 * `<anchor><RS><content>` where `<RS>` is the ASCII Record Separator
 * (U+001E). RS was chosen over `|`/`:` because it cannot appear in any
 * legitimate file path, source-code token, or shell-quoted string,
 * eliminating ambiguity when the annotated form is parsed downstream.
 */

import type { Anchor } from "./types.js"
import { HASH_ALPHABET, HASH_LENGTH, hashLine } from "./hash.js"

/**
 * Separator used between anchor and content in `annotateLines` output.
 * ASCII Record Separator (U+001E). Independently chosen — see the file
 * header for the rationale (path/code-safe control character).
 */
export const ANCHOR_CONTENT_SEPARATOR = ""

/**
 * Strict regex for a valid anchor:
 *   - line: positive integer with no leading zero
 *   - separator: literal '#'
 *   - hash: exactly two characters from HASH_ALPHABET
 */
export const ANCHOR_REGEX = new RegExp(`^([1-9][0-9]*)#([${HASH_ALPHABET}]{${HASH_LENGTH}})$`)

/**
 * Parse an anchor string into its components.
 *
 * Returns `null` for malformed input (callers should produce a clear
 * user-facing error). This function never throws.
 */
export function parseAnchor(value: string): Anchor | null {
  if (typeof value !== "string") return null
  const match = ANCHOR_REGEX.exec(value)
  if (!match) return null
  const line = Number.parseInt(match[1]!, 10)
  if (!Number.isFinite(line) || line < 1) return null
  return { line, hash: match[2]! }
}

/**
 * Render an anchor for a given line number and the line's content.
 * The hash is computed from `lineContent` (without trailing newline).
 */
export function formatAnchor(lineNumber: number, lineContent: string): string {
  if (!Number.isInteger(lineNumber) || lineNumber < 1) {
    throw new Error(`formatAnchor: line number must be a positive integer, got ${lineNumber}`)
  }
  return `${lineNumber}#${hashLine(lineContent)}`
}

/**
 * Annotate an array of file lines with their anchors.
 * Each output line has the form `LINE#ID<RS>content` where `<RS>` is
 * `ANCHOR_CONTENT_SEPARATOR` (U+001E).
 */
export function annotateLines(lines: string[]): string[] {
  return lines.map((content, i) => `${formatAnchor(i + 1, content)}${ANCHOR_CONTENT_SEPARATOR}${content}`)
}
