/**
 * `lsp_rename` tool: requests a workspace-wide rename from the LSP server
 * and (unless dryRun) atomically applies the resulting WorkspaceEdit to disk.
 */

import { readFile, rename as renameFile, writeFile } from "node:fs/promises"
import path from "node:path"

import { tool, type ToolDefinition } from "../../../tool.js"

import { LspClient, uriToPath, type LspClientOptions } from "./client.js"
import { specForFile } from "./server-registry.js"
import type { Range, RenameSummary, TextEdit, WorkspaceEdit } from "./types.js"

export interface RenameResult {
  ok: boolean
  summary?: RenameSummary
  error?: string
}

interface FileEditGroup {
  uri: string
  filePath: string
  edits: TextEdit[]
}

function collectGroups(edit: WorkspaceEdit): FileEditGroup[] {
  const groups = new Map<string, FileEditGroup>()
  if (edit.documentChanges) {
    for (const change of edit.documentChanges) {
      const uri = change.textDocument.uri
      const fp = uriToPath(uri)
      const existing = groups.get(uri) ?? { uri, filePath: fp, edits: [] }
      existing.edits.push(...change.edits)
      groups.set(uri, existing)
    }
  }
  if (edit.changes) {
    for (const [uri, edits] of Object.entries(edit.changes)) {
      const fp = uriToPath(uri)
      const existing = groups.get(uri) ?? { uri, filePath: fp, edits: [] }
      existing.edits.push(...edits)
      groups.set(uri, existing)
    }
  }
  return [...groups.values()]
}

/** Apply a list of TextEdits to a string in last-to-first order. */
export function applyEdits(content: string, edits: TextEdit[]): string {
  const lines = content.split("\n")
  const offsets = lineOffsets(lines)
  const sorted = [...edits].sort((a, b) => compareRanges(b.range, a.range))
  let result = content
  for (const edit of sorted) {
    const start = positionToOffset(edit.range.start, offsets, lines)
    const end = positionToOffset(edit.range.end, offsets, lines)
    result = result.slice(0, start) + edit.newText + result.slice(end)
  }
  return result
}

function lineOffsets(lines: string[]): number[] {
  const offsets: number[] = [0]
  for (let i = 0; i < lines.length - 1; i++) {
    offsets.push(offsets[i]! + lines[i]!.length + 1)
  }
  return offsets
}

function positionToOffset(pos: { line: number; character: number }, offsets: number[], lines: string[]): number {
  const lineIdx = Math.min(pos.line, lines.length - 1)
  const base = offsets[lineIdx] ?? 0
  const lineLen = lines[lineIdx]?.length ?? 0
  return base + Math.min(pos.character, lineLen)
}

function compareRanges(a: Range, b: Range): number {
  if (a.start.line !== b.start.line) return a.start.line - b.start.line
  return a.start.character - b.start.character
}

/**
 * Atomic write: write to a sibling temp file and rename. Avoids leaving a
 * partially-written file behind if the process is interrupted mid-write.
 */
async function atomicWrite(filePath: string, content: string): Promise<void> {
  const tmp = `${filePath}.tmp.${process.pid}.${Date.now()}`
  await writeFile(tmp, content, "utf8")
  await renameFile(tmp, filePath)
}

async function applyGroups(groups: FileEditGroup[]): Promise<void> {
  // Build all updated contents first; only write after all builds succeed.
  const writes: Array<{ filePath: string; content: string }> = []
  for (const group of groups) {
    const original = await readFile(group.filePath, "utf8")
    const updated = applyEdits(original, group.edits)
    writes.push({ filePath: group.filePath, content: updated })
  }
  for (const w of writes) {
    await atomicWrite(w.filePath, w.content)
  }
}

export async function runRename(
  filePath: string,
  line: number,
  column: number,
  newName: string,
  dryRun: boolean,
  options: LspClientOptions = {},
): Promise<RenameResult> {
  const spec = specForFile(filePath)
  if (!spec) {
    return { ok: false, error: `No LSP server registered for ${path.extname(filePath) || "(no extension)"}` }
  }
  try {
    const client = await LspClient.forFile(filePath, options)
    const edit = await client.rename(filePath, line, column, newName)
    const groups = collectGroups(edit)
    const totalEdits = groups.reduce((sum, g) => sum + g.edits.length, 0)
    const summary: RenameSummary = {
      filesAffected: groups.length,
      totalEdits,
      applied: false,
      edits: groups,
    }
    if (!dryRun && groups.length > 0) {
      await applyGroups(groups)
      summary.applied = true
    }
    return { ok: true, summary }
  } catch (err) {
    return { ok: false, error: friendlyError(err, spec.installHint) }
  }
}

function friendlyError(err: unknown, installHint: string): string {
  const msg = err instanceof Error ? err.message : String(err)
  if (/ENOENT|not found|spawn .* ENOENT/i.test(msg)) return installHint
  return msg
}

export const lspRenameTool: ToolDefinition = tool({
  description:
    "Rename the symbol at (line, column) workspace-wide via LSP. " +
    "Returns the WorkspaceEdit summary. With dryRun=true, no files are modified.",
  args: {
    filePath: tool.schema.string().describe("Absolute path to the file containing the symbol"),
    line: tool.schema.number().int().nonnegative().describe("Zero-based line number"),
    column: tool.schema.number().int().nonnegative().describe("Zero-based column number"),
    newName: tool.schema.string().min(1).describe("New identifier"),
    dryRun: tool.schema.boolean().optional().describe("If true, return the edit set without writing files"),
  },
  async execute({ filePath, line, column, newName, dryRun }) {
    const result = await runRename(filePath, line, column, newName, dryRun ?? false)
    return {
      output: JSON.stringify(result, null, 2),
      metadata: {
        ok: result.ok,
        applied: result.summary?.applied ?? false,
        filesAffected: result.summary?.filesAffected ?? 0,
        totalEdits: result.summary?.totalEdits ?? 0,
      },
    }
  },
})
