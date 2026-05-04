/**
 * `lsp_diagnostics` tool: pulls live diagnostics for a file from the
 * appropriate language server.
 */

import path from "node:path"

import { tool, type ToolDefinition } from "../../../tool.js"

import { LspClient, type LspClientOptions } from "./client.js"
import { specForFile } from "./server-registry.js"
import type { Diagnostic, DiagnosticReport, DiagnosticSeverityValue } from "./types.js"
import { DiagnosticSeverity } from "./types.js"

export interface DiagnosticsResult {
  ok: boolean
  filePath?: string
  diagnostics?: DiagnosticReport[]
  error?: string
}

const SEVERITY_LABEL: Record<DiagnosticSeverityValue, DiagnosticReport["severity"]> = {
  [DiagnosticSeverity.Error]: "error",
  [DiagnosticSeverity.Warning]: "warning",
  [DiagnosticSeverity.Information]: "information",
  [DiagnosticSeverity.Hint]: "hint",
}

function toReport(d: Diagnostic): DiagnosticReport {
  const severity: DiagnosticReport["severity"] = d.severity ? (SEVERITY_LABEL[d.severity] ?? "unknown") : "unknown"
  return {
    severity,
    line: d.range.start.line,
    column: d.range.start.character,
    endLine: d.range.end.line,
    endColumn: d.range.end.character,
    message: d.message,
    source: d.source,
    code: d.code,
  }
}

export async function runDiagnostics(filePath: string, options: LspClientOptions = {}): Promise<DiagnosticsResult> {
  const spec = specForFile(filePath)
  if (!spec) {
    return { ok: false, error: `No LSP server registered for ${path.extname(filePath) || "(no extension)"}` }
  }
  try {
    const client = await LspClient.forFile(filePath, options)
    const diagnostics = await client.diagnostics(filePath)
    return { ok: true, filePath, diagnostics: diagnostics.map(toReport) }
  } catch (err) {
    return { ok: false, error: friendlyError(err, spec.installHint) }
  }
}

function friendlyError(err: unknown, installHint: string): string {
  const msg = err instanceof Error ? err.message : String(err)
  if (/ENOENT|not found|spawn .* ENOENT/i.test(msg)) return installHint
  return msg
}

export const lspDiagnosticsTool: ToolDefinition = tool({
  description:
    "Pull live diagnostics (errors, warnings, hints) for a file from the language server. " +
    "Caches the LSP client per workspace+language and returns a structured report.",
  args: {
    filePath: tool.schema.string().describe("Absolute path to the file to diagnose"),
  },
  async execute({ filePath }) {
    const result = await runDiagnostics(filePath)
    return {
      output: JSON.stringify(result, null, 2),
      metadata: { ok: result.ok, count: result.diagnostics?.length ?? 0 },
    }
  },
})
