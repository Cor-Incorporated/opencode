import path from "path"
import { Instance } from "@/project/instance"
import { Log } from "@/util/log"
import { Memory } from "./types"

const log = Log.create({ service: "memory.file" })

const MEMORY_DIR = ".opencode/memory"
const INDEX_FILE = "MEMORY.md"

function memoryDir() {
  return path.join(Instance.directory, MEMORY_DIR)
}

function indexPath() {
  return path.join(memoryDir(), INDEX_FILE)
}

function entryPath(filename: string) {
  const dir = memoryDir()
  const resolved = path.resolve(dir, filename)
  if (!resolved.startsWith(dir + path.sep))
    throw new Error("path traversal detected")
  return resolved
}

function parseFrontmatter(raw: string): { frontmatter: Memory.Frontmatter; content: string } | undefined {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/)
  if (!match) return undefined
  const lines = match[1].split("\n")
  const fm: Record<string, string> = {}
  for (const line of lines) {
    const idx = line.indexOf(":")
    if (idx === -1) continue
    fm[line.slice(0, idx).trim()] = line.slice(idx + 1).trim()
  }
  if (!fm.topic || !fm.type) return undefined
  const validTypes: readonly string[] = Memory.TYPES
  if (!validTypes.includes(fm.type)) return undefined
  return {
    frontmatter: {
      topic: fm.topic,
      type: fm.type as Memory.Type,
    },
    content: match[2].trim(),
  }
}

function formatFrontmatter(entry: Memory.FileEntry): string {
  return [
    "---",
    `topic: ${entry.frontmatter.topic}`,
    `type: ${entry.frontmatter.type}`,
    "---",
    "",
    entry.content,
    "",
  ].join("\n")
}

export namespace MemoryFile {
  export async function readIndex(maxLines = 200): Promise<string | undefined> {
    const file = Bun.file(indexPath())
    const exists = await file.exists()
    if (!exists) return undefined
    const raw = await file.text()
    const lines = raw.split("\n")
    return lines.length > maxLines ? lines.slice(0, maxLines).join("\n") : raw
  }

  export async function writeIndex(content: string): Promise<void> {
    const dir = memoryDir()
    await Bun.write(path.join(dir, ".keep"), "")
    await Bun.write(indexPath(), content)
  }

  export async function readEntry(filename: string): Promise<Memory.FileEntry | undefined> {
    const file = Bun.file(entryPath(filename))
    const exists = await file.exists()
    if (!exists) return undefined
    const raw = await file.text()
    const parsed = parseFrontmatter(raw)
    if (!parsed) return undefined
    return { filename, ...parsed }
  }

  export async function writeEntry(entry: Memory.FileEntry): Promise<void> {
    const dir = memoryDir()
    await Bun.write(path.join(dir, ".keep"), "")
    await Bun.write(entryPath(entry.filename), formatFrontmatter(entry))
    log.info("memory file written", { filename: entry.filename })
  }

  export async function removeEntry(filename: string): Promise<void> {
    const filepath = entryPath(filename)
    const file = Bun.file(filepath)
    if (await file.exists()) {
      const { unlink } = await import("fs/promises")
      await unlink(filepath)
      log.info("memory file removed", { filename })
    }
  }

  export async function listEntries(): Promise<Memory.FileEntry[]> {
    const dir = memoryDir()
    const { readdir } = await import("fs/promises")
    const files = await readdir(dir).catch(() => [] as string[])
    const entries: Memory.FileEntry[] = []
    for (const file of files) {
      if (!file.endsWith(".md") || file === INDEX_FILE) continue
      const entry = await readEntry(file)
      if (entry) entries.push(entry)
    }
    return entries
  }

  export function getMemoryDir() {
    return memoryDir()
  }

  export function getIndexPath() {
    return indexPath()
  }
}
