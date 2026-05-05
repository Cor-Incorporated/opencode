/**
 * Merge — preserve hand-written sections when updating an existing AGENTS.md.
 *
 * Rules:
 *   1. Auto sections (Overview, Languages & Stack, Structure, Where to find
 *      things, Project Context, Build & Test, Related) are replaced with the
 *      newly generated content.
 *   2. Any section not in the auto list, OR a section containing
 *      `<!-- preserve -->`, is kept exactly as it appeared in the existing
 *      file.
 *   3. The file preamble (text before the first `##` heading) is preserved
 *      whenever the existing file has a non-empty preamble; the generated
 *      preamble is only used when the existing one is missing/empty. This
 *      protects hand-written directives at the top of an AGENTS.md from
 *      silent deletion on re-run.
 *   4. Section ordering follows the generated file; preserved sections that
 *      do not appear in the generated output are appended in their original
 *      order at the end of the file so nothing is silently dropped.
 *   5. `parseSections` tracks fenced code block (` ``` `) state so a
 *      `## Heading` example inside an example markdown block does not get
 *      promoted to a real section.
 */

import { AUTO_SECTIONS, type Section } from "./types.js"

const AUTO_SECTION_SET = new Set<string>(AUTO_SECTIONS)
const PRESERVE_MARKER = "<!-- preserve -->"

/** Merge a freshly generated AGENTS.md against the existing one on disk. */
export function merge(existing: string, generated: string): string {
  const existingSections = parseSections(existing)
  const generatedSections = parseSections(generated)
  const preamble = pickPreamble(existingSections, generatedSections)
  const generatedBody = generatedSections.filter((s) => s.heading.length > 0)
  const usedExistingHeadings = new Set<string>()
  const merged: Section[] = generatedBody.map((g) => {
    const existingMatch = findSection(existingSections, g.heading)
    if (existingMatch && (existingMatch.preserved || !AUTO_SECTION_SET.has(existingMatch.heading))) {
      usedExistingHeadings.add(existingMatch.heading)
      return existingMatch
    }
    if (existingMatch) usedExistingHeadings.add(existingMatch.heading)
    return g
  })
  const orphaned = existingSections.filter(
    (s) => s.heading.length > 0 && !usedExistingHeadings.has(s.heading) && !AUTO_SECTION_SET.has(s.heading),
  )
  const out: string[] = []
  if (preamble.body.trim().length > 0) out.push(preamble.body.trim() + "\n")
  for (const s of merged) out.push(`## ${s.heading}\n\n${s.body.trim()}\n`)
  for (const s of orphaned) out.push(`## ${s.heading}\n\n${s.body.trim()}\n`)
  return out.join("\n").trim() + "\n"
}

/**
 * Choose which preamble (existing vs generated) to lead the merged file.
 *
 * Preservation-by-default: any non-empty existing preamble wins. Hand-written
 * directives at the top of an AGENTS.md (e.g. "always use parallel tools") do
 * not carry per-line markers, so they would otherwise be silently overwritten
 * by the generated preamble on every re-run.
 */
function pickPreamble(existing: Section[], generated: Section[]): Section {
  const existingPre = existing.find((s) => s.heading === "")
  const generatedPre = generated.find((s) => s.heading === "")
  if (existingPre && existingPre.body.trim().length > 0) return existingPre
  return generatedPre ?? existingPre ?? { level: 0, heading: "", body: "", isAuto: true, preserved: false }
}

function findSection(sections: Section[], heading: string): Section | undefined {
  return sections.find((s) => s.heading === heading)
}

/**
 * Split markdown into sections at level-2 (`##`) headings. Higher-level
 * headings inside a section (e.g. `###`) stay attached to that section's
 * body so we never split aggregated content like sub-bullet groups.
 *
 * Fenced code blocks (` ```… ``` `) are tracked so a `## Heading` line that
 * appears inside an example markdown snippet is treated as body text rather
 * than promoted to a real section. Otherwise round-tripping a file that
 * contains markdown examples would corrupt them on every merge.
 */
export function parseSections(markdown: string): Section[] {
  const lines = markdown.split("\n")
  const sections: Section[] = []
  let current: Section = { level: 0, heading: "", body: "", isAuto: true, preserved: false }
  const buffer: string[] = []
  let inFence = false
  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence
      buffer.push(line)
      continue
    }
    if (inFence) {
      buffer.push(line)
      continue
    }
    const m = /^(#{1,2})\s+(.+?)\s*$/.exec(line)
    if (m && m[1]?.length === 2) {
      finalizeSection(current, buffer, sections)
      current = { level: 2, heading: m[2]!.trim(), body: "", isAuto: AUTO_SECTION_SET.has(m[2]!.trim()), preserved: false }
      buffer.length = 0
      continue
    }
    if (m && m[1]?.length === 1 && current.heading === "" && current.body.length === 0 && buffer.length === 0) {
      // Top-level title (`# Foo`) — keep as part of the preamble body.
      buffer.push(line)
      continue
    }
    buffer.push(line)
  }
  finalizeSection(current, buffer, sections)
  return sections
}

function finalizeSection(section: Section, buffer: string[], out: Section[]): void {
  const body = buffer.join("\n").replace(/^\s+|\s+$/g, "")
  const preserved = body.includes(PRESERVE_MARKER) || section.heading.includes(PRESERVE_MARKER)
  out.push({ ...section, body, preserved })
}
