/**
 * Clean-room implementation. Functional spec inspired by the public README of
 * oh-my-openagent (SUL-1.0). Implementation, constants (alphabet, separator),
 * and structure are independently chosen. MIT-licensed under
 * Cor-Incorporated/opencode.
 *
 * Atomic, hash-validated edit engine for the hashline tool.
 *
 * The flow for every call:
 *   1. Read the file from disk (or treat as empty if `createIfMissing`).
 *   2. For every anchor in every edit, recompute the line hash and
 *      reject the entire batch on any mismatch.
 *   3. Reject the batch if any two edits target overlapping line ranges
 *      (computed against the ORIGINAL file), since the reverse-line apply
 *      order would otherwise silently corrupt later edits.
 *   4. Apply edits in reverse-line order so earlier-line edits do not
 *      shift later-line numbers — every anchor in the batch refers to
 *      the file as it was BEFORE any edit applied.
 *   5. Write the result atomically (temp file + rename, or fall back
 *      to `Bun.write` if rename is unavailable).
 *
 * Errors are returned as values; programmer-shape errors (missing
 * filePath, edits not an array, etc.) are also surfaced as values via
 * the public `executeHashlineEdits` entry point so callers never have
 * to wrap calls in try/catch for argument-validation failures.
 */

import { randomBytes } from "node:crypto"
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
 * Numeric range an edit "claims" against the ORIGINAL file. Replace and
 * delete claim their inclusive line range. Append/prepend claim a single
 * half-integer point so they don't conflict with replaces/deletes whose
 * range simply touches the same line — but two appends at the same line
 * (or an append + a prepend at the same line) DO collide and must be
 * rejected, since both the order of insertion and the post-apply line
 * numbering would be ambiguous.
 */
function rangeOf(edit: ResolvedEdit): [number, number] {
  if (edit.op === "replace" || edit.op === "delete") return [edit.start, edit.end]
  if (edit.op === "append") return [edit.pos + 0.5, edit.pos + 0.5]
  // prepend
  return [edit.pos - 0.5, edit.pos - 0.5]
}

/**
 * Detect overlapping ranges across a batch of resolved edits. Returns
 * an error message identifying the first conflicting pair, or null when
 * all ranges are disjoint.
 *
 * Algorithm: sort by range start, then walk forward checking that each
 * interval starts strictly after the previous interval's end. Inclusive
 * ranges from replace/delete that share even a single line are rejected.
 */
function detectOverlap(resolved: ResolvedEdit[]): string | null {
  const indexed = resolved.map((edit, originalIndex) => {
    const [lo, hi] = rangeOf(edit)
    return { edit, originalIndex, lo, hi }
  })
  indexed.sort((a, b) => (a.lo === b.lo ? a.hi - b.hi : a.lo - b.lo))
  for (let i = 1; i < indexed.length; i++) {
    const prev = indexed[i - 1]!
    const cur = indexed[i]!
    if (cur.lo <= prev.hi) {
      return (
        `edits[${prev.originalIndex}] (${prev.edit.op} covering lines [${describeRange(prev.lo, prev.hi)}]) ` +
        `overlaps edits[${cur.originalIndex}] (${cur.edit.op} covering lines [${describeRange(cur.lo, cur.hi)}]). ` +
        `All edits in a batch must target disjoint line ranges in the ORIGINAL file.`
      )
    }
  }
  return null
}

/**
 * Render a half-integer range as a user-readable string.
 * E.g. [2, 3] -> "2..3"; [2.5, 2.5] -> "after 2"/"before 3".
 */
function describeRange(lo: number, hi: number): string {
  if (Number.isInteger(lo) && Number.isInteger(hi)) {
    return lo === hi ? String(lo) : `${lo}..${hi}`
  }
  // half-integer point
  const base = Math.floor(lo)
  return lo > base ? `between ${base} and ${base + 1}` : `before ${base + 1}`
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
 *
 * The temp suffix carries 4 random bytes (8 hex chars) on top of pid +
 * timestamp so that two concurrent writers in the same process at the
 * same millisecond don't collide.
 */
async function atomicWrite(absPath: string, content: string): Promise<void> {
  await mkdir(dirname(absPath), { recursive: true })
  const entropy = randomBytes(4).toString("hex")
  const tempPath = `${absPath}.hashline-${process.pid}-${Date.now()}-${entropy}.tmp`
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
 *
 * `renamePath` is named to avoid shadowing the `node:fs/promises#rename`
 * import. Returns the absolute target path (or null when no rename was
 * requested) and an error string when the value is structurally invalid.
 */
function evaluateRename(
  renamePath: string | undefined,
  baseDir?: string,
): { absPath: string | null; error?: string } {
  if (renamePath === undefined) return { absPath: null }
  if (typeof renamePath !== "string" || renamePath.trim() === "") {
    return { absPath: null, error: `rename must be a non-empty string` }
  }
  return { absPath: resolveFilePath(renamePath, baseDir) }
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
 * so the caller can return atomically without applying anything. After
 * resolution succeeds, also reject the batch if any two resolved edits
 * overlap on the ORIGINAL file's line numbers — since edits are applied
 * in reverse-line order, an undetected overlap would silently shift or
 * destroy lines from later edits.
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
  const overlap = detectOverlap(resolved)
  if (overlap) return { ok: false, error: overlap }
  return { ok: true, resolved }
}

/**
 * Persist the new content and (if renaming) remove the old path.
 *
 * Pre-condition: callers must already have ensured `targetPath` does not
 * point at a different existing file — this function will overwrite the
 * file at `targetPath` (the atomic rename is allowed to clobber the
 * source-when-no-rename case). See `executeHashlineEdits` for the
 * rename-target-exists guard.
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
 * Validate the runtime shape of `args`. Returns an error string for
 * any structurally invalid input. Does NOT throw — callers receive the
 * failure as a value, matching the rest of the tool's contract.
 */
function checkArgs(args: HashlineToolArgs): string | null {
  if (!args || typeof args !== "object") {
    return "executeHashlineEdits: args must be an object"
  }
  if (typeof args.filePath !== "string" || args.filePath.length === 0) {
    return "executeHashlineEdits: filePath is required"
  }
  if (!Array.isArray(args.edits)) {
    return "executeHashlineEdits: edits must be an array"
  }
  return null
}

/**
 * Execute a batch of hashline edits.
 *
 * `baseDir` is typically the session's project directory, used to
 * resolve relative `filePath` / `rename` arguments. When omitted,
 * `process.cwd()` is used.
 *
 * All structural failures (missing args, malformed anchors, stale hashes,
 * overlapping ranges, rename-target collisions, write errors) are
 * returned as `{ ok: false, error }` values. The function rejects only
 * if the underlying runtime throws (e.g. the host filesystem is gone).
 */
export async function executeHashlineEdits(args: HashlineToolArgs, baseDir?: string): Promise<HashlineResult> {
  const argsError = checkArgs(args)
  if (argsError) return { ok: false, error: argsError }

  const absSource = resolveFilePath(args.filePath, baseDir)
  const renameInfo = evaluateRename(args.rename, baseDir)
  if (renameInfo.error) return { ok: false, error: renameInfo.error }

  // Reject rename-into-existing-file BEFORE touching the source — silently
  // overwriting an unrelated file is a data-loss class of bug.
  if (renameInfo.absPath && renameInfo.absPath !== absSource) {
    try {
      const targetExists = await Bun.file(renameInfo.absPath).exists()
      if (targetExists) {
        return {
          ok: false,
          error:
            `Refusing to rename ${absSource} → ${renameInfo.absPath}: target file already exists. ` +
            `Delete or move the existing file first if the overwrite is intentional.`,
        }
      }
    } catch (err) {
      return {
        ok: false,
        error: `Failed to stat rename target ${renameInfo.absPath}: ${(err as Error).message}`,
      }
    }
  }

  const loaded = await loadSource(args, absSource)
  if (!loaded.ok) return { ok: false, error: loaded.error }

  const split = splitLines(loaded.original)
  // For ANY zero-line buffer (newly-created OR pre-existing zero-byte file)
  // followed by edits, synthesize a single empty line so the user-supplied
  // `1#<hash("")>` anchor matches. Without this, a pre-existing empty file
  // would inconsistently reject the same edit a createIfMissing flow accepts.
  const needsEmptyLineSynth = split.lines.length === 0 && args.edits.length > 0
  const lines = needsEmptyLineSynth ? [""] : split.lines
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
