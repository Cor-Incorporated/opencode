/**
 * `lsp_find_references` tool: returns every reference site for the
 * symbol at a given position.
 */

import path from "node:path"

import { tool, type ToolDefinition } from "../../../tool.js"

import { LspClient, uriToPath, type LspClientOptions } from "./client.js"
import { specForFile } from "./server-registry.js"
import type { LocationReport } from "./types.js"

export interface ReferencesResult {
  ok: boolean
  locations?: LocationReport[]
  error?: string
}

export async function runFindReferences(
  filePath: string,
  line: number,
  column: number,
  includeDeclaration: boolean,
  options: LspClientOptions = {},
): Promise<ReferencesResult> {
  const spec = specForFile(filePath)
  if (!spec) {
    return { ok: false, error: `No LSP server registered for ${path.extname(filePath) || "(no extension)"}` }
  }
  try {
    const client = await LspClient.forFile(filePath, options)
    const result = await client.references(filePath, line, column, includeDeclaration)
    return {
      ok: true,
      locations: result.map((loc) => ({ uri: loc.uri, filePath: uriToPath(loc.uri), range: loc.range })),
    }
  } catch (err) {
    return { ok: false, error: friendlyError(err, spec.installHint) }
  }
}

function friendlyError(err: unknown, installHint: string): string {
  const msg = err instanceof Error ? err.message : String(err)
  if (/ENOENT|not found|spawn .* ENOENT/i.test(msg)) return installHint
  return msg
}

export const lspFindReferencesTool: ToolDefinition = tool({
  description: "Find every reference to the symbol at the given (line, column) via LSP.",
  args: {
    filePath: tool.schema.string().describe("Absolute path to the file containing the symbol"),
    line: tool.schema.number().int().nonnegative().describe("Zero-based line number"),
    column: tool.schema.number().int().nonnegative().describe("Zero-based column number"),
    includeDeclaration: tool.schema
      .boolean()
      .optional()
      .describe("Include the declaration site itself in the result (default true)"),
  },
  async execute({ filePath, line, column, includeDeclaration }) {
    const result = await runFindReferences(filePath, line, column, includeDeclaration ?? true)
    return {
      output: JSON.stringify(result, null, 2),
      metadata: { ok: result.ok, count: result.locations?.length ?? 0 },
    }
  },
})
