/**
 * `ast_grep_replace` tool: structural pattern rewrite using ast-grep.
 */

import { tool, type ToolDefinition } from "../../../tool.js"

import { AstGrepCli, isSupportedLang, type AstGrepCliOptions } from "./cli.js"
import { SUPPORTED_LANGS, type ReplaceOpts, type ReplaceResult } from "./types.js"

export interface ReplaceToolResult {
  ok: boolean
  result?: ReplaceResult
  dryRun?: boolean
  error?: string
}

export async function runAstGrepReplace(
  opts: ReplaceOpts,
  cliOptions: AstGrepCliOptions = {},
): Promise<ReplaceToolResult> {
  if (!isSupportedLang(opts.lang)) {
    return { ok: false, error: `Unsupported language: ${opts.lang}. Supported: ${SUPPORTED_LANGS.join(", ")}` }
  }
  try {
    const cli = new AstGrepCli(cliOptions)
    const result = await cli.replace(opts)
    return { ok: true, dryRun: opts.dryRun ?? false, result }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

export const astGrepReplaceTool: ToolDefinition = tool({
  description:
    "Rewrite syntactic matches across the codebase using ast-grep. " +
    "Patterns may use $VAR / $$$ metavariables; the rewrite template can reference them. " +
    "Defaults to dryRun=true (preview only); pass dryRun=false to apply.",
  args: {
    pattern: tool.schema.string().min(1).describe("ast-grep pattern to match"),
    rewrite: tool.schema.string().describe("Replacement template; may reference metavariables"),
    lang: tool.schema
      .enum(["ts", "tsx", "js", "jsx", "py", "go", "rs", "java", "cpp"])
      .describe("Source language"),
    paths: tool.schema.array(tool.schema.string()).optional().describe("Search roots (default: current directory)"),
    globs: tool.schema.array(tool.schema.string()).optional().describe("File globs to filter"),
    context: tool.schema.number().int().nonnegative().optional().describe("Lines of context for sample output"),
    dryRun: tool.schema
      .boolean()
      .optional()
      .describe("If true (default), do not modify files; just return the planned edits"),
  },
  async execute(args) {
    // Default to dryRun=true so a destructive structural rewrite never
    // happens implicitly. Callers must opt in to writing files.
    const dryRun = args.dryRun ?? true
    const result = await runAstGrepReplace({ ...args, dryRun })
    return {
      output: JSON.stringify(result, null, 2),
      metadata: {
        ok: result.ok,
        dryRun: result.dryRun ?? false,
        filesChanged: result.result?.filesChanged ?? 0,
        totalEdits: result.result?.totalEdits ?? 0,
      },
    }
  },
})
