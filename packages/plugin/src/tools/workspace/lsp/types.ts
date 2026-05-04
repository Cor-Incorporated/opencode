/**
 * Minimal LSP message types.
 *
 * Sourced from the public Language Server Protocol Specification 3.17:
 * https://microsoft.github.io/language-server-protocol/specifications/lsp/3.17/specification/
 *
 * Only the subset required by the workspace tools is modeled here.
 */

export type DocumentUri = string

export interface Position {
  /** Zero-based line number. */
  line: number
  /** Zero-based UTF-16 character offset within the line. */
  character: number
}

export interface Range {
  start: Position
  end: Position
}

export interface Location {
  uri: DocumentUri
  range: Range
}

export const DiagnosticSeverity = {
  Error: 1,
  Warning: 2,
  Information: 3,
  Hint: 4,
} as const

export type DiagnosticSeverityValue = (typeof DiagnosticSeverity)[keyof typeof DiagnosticSeverity]

export interface Diagnostic {
  range: Range
  severity?: DiagnosticSeverityValue
  code?: string | number
  source?: string
  message: string
}

export interface TextEdit {
  range: Range
  newText: string
}

export interface TextDocumentEdit {
  textDocument: {
    uri: DocumentUri
    version: number | null
  }
  edits: TextEdit[]
}

export interface WorkspaceEdit {
  /** Map of URI -> TextEdit[]. */
  changes?: Record<DocumentUri, TextEdit[]>
  /** Newer documentChanges form (preferred when servers send it). */
  documentChanges?: TextDocumentEdit[]
}

export interface PublishDiagnosticsParams {
  uri: DocumentUri
  version?: number
  diagnostics: Diagnostic[]
}

export interface InitializeResult {
  capabilities: Record<string, unknown>
  serverInfo?: { name: string; version?: string }
}

export interface ReferenceContext {
  includeDeclaration: boolean
}

/** Friendly diagnostic returned by the diagnostics tool. */
export interface DiagnosticReport {
  severity: "error" | "warning" | "information" | "hint" | "unknown"
  line: number
  column: number
  endLine: number
  endColumn: number
  message: string
  source?: string
  code?: string | number
}

/** Friendly Location returned by definition / references tools. */
export interface LocationReport {
  uri: DocumentUri
  filePath: string
  range: Range
}

/** Friendly rename result. */
export interface RenameSummary {
  filesAffected: number
  totalEdits: number
  applied: boolean
  edits: Array<{
    uri: DocumentUri
    filePath: string
    edits: TextEdit[]
  }>
}
