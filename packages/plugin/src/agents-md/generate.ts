/**
 * Phase 3 — Generate.
 *
 * Render an AGENTS.md from collected facts. Output sections (in order):
 *
 *   # <DirectoryName>
 *   ## Overview
 *   ## Languages & Stack
 *   ## Structure
 *   ## Conventions       (only if inherited from parent)
 *   ## Related
 *   ## Project Context   (root only)
 *   ## Build & Test      (root only)
 *   ## Where to find things  (root only)
 *
 * Empty sections are omitted. Output is hard-capped at 200 lines with a
 * truncation marker; root targets 50–150 lines, subdirs 30–80 lines.
 */

import * as path from "node:path"
import { AUTO_SECTIONS, type DirScore, type DirStats } from "./types.js"

const HARD_LINE_CAP = 200
const TRUNCATION_MARKER = "<!-- truncated by /init-deep -->"
const PRESERVE_MARKER = "<!-- preserve -->"

export type GenerateContext = {
  /** All scored directories — used to build cross-links and the index. */
  all: DirScore[]
  /** Directories scheduled to receive an AGENTS.md (generate or update). */
  emitting: DirScore[]
  /** Discovery root, for relative-link computation. */
  rootRelPath: string
}

/** Render a complete AGENTS.md for one directory. */
export function generate(target: DirScore, ctx: GenerateContext): string {
  const isRoot = target.stats.depth === 0
  const sections: string[] = []
  sections.push(renderHeading(target.stats))
  appendSection(sections, "Overview", renderOverview(target.stats))
  appendSection(sections, "Languages & Stack", renderLanguages(target.stats))
  appendSection(sections, "Structure", renderStructure(target, ctx))
  if (isRoot) {
    appendSection(sections, "Project Context", renderProjectContext(target.stats))
    appendSection(sections, "Build & Test", renderBuildTest(target.stats))
    appendSection(sections, "Where to find things", renderIndex(ctx))
  }
  appendSection(sections, "Related", renderRelated(target, ctx))
  return finalize(sections.join("\n").trim() + "\n")
}

/** Push a section block when the body has content. */
function appendSection(out: string[], heading: string, body: string): void {
  const trimmed = body.trim()
  if (trimmed.length === 0) return
  out.push(`## ${heading}\n\n${trimmed}\n`)
}

function renderHeading(s: DirStats): string {
  const name = s.relPath === "." ? path.basename(s.path) || "Project" : path.basename(s.path)
  return `# ${name}\n`
}

/** Single paragraph: inferred role from path + optional package description. */
function renderOverview(s: DirStats): string {
  const role = inferRole(s)
  const desc = s.packageDescription ? ` ${s.packageDescription}` : ""
  return `${role}${desc}`.trim()
}

/** Map a relative path to a short prose description of the directory's role. */
function inferRole(s: DirStats): string {
  const rel = s.relPath
  if (rel === ".") return "Repository root."
  const head = rel.split("/")[0] ?? rel
  const leaf = path.basename(rel)
  if (head === "src") return `Source module \`${rel}\`.`
  if (head === "packages") return `Workspace package \`${rel}\`.`
  if (head === "app" || head === "apps") return `Application surface \`${rel}\`.`
  if (head === "test" || head === "tests" || leaf === "__tests__") return `Test suite for \`${rel}\`.`
  if (head === "scripts" || head === "script") return `Operational scripts under \`${rel}\`.`
  if (head === "docs") return `Documentation under \`${rel}\`.`
  if (head === ".opencode") return `OpenCode configuration under \`${rel}\`.`
  return `Directory \`${rel}\`.`
}

/** Bullet list of detected languages and frameworks (manifest-driven). */
function renderLanguages(s: DirStats): string {
  const lines: string[] = []
  if (s.languages.length > 0) {
    const friendly = s.languages.map(extLabel).join(", ")
    lines.push(`- Languages: ${friendly}`)
  }
  for (const m of s.manifests) {
    lines.push(`- Manifest: \`${m}\``)
  }
  return lines.join("\n")
}

function extLabel(ext: string): string {
  const map: Record<string, string> = {
    ".ts": "TypeScript",
    ".tsx": "TypeScript (TSX)",
    ".js": "JavaScript",
    ".jsx": "JavaScript (JSX)",
    ".py": "Python",
    ".go": "Go",
    ".rs": "Rust",
    ".java": "Java",
    ".cpp": "C++",
    ".swift": "Swift",
    ".kt": "Kotlin",
    ".rb": "Ruby",
  }
  return map[ext] ?? ext
}

/** Tree-style listing of immediate child directories (those discovered). */
function renderStructure(target: DirScore, ctx: GenerateContext): string {
  const directChildren = ctx.all
    .filter((d) => isImmediateChild(target.stats, d.stats))
    .sort((a, b) => a.stats.relPath.localeCompare(b.stats.relPath))
  if (directChildren.length === 0) return ""
  const longest = directChildren.reduce((m, d) => Math.max(m, path.basename(d.stats.path).length + 1), 0)
  return directChildren
    .map((d) => {
      const name = path.basename(d.stats.path) + "/"
      const padded = name.padEnd(longest + 2)
      return `- ${padded} ${describeChild(d.stats)}`
    })
    .join("\n")
}

function isImmediateChild(parent: DirStats, candidate: DirStats): boolean {
  if (candidate.depth !== parent.depth + 1) return false
  if (parent.relPath === ".") return !candidate.relPath.includes("/")
  return candidate.relPath.startsWith(parent.relPath + "/") &&
    candidate.relPath.slice(parent.relPath.length + 1).indexOf("/") === -1
}

function describeChild(s: DirStats): string {
  if (s.packageDescription) return s.packageDescription
  if (s.manifests.includes("package.json")) return "package workspace"
  if (s.languages.length === 0) return "supporting files"
  return `${s.languages.length} language(s), ${s.fileCount} file(s)`
}

/** Root-only — short project framing derived from what we know. */
function renderProjectContext(s: DirStats): string {
  const lines = [
    `Generated by \`/init-deep\`. Discovered at \`${path.basename(s.path)}\`.`,
    "Hierarchical AGENTS.md helps agents pull only the local guidance they need.",
  ]
  return lines.join(" ")
}

/** Root-only — best-effort hint at how to build/test based on manifests. */
function renderBuildTest(s: DirStats): string {
  const lines: string[] = []
  if (s.manifests.includes("package.json")) lines.push("- Install: `bun install`")
  if (s.manifests.includes("package.json")) lines.push("- Typecheck: `bun typecheck`")
  if (s.manifests.includes("package.json")) lines.push("- Tests: from each package directory, `bun test`")
  if (s.manifests.includes("pyproject.toml")) lines.push("- Python: `uv sync && uv run pytest`")
  if (s.manifests.includes("go.mod")) lines.push("- Go: `go test ./...`")
  if (s.manifests.includes("Cargo.toml")) lines.push("- Rust: `cargo test`")
  return lines.join("\n")
}

/** Root-only — index of every emitted AGENTS.md, by relative path. */
function renderIndex(ctx: GenerateContext): string {
  const others = ctx.emitting
    .filter((d) => d.stats.depth > 0)
    .sort((a, b) => a.stats.relPath.localeCompare(b.stats.relPath))
  if (others.length === 0) return ""
  return others
    .map((d) => `- [\`${d.stats.relPath}/AGENTS.md\`](./${d.stats.relPath}/AGENTS.md) — score ${d.score}`)
    .join("\n")
}

/** Cross-link to the parent AGENTS.md (when one will exist). */
function renderRelated(target: DirScore, ctx: GenerateContext): string {
  if (target.stats.depth === 0) return ""
  const parentRel = parentRelPath(target.stats.relPath)
  const parentEmits = ctx.emitting.find((d) => d.stats.relPath === parentRel)
  if (!parentEmits) return ""
  const hops = target.stats.relPath.split("/").length
  const upPath = "../".repeat(hops) + "AGENTS.md"
  const parentLabel = parentRel === "." ? "root AGENTS.md" : `${parentRel}/AGENTS.md`
  return `- Parent: [${parentLabel}](${upPath})`
}

function parentRelPath(rel: string): string {
  if (rel === ".") return "."
  const idx = rel.lastIndexOf("/")
  return idx === -1 ? "." : rel.slice(0, idx)
}

/** Enforce the hard line cap; appends a marker when truncation occurs. */
function finalize(text: string): string {
  const lines = text.split("\n")
  if (lines.length <= HARD_LINE_CAP) return text
  const kept = lines.slice(0, HARD_LINE_CAP - 1)
  kept.push(TRUNCATION_MARKER)
  return kept.join("\n") + "\n"
}

/** Heading text used for an auto section, exposed for merge.ts. */
export const AUTO_SECTION_HEADINGS: readonly string[] = AUTO_SECTIONS

/** Marker authors can place inside a section to opt out of regeneration. */
export const PRESERVE_SECTION_MARKER = PRESERVE_MARKER
