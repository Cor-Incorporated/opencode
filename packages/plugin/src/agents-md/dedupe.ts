/**
 * Phase 4 — Review & dedupe.
 *
 * Once every chosen directory has its merged AGENTS.md, scan child files for
 * sections whose body text is identical to (or trivially restates) the same
 * section in any ancestor. Parent wins; child is removed. Also strips a small
 * blacklist of generic AI-flavored boilerplate that adds tokens without value.
 *
 * The boilerplate strip is intentionally narrow: it only runs on auto sections
 * that are not marked `<!-- preserve -->`. Hand-written sections (and auto
 * sections the user pinned) are byte-preserved — the generator never emits the
 * blacklisted phrases itself, so anyone with these phrases in their AGENTS.md
 * has put them there deliberately.
 */

import { parseSections } from "./merge.js"
import type { Section } from "./types.js"

const GENERIC_PHRASES = [
  /be helpful/i,
  /follow best practices/i,
  /consider the user'?s needs/i,
  /please ensure that you/i,
  /it is important to note that/i,
  /as an ai/i,
]

export type DedupePair = {
  /** Relative path of the file whose section was removed. */
  child: string
  /** Heading of the section that was deduped. */
  heading: string
  /** Relative path of the ancestor that already covered the topic. */
  ancestor: string
}

export type DedupeInput = {
  /** Map of relativePath -> markdown content. Relative paths use `/` separators. */
  files: Map<string, string>
}

export type DedupeOutput = {
  /** Updated map with deduped content. */
  files: Map<string, string>
  /** Per-section dedupe events for the summary report. */
  removed: DedupePair[]
}

/** Run dedupe + boilerplate stripping across an entire AGENTS.md set. */
export function dedupe(input: DedupeInput): DedupeOutput {
  const ordered = [...input.files.entries()].sort((a, b) => depthOf(a[0]) - depthOf(b[0]))
  const parsed = new Map<string, Section[]>()
  for (const [rel, text] of ordered) parsed.set(rel, parseSections(text))
  // Strip generic phrases only from auto sections that are not user-pinned.
  // Hand-written and `<!-- preserve -->`-marked sections must remain byte-identical.
  for (const sections of parsed.values()) {
    for (const s of sections) {
      if (s.isAuto && !s.preserved && s.heading.length > 0) {
        s.body = stripGeneric(s.body)
      }
    }
  }
  const removed: DedupePair[] = []
  for (const [rel, sections] of parsed) {
    if (rel === "." || rel === "AGENTS.md") continue
    const ancestors = ancestorPaths(rel).filter((a) => parsed.has(a))
    const filtered = sections.filter((s) => {
      if (s.heading === "") return true
      if (s.preserved) return true
      for (const a of ancestors) {
        const ancestorSection = parsed.get(a)?.find((x) => x.heading === s.heading)
        if (!ancestorSection) continue
        if (sectionsEquivalent(s, ancestorSection)) {
          removed.push({ child: rel, heading: s.heading, ancestor: a })
          return false
        }
      }
      return true
    })
    parsed.set(rel, filtered)
  }
  const out = new Map<string, string>()
  for (const [rel, sections] of parsed) out.set(rel, renderSections(sections))
  return { files: out, removed }
}

/** Walk from `rel` up to the discovery root, returning ancestor file keys. */
function ancestorPaths(rel: string): string[] {
  const parts = rel.split("/")
  // Drop trailing AGENTS.md if caller passed full file path.
  if (parts[parts.length - 1] === "AGENTS.md") parts.pop()
  const out: string[] = []
  for (let i = parts.length - 1; i > 0; i--) {
    out.push(parts.slice(0, i).join("/") + "/AGENTS.md")
  }
  out.push("AGENTS.md")
  return out
}

function depthOf(rel: string): number {
  if (rel === "AGENTS.md") return 0
  return rel.split("/").length - 1
}

/** Two sections are "equivalent" when their normalized bodies match. */
function sectionsEquivalent(a: Section, b: Section): boolean {
  return normalize(a.body) === normalize(b.body)
}

function normalize(body: string): string {
  return body
    .toLowerCase()
    .replace(/`[^`]*`/g, "") // strip inline code
    .replace(/\s+/g, " ")
    .trim()
}

/** Drop lines containing any blacklisted generic AI-flavored phrase. */
function stripGeneric(text: string): string {
  return text
    .split("\n")
    .filter((line) => !GENERIC_PHRASES.some((re) => re.test(line)))
    .join("\n")
}

function renderSections(sections: Section[]): string {
  const out: string[] = []
  for (const s of sections) {
    if (s.heading === "") {
      if (s.body.trim().length > 0) out.push(s.body.trim() + "\n")
      continue
    }
    out.push(`## ${s.heading}\n\n${s.body.trim()}\n`)
  }
  return out.join("\n").trim() + "\n"
}

/** Approximate token count: ~4 chars per token, matches OpenAI's rule of thumb. */
export function approxTokens(text: string): number {
  return Math.ceil(text.length / 4)
}
