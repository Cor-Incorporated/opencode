/**
 * Atomic, hash-validated edit engine for the hashline tool.
 *
 * The flow for every call:
 *   1. Read the file from disk (or treat as empty if `createIfMissing`).
 *   2. For every anchor in every edit, recompute the line hash and
 *      reject the entire batch on any mismatch.
 *   3. Apply edits in reverse-line order so earlier-line edits do not
 *      shift later-line numbers — every anchor in the batch refers to
 *      the file as it was BEFORE any edit applied.
 *   4. Write the result atomically (temp file + rename, or fall back
 *      to `Bun.write` if rename is unavailable).
 *
 * Errors are returned as values; the only thrown exceptions are for
 * genuine programmer errors (bad arg shapes).
 */

import { rename, mkdir } from "node:fs/promises"
import { dirname, isAbsolute, resolve } from "node:path"

import { hashLine } from "./hash.js"
import { parseAnchor } from "./anchor.js"
import type { Anchor, HashlineEdit, HashlineResult, HashlineToolArgs } from "./types.js"

const NEWLINE = "\n"

type ResolvedEdit =
  | { op: "replace"; start: number; end: number; lines: string[] }
  | { op: "delete"; start: number; end: number }
  | { op: "append"; pos: number; lines: string[] }
  | { op: "prepend"; pos: number; lines: string[] }

type ResolveOk = { ok: true; resolved: ResolvedEdit }
type ResolveErr = { ok: false; error: string }

/**
 * Split file content into an array of lines.
 *
 * The split preserves intent: a file ending with a trailing newline
 * implies an empty final line which we DROP for editing purposes,
 * so that line counts match the user's mental model. The trailing
 * newline is restored on serialize if the original file had one.
 */
function splitLines(content: string): { lines: string[]; trailingNewline: boolean } {
  if (content.length === 0) return { lines: [], trailingNewline: false }
  const trailingNewline = content.endsWith(NEWLINE)
  const body = trailingNewline ? content.slice(0, -1) : content
  return { lines: body.split(NEWLINE), trailingNewline }
}

/**
 * Inverse of `splitLines`. Joins with '\n' and re-adds a trailing
 * newline iff the original file had one (or always for non-empty
 * newly-created files, to match POSIX conventions).
 */
function joinLines(lines: string[], trailingNewline: boolean): string {
  if (lines.length === 0) return trailingNewline ? NEWLINE : ""
  return lines.join(NEWLINE) + (trailingNewline ? NEWLINE : "")
}

/**
 * Validate an anchor against the current file lines.
 * Returns the parsed anchor on success or an error message on mismatch.
 */
function validateAnchor(
  anchorString: string,
  lines: string[],
  filePath: string,
  label: string,
): { ok: true; anchor: Anchor } | { ok: false; error: string } {
  const parsed = parseAnchor(anchorString)
  if (!parsed) {
    return {
      ok: false,
      error: `Malformed anchor ${JSON.stringify(anchorString)} for ${label} — expected format LINE#ID (e.g. 42#KT).`,
    }
  }
  if (parsed.line > lines.length) {
    return {
      ok: false,
      error: `Anchor ${anchorString} for ${filePath}:${parsed.line} — file only has ${lines.length} line(s).`,
    }
  }
  const actualLine = lines[parsed.line - 1]!
  const actualHash = hashLine(actualLine)
  if (actualHash !== parsed.hash) {
    return {
      ok: false,
      error:
        `Stale anchor ${anchorString} for ${filePath}:${parsed.line} — actual content hashes to ${JSON.stringify(actualHash)} ` +
        `(line content: ${JSON.stringify(actualLine)})\nRe-read the file before retrying.`,
    }
  }
  return { ok: true, anchor: parsed }
}

/**
 * Resolve a single edit's anchors into concrete line indices.
 */
function resolveEdit(
  edit: HashlineEdit,
  lines: string[],
  filePath: string,
  index: number,
): ResolveOk | ResolveErr {
  const posLabel = `edits[${index}].pos`
  const posResult = validateAnchor(edit.pos, lines, filePath, posLabel)
  if (!posResult.ok) return { ok: false, error: posResult.error }
  const start = posResult.anchor.line

  switch (edit.op) {
    case "replace": {
      let endLine = start
      if (edit.end !== undefined) {
        const endResult = validateAnchor(edit.end, lines, filePath, `edits[${index}].end`)
        if (!endResult.ok) return { ok: false, error: endResult.error }
        endLine = endResult.anchor.line
        if (endLine < start) {
          return {
            ok: false,
            error: `edits[${index}]: end line ${endLine} is before pos line ${start}.`,
          }
        }
      }
      return { ok: true, resolved: { op: "replace", start, end: endLine, lines: edit.lines } }
    }
    case "delete": {
      let endLine = start
      if (edit.end !== undefined) {
        const endResult = validateAnchor(edit.end, lines, filePath, `edits[${index}].end`)
        if (!endResult.ok) return { ok: false, error: endResult.error }
        endLine = endResult.anchor.line
        if (endLine < start) {
          return {
            ok: false,
            error: `edits[${index}]: end line ${endLine} is before pos line ${start}.`,
          }
        }
      }
      return { ok: true, resolved: { op: "delete", start, end: endLine } }
    }
    case "append":
      return { ok: true, resolved: { op: "append", pos: start, lines: edit.lines } }
    case "prepend":
      return { ok: true, resolved: { op: "prepend", pos: start, lines: edit.lines } }
  }
}

/**
 * Sort key used to apply edits in reverse line order.
 * Within the same starting line, prepend < replace/delete < append so
 * that an append at line N and a replace at line N do not collide.
 */
function editSortKey(edit: ResolvedEdit): [number, number] {
  const start = "start" in edit ? edit.start : edit.pos
  let tier = 1
  if (edit.op === "prepend") tier = 0
  else if (edit.op === "append") tier = 2
  return [start, tier]
}

/**
 * Apply a single resolved edit to a mutable lines buffer.
 * Mutation here is local to the function's owned buffer; the public
 * API still presents an immutable contract.
 */
function applyEdit(buffer: string[], edit: ResolvedEdit): void {
  switch (edit.op) {
    case "replace":
      buffer.splice(edit.start - 1, edit.end - edit.start + 1, ...edit.lines)
      return
    case "delete":
      buffer.splice(edit.start - 1, edit.end - edit.start + 1)
      return
    case "append":
      buffer.splice(edit.pos, 0, ...edit.lines)
      return
    case "prepend":
      buffer.splice(edit.pos - 1, 0, ...edit.lines)
      return
  }
}

/**
 * Resolve a possibly-relative file path against a base directory.
 * Absolute paths are returned as-is.
 */
export function resolveFilePath(filePath: string, baseDir?: string): string {
  if (isAbsolute(filePath)) return filePath
  const base = baseDir ?? process.cwd()
  return resolve(base, filePath)
}

/**
 * Read a file's text content, or return null if it does not exist.
 * Other I/O errors surface as thrown exceptions (caller wraps them).
 */
async function readIfExists(absPath: string): Promise<string | null> {
  const file = Bun.file(absPath)
  if (!(await file.exists())) return null
  return await file.text()
}

/**
 * Atomically write `content` to `absPath` using a sibling temp file
 * plus rename. Falls back to direct write only if rename is impossible
 * (cross-device, etc.). The temp file is cleaned up on rename failure.
 */
async function atomicWrite(absPath: string, content: string): Promise<void> {
  await mkdir(dirname(absPath), { recursive: true })
  const tempPath = `${absPath}.hashline-${process.pid}-${Date.now()}.tmp`
  await Bun.write(tempPath, content)
  try {
    await rename(tempPath, absPath)
  } catch (err) {
    // Best-effort cleanup; don't mask the original error.
    try {
      await Bun.file(tempPath).delete()
    } catch {
      // ignore
    }
    throw err
  }
}

type CreateGuardOk = { ok: true; existed: boolean; original: string | null }
type CreateGuardErr = { ok: false; error: string }

/**
 * Determine whether the create-if-missing path is permitted, and if so
 * return synthesized "original" content for the validation pipeline.
 */
function evaluateCreate(
  edits: HashlineEdit[],
  fileExists: boolean,
  createIfMissing: boolean,
  filePath: string,
): CreateGuardOk | CreateGuardErr {
  if (fileExists) return { ok: true, existed: true, original: null }
  if (!createIfMissing) {
    return {
      ok: false,
      error: `File does not exist: ${filePath}. Pass createIfMissing: true to create it.`,
    }
  }
  if (edits.length === 0) {
    return { ok: true, existed: false, original: "" }
  }
  const emptyLineAnchor = `1#${hashLine("")}`
  if (edits.length !== 1 || edits[0]!.op !== "replace" || edits[0]!.pos !== emptyLineAnchor) {
    return {
      ok: false,
      error:
        `createIfMissing requires either an empty edits array or a single replace from anchor ${JSON.stringify(emptyLineAnchor)} ` +
        `(the hash of an empty line at line 1). Got ${edits.length} edit(s).`,
    }
  }
  // Synthesize a one-line empty file so the empty-line anchor matches.
  return { ok: true, existed: false, original: "" }
}

/**
 * Validate the rename target before performing any writes.
 */
function evaluateRename(rename: string | undefined, baseDir?: string): { absPath: string | null; error?: string } {
  if (rename === undefined) return { absPath: null }
  if (typeof rename !== "string" || rename.trim() === "") {
    return { absPath: null, error: `rename must be a non-empty string` }
  }
  return { absPath: resolveFilePath(rename, baseDir) }
}

/**
 * Apply a batch of validated edits in reverse-line order.
 */
function applyAll(originalLines: string[], resolved: ResolvedEdit[]): string[] {
  const sorted = [...resolved].sort((a, b) => {
    const [ax, at] = editSortKey(a)
    const [bx, bt] = editSortKey(b)
    if (ax !== bx) return bx - ax
    return bt - at
  })
  const buffer = [...originalLines]
  for (const edit of sorted) applyEdit(buffer, edit)
  return buffer
}

type LoadOk = { ok: true; original: string; trailingNewline: boolean; existed: boolean }
type LoadErr = { ok: false; error: string }

/**
 * Validate args and load the current file content (or synthesize for
 * createIfMissing). Pure with respect to the disk state — no writes.
 */
async function loadSource(args: HashlineToolArgs, absSource: string): Promise<LoadOk | LoadErr> {
  try {
    const content = await readIfExists(absSource)
    if (content !== null) {
      return {
        ok: true,
        original: content,
        trailingNewline: content.endsWith(NEWLINE) || content.length === 0,
        existed: true,
      }
    }
    const guard = evaluateCreate(args.edits, false, args.createIfMissing === true, args.filePath)
    if (!guard.ok) return { ok: false, error: guard.error }
    return { ok: true, original: guard.original ?? "", trailingNewline: true, existed: false }
  } catch (err) {
    return { ok: false, error: `Failed to read ${absSource}: ${(err as Error).message}` }
  }
}

/**
 * Resolve every edit's anchors in order, aborting on the first failure
 * so the caller can return atomically without applying anything.
 */
function resolveAll(
  edits: HashlineEdit[],
  lines: string[],
  filePath: string,
): { ok: true; resolved: ResolvedEdit[] } | { ok: false; error: string } {
  const resolved: ResolvedEdit[] = []
  for (let i = 0; i < edits.length; i++) {
    const result = resolveEdit(edits[i]!, lines, filePath, i)
    if (!result.ok) return { ok: false, error: result.error }
    resolved.push(result.resolved)
  }
  return { ok: true, resolved }
}

/**
 * Persist the new content and (if renaming) remove the old path.
 */
async function commit(
  serialized: string,
  absSource: string,
  targetPath: string,
  existed: boolean,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    await atomicWrite(targetPath, serialized)
  } catch (err) {
    return { ok: false, error: `Failed to write ${targetPath}: ${(err as Error).message}` }
  }
  if (targetPath !== absSource && existed) {
    try {
      await Bun.file(absSource).delete()
    } catch (err) {
      return {
        ok: false,
        error: `Wrote ${targetPath} but failed to remove old path ${absSource}: ${(err as Error).message}`,
      }
    }
  }
  return { ok: true }
}

/**
 * Validate the runtime shape of `args`. Throws on programmer errors;
 * never throws for edit-content errors (those return as values).
 */
function assertValidArgs(args: HashlineToolArgs): void {
  if (!args || typeof args !== "object") {
    throw new Error("executeHashlineEdits: args must be an object")
  }
  if (typeof args.filePath !== "string" || args.filePath.length === 0) {
    throw new Error("executeHashlineEdits: filePath is required")
  }
  if (!Array.isArray(args.edits)) {
    throw new Error("executeHashlineEdits: edits must be an array")
  }
}

/**
 * Execute a batch of hashline edits.
 *
 * `baseDir` is typically the session's project directory, used to
 * resolve relative `filePath` / `rename` arguments. When omitted,
 * `process.cwd()` is used.
 */
export async function executeHashlineEdits(args: HashlineToolArgs, baseDir?: string): Promise<HashlineResult> {
  assertValidArgs(args)

  const absSource = resolveFilePath(args.filePath, baseDir)
  const renameInfo = evaluateRename(args.rename, baseDir)
  if (renameInfo.error) return { ok: false, error: renameInfo.error }

  const loaded = await loadSource(args, absSource)
  if (!loaded.ok) return { ok: false, error: loaded.error }

  const split = splitLines(loaded.original)
  // For a newly-created file with edits, replace line 1 of a synthetic
  // single-empty-line buffer so the empty-line anchor matches.
  const lines = !loaded.existed && args.edits.length > 0 ? [""] : split.lines
  const finalTrailing = !loaded.existed ? true : split.trailingNewline

  const resolved = resolveAll(args.edits, lines, args.filePath)
  if (!resolved.ok) return { ok: false, error: resolved.error }

  const next = applyAll(lines, resolved.resolved)
  const serialized = joinLines(next, finalTrailing)
  const targetPath = renameInfo.absPath ?? absSource

  const written = await commit(serialized, absSource, targetPath, loaded.existed)
  if (!written.ok) return { ok: false, error: written.error }

  return {
    ok: true,
    summary: buildSummary({
      targetPath,
      sourcePath: absSource,
      renamed: !!renameInfo.absPath && renameInfo.absPath !== absSource,
      created: !loaded.existed,
      editCount: args.edits.length,
      finalLineCount: next.length,
    }),
  }
}

/**
 * Render a human-readable summary of an applied edit batch.
 */
function buildSummary(input: {
  targetPath: string
  sourcePath: string
  renamed: boolean
  created: boolean
  editCount: number
  finalLineCount: number
}): string {
  const verb = input.created ? "created" : "edited"
  const moveInfo = input.renamed ? ` (renamed from ${input.sourcePath})` : ""
  return `hashline_edit ${verb} ${input.targetPath}${moveInfo}: ${input.editCount} edit(s) applied, file is now ${input.finalLineCount} line(s).`
}
