/**
 * Workspace tools: LSP and ast-grep integrations.
 *
 * Re-exports every tool definition plus a {@link workspaceTools} helper
 * that returns the full registration map ready to drop into
 * `Hooks.tool` from a Plugin function.
 */

import type { ToolDefinition } from "../../tool.js"

import { astGrepReplaceTool } from "./astgrep/replace.js"
import { astGrepSearchTool } from "./astgrep/search.js"
import { lspDiagnosticsTool } from "./lsp/diagnostics.js"
import { lspGoToDefinitionTool } from "./lsp/definition.js"
import { lspFindReferencesTool } from "./lsp/references.js"
import { lspRenameTool } from "./lsp/rename.js"

export {
  astGrepReplaceTool,
  astGrepSearchTool,
  lspDiagnosticsTool,
  lspGoToDefinitionTool,
  lspFindReferencesTool,
  lspRenameTool,
}

export * from "./lsp/types.js"
export * from "./astgrep/types.js"
export { LspClient, findRoot, pathToUri, uriToPath } from "./lsp/client.js"
export type { LspClientOptions, RpcConnection, ConnectionFactory } from "./lsp/client.js"
export { AstGrepCli, isSupportedLang } from "./astgrep/cli.js"
export type { AstGrepCliOptions, SpawnFn, SpawnedProcess } from "./astgrep/cli.js"
export { specForFile, listExtensions } from "./lsp/server-registry.js"
export type { LspServerSpec } from "./lsp/server-registry.js"

/**
 * The full set of workspace tools, keyed by their tool ID.
 *
 * Usage from a Plugin:
 *
 * ```ts
 * import type { Plugin } from "@opencode-ai/plugin"
 * import { workspaceTools } from "@opencode-ai/plugin/tools/workspace"
 *
 * const MyPlugin: Plugin = async () => ({ tool: { ...workspaceTools() } })
 * ```
 */
export function workspaceTools(): Record<string, ToolDefinition> {
  return {
    lsp_diagnostics: lspDiagnosticsTool,
    lsp_goto_definition: lspGoToDefinitionTool,
    lsp_find_references: lspFindReferencesTool,
    lsp_rename: lspRenameTool,
    ast_grep_search: astGrepSearchTool,
    ast_grep_replace: astGrepReplaceTool,
  }
}
