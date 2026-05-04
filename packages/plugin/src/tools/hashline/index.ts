/**
 * Hashline edit tool — clean-room implementation.
 *
 * Functional spec inspired by oh-my-openagent (SUL-1.0). All code in
 * this directory is original and MIT-licensed under the
 * Cor-Incorporated/opencode fork.
 *
 * Usage in a plugin:
 *
 *   import { createHashlineTool } from "@opencode-ai/plugin/tools/hashline"
 *   const myPlugin: Plugin = async () => ({
 *     tool: { hashline_edit: createHashlineTool() },
 *   })
 */

import { tool, type ToolDefinition } from "../../tool.js"
import { annotateLines } from "./anchor.js"
import { executeHashlineEdits } from "./edit.js"
import type { HashlineEdit, HashlineToolArgs } from "./types.js"

export { hashLine, HASH_ALPHABET, HASH_LENGTH, isValidHashChars } from "./hash.js"
export { ANCHOR_REGEX, parseAnchor, formatAnchor, annotateLines } from "./anchor.js"
export { executeHashlineEdits, resolveFilePath } from "./edit.js"
export type {
  Anchor,
  HashlineEdit,
  HashlineToolArgs,
  HashlineResult,
  HashlineSuccess,
  HashlineFailure,
  ReplaceEdit,
  AppendEdit,
  PrependEdit,
  DeleteEdit,
} from "./types.js"

const TOOL_DESCRIPTION =
  "Edit a file using content-hash anchors (LINE#ID) instead of raw line numbers. " +
  "Use this when you need to make multiple precise edits to a file that other tools may have modified " +
  "since you last read it. The tool re-reads the file at edit time and rejects any edit whose anchor " +
  "hash no longer matches the line content, preventing stale-line errors."

const editArgsSchema = tool.schema.discriminatedUnion("op", [
  tool.schema.object({
    op: tool.schema.literal("replace"),
    pos: tool.schema.string().describe("Anchor of the first line to replace, e.g. '42#KT'."),
    end: tool.schema
      .string()
      .optional()
      .describe("Anchor of the last line of the inclusive range. Omit to replace a single line."),
    lines: tool.schema.array(tool.schema.string()).describe("Replacement lines, without trailing newlines."),
  }),
  tool.schema.object({
    op: tool.schema.literal("append"),
    pos: tool.schema.string().describe("Anchor of the line AFTER which the new lines are inserted."),
    lines: tool.schema.array(tool.schema.string()).describe("Lines to insert, without trailing newlines."),
  }),
  tool.schema.object({
    op: tool.schema.literal("prepend"),
    pos: tool.schema.string().describe("Anchor of the line BEFORE which the new lines are inserted."),
    lines: tool.schema.array(tool.schema.string()).describe("Lines to insert, without trailing newlines."),
  }),
  tool.schema.object({
    op: tool.schema.literal("delete"),
    pos: tool.schema.string().describe("Anchor of the first line to delete."),
    end: tool.schema
      .string()
      .optional()
      .describe("Anchor of the last line of the inclusive range. Omit to delete a single line."),
  }),
])

const argsSchema = {
  filePath: tool.schema.string().describe("Path to the file to edit (absolute or relative to the project)."),
  edits: tool.schema
    .array(editArgsSchema)
    .describe("List of edit operations. All anchors refer to the file BEFORE any edit in this batch is applied."),
  rename: tool.schema
    .string()
    .optional()
    .describe("If set, rename the file to this path after applying edits."),
  createIfMissing: tool.schema
    .boolean()
    .optional()
    .describe(
      "If true, allow creating a new file. Only valid when the file does not exist and edits is either empty " +
        "(creates an empty file) or a single replace from the anchor of an empty line at line 1 " +
        "(use formatAnchor(1, '') to compute it; with the default alphabet this is '1#ZR').",
    ),
}

/**
 * Build a hashline_edit tool definition suitable for plugging into a
 * plugin's `tool` map. The returned object follows the runtime's
 * existing tool schema convention (see `packages/plugin/src/tool.ts`).
 */
export function createHashlineTool(): ToolDefinition {
  return tool({
    description: TOOL_DESCRIPTION,
    args: argsSchema,
    async execute(args, ctx) {
      const baseDir = ctx.directory ?? ctx.worktree
      const result = await executeHashlineEdits(args as HashlineToolArgs, baseDir)
      if (result.ok) {
        return { output: result.summary }
      }
      return { output: result.error }
    },
  })
}

/**
 * Convenience helper for an agent's "show me the file with anchors"
 * read flow. Reads the file (if it exists) and returns each line in
 * `LINE#ID|content` form. Returns null if the file is missing.
 */
export async function readWithAnchors(absPath: string): Promise<string[] | null> {
  const file = Bun.file(absPath)
  if (!(await file.exists())) return null
  const text = await file.text()
  if (text.length === 0) return []
  const trimmed = text.endsWith("\n") ? text.slice(0, -1) : text
  return annotateLines(trimmed.split("\n"))
}

/**
 * Re-export the edit type so external callers can build typed batches.
 */
export type { HashlineEdit as Edit }
