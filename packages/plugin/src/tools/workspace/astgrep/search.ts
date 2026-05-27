/**
 * `ast_grep_search` tool: structural pattern search using ast-grep.
 */

import { tool, type ToolDefinition } from "../../../tool.js"

import { AstGrepCli, isSupportedLang, type AstGrepCliOptions } from "./cli.js"
import { SUPPORTED_LANGS, type SearchOpts, type SearchResult } from "./types.js"

export interface SearchToolResult {
  ok: boolean
  total?: number
  truncated?: boolean
  results?: SearchResult[]
  error?: string
}

export async function runAstGrepSearch(
  opts: SearchOpts,
  cliOptions: AstGrepCliOptions = {},
): Promise<SearchToolResult> {
  if (!isSupportedLang(opts.lang)) {
    return { ok: false, error: `Unsupported language: ${opts.lang}. Supported: ${SUPPORTED_LANGS.join(", ")}` }
  }
  try {
    const cli = new AstGrepCli(cliOptions)
    const { results, total, truncated } = await cli.search(opts)
    return { ok: true, total, truncated, results }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

export const astGrepSearchTool: ToolDefinition = tool({
  description:
    "Search files by syntax-tree pattern using ast-grep. " +
    "Patterns may use $VAR (single capture) and $$$ (multi capture) metavariables. " +
    "Returns up to the first 200 matches plus a `total` count.",
  args: {
    pattern: tool.schema.string().min(1).describe("ast-grep pattern (e.g. `console.log($MSG)`)"),
    lang: tool.schema
      .enum(["ts", "tsx", "js", "jsx", "py", "go", "rs", "java", "cpp"])
      .describe("Source language for the pattern"),
    paths: tool.schema.array(tool.schema.string()).optional().describe("Search roots (default: current directory)"),
    globs: tool.schema.array(tool.schema.string()).optional().describe("File globs to filter the search"),
    context: tool.schema.number().int().nonnegative().optional().describe("Lines of context before/after each match"),
  },
  async execute(args, ctx) {
    const result = await runAstGrepSearch(args, { cwd: ctx.directory })
    return {
      output: JSON.stringify(result, null, 2),
      metadata: {
        ok: result.ok,
        total: result.total ?? 0,
        truncated: result.truncated ?? false,
      },
    }
  },
})
