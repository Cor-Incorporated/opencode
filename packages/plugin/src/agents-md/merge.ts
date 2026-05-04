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
 *   3. The file preamble (text before the first `##` heading) is taken from
 *      the generated output, but if the existing preamble carried the
 *      `<!-- preserve -->` marker we keep it instead.
 *   4. Section ordering follows the generated file; preserved sections that
 *      do not appear in the generated output are appended in their original
 *      order at the end of the file so nothing is silently dropped.
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

/** Choose which preamble (existing vs generated) to lead the merged file. */
function pickPreamble(existing: Section[], generated: Section[]): Section {
  const existingPre = existing.find((s) => s.heading === "")
  const generatedPre = generated.find((s) => s.heading === "")
  if (existingPre && existingPre.preserved) return existingPre
  if (generatedPre) return generatedPre
  return existingPre ?? { level: 0, heading: "", body: "", isAuto: true, preserved: false }
}

function findSection(sections: Section[], heading: string): Section | undefined {
  return sections.find((s) => s.heading === heading)
}

/**
 * Split markdown into sections at level-2 (`##`) headings. Higher-level
 * headings inside a section (e.g. `###`) stay attached to that section's
 * body so we never split aggregated content like sub-bullet groups.
 */
export function parseSections(markdown: string): Section[] {
  const lines = markdown.split("\n")
  const sections: Section[] = []
  let current: Section = { level: 0, heading: "", body: "", isAuto: true, preserved: false }
  const buffer: string[] = []
  for (const line of lines) {
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
