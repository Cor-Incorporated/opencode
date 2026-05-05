/**
 * Types for the ast-grep CLI wrapper and tools.
 *
 * Modeled against the public ast-grep CLI documentation:
 * https://ast-grep.github.io/reference/cli/run.html
 */

export type AstGrepLang = "ts" | "tsx" | "js" | "jsx" | "py" | "go" | "rs" | "java" | "cpp"

export const SUPPORTED_LANGS: readonly AstGrepLang[] = ["ts", "tsx", "js", "jsx", "py", "go", "rs", "java", "cpp"]

export interface SearchOpts {
  pattern: string
  lang: AstGrepLang
  paths?: string[]
  globs?: string[]
  context?: number
}

export interface SearchResult {
  file: string
  line: number
  column: number
  matchedText: string
  contextBefore?: string[]
  contextAfter?: string[]
  metavars?: Record<string, string>
}

export interface ReplaceOpts extends SearchOpts {
  rewrite: string
  dryRun?: boolean
}

export interface ReplaceSample {
  file: string
  line: number
  before: string
  after: string
}

export interface ReplaceResult {
  filesChanged: number
  totalEdits: number
  sample: ReplaceSample[]
}
