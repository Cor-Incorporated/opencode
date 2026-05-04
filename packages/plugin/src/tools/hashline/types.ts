/**
 * Clean-room implementation. Functional spec inspired by the public README of
 * oh-my-openagent (SUL-1.0). Implementation, constants (alphabet, separator),
 * and structure are independently chosen. MIT-licensed under
 * Cor-Incorporated/opencode.
 *
 * Type definitions for the hashline edit tool.
 *
 * The hashline tool prevents stale-line edit failures by requiring an
 * agent to encode a short content hash alongside every line reference.
 * The tool re-reads the file at edit time, recomputes the hash, and
 * rejects the edit if any anchor's hash does not match.
 */

/**
 * A parsed anchor referring to a specific line and its content hash.
 */
export type Anchor = {
  /** 1-based line number. */
  line: number
  /** 2-character hash of the line content. */
  hash: string
}

/**
 * Replace lines in the inclusive range `[pos..end]` with `lines`.
 * If `end` is omitted, only the single line at `pos` is replaced.
 */
export type ReplaceEdit = {
  op: "replace"
  pos: string
  end?: string
  lines: string[]
}

/**
 * Insert `lines` AFTER the line referenced by `pos`.
 */
export type AppendEdit = {
  op: "append"
  pos: string
  lines: string[]
}

/**
 * Insert `lines` BEFORE the line referenced by `pos`.
 */
export type PrependEdit = {
  op: "prepend"
  pos: string
  lines: string[]
}

/**
 * Delete the inclusive range `[pos..end]`.
 * If `end` is omitted, only the single line at `pos` is deleted.
 */
export type DeleteEdit = {
  op: "delete"
  pos: string
  end?: string
}

/**
 * Discriminated union of all supported edit operations.
 */
export type HashlineEdit = ReplaceEdit | AppendEdit | PrependEdit | DeleteEdit

/**
 * Tool arguments for a single hashline_edit call.
 */
export type HashlineToolArgs = {
  filePath: string
  edits: HashlineEdit[]
  /** Optional new path; if set the file is renamed (move) before write. */
  rename?: string
  /**
   * If true, allow creating a brand-new file. Only valid when the file
   * does not currently exist and `edits` is either empty (creates an
   * empty file) or a single replace from line 1.
   */
  createIfMissing?: boolean
}

/**
 * Successful result envelope returned from `execute`.
 */
export type HashlineSuccess = {
  ok: true
  summary: string
}

/**
 * Failure result envelope returned from `execute`.
 * Errors are returned as values, never thrown, except for genuine
 * programmer errors (e.g. missing required args).
 */
export type HashlineFailure = {
  ok: false
  error: string
}

export type HashlineResult = HashlineSuccess | HashlineFailure
