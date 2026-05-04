/**
 * `lsp_goto_definition` tool: returns the definition site(s) for the
 * symbol at a given position.
 */

import path from "node:path"

import { tool, type ToolDefinition } from "../../../tool.js"

import { LspClient, uriToPath, type LspClientOptions } from "./client.js"
import { specForFile } from "./server-registry.js"
import type { LocationReport } from "./types.js"

export interface DefinitionResult {
  ok: boolean
  locations?: LocationReport[]
  error?: string
}

export async function runGoToDefinition(
  filePath: string,
  line: number,
  column: number,
  options: LspClientOptions = {},
): Promise<DefinitionResult> {
  const spec = specForFile(filePath)
  if (!spec) {
    return { ok: false, error: `No LSP server registered for ${path.extname(filePath) || "(no extension)"}` }
  }
  try {
    const client = await LspClient.forFile(filePath, options)
    const result = await client.definition(filePath, line, column)
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

export const lspGoToDefinitionTool: ToolDefinition = tool({
  description: "Resolve the definition site(s) for the symbol at the given (line, column) position via LSP.",
  args: {
    filePath: tool.schema.string().describe("Absolute path to the file containing the symbol"),
    line: tool.schema.number().int().nonnegative().describe("Zero-based line number"),
    column: tool.schema.number().int().nonnegative().describe("Zero-based column number"),
  },
  async execute({ filePath, line, column }) {
    const result = await runGoToDefinition(filePath, line, column)
    return {
      output: JSON.stringify(result, null, 2),
      metadata: { ok: result.ok, count: result.locations?.length ?? 0 },
    }
  },
})
