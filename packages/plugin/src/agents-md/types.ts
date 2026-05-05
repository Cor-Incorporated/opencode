/**
 * Type contracts for the `/init-deep` hierarchical AGENTS.md generator.
 *
 * The generator runs in four phases:
 *   1. Discovery — walk the project tree and collect per-directory facts.
 *   2. Scoring   — assign each directory an eligibility score.
 *   3. Generate  — render an AGENTS.md for each chosen directory.
 *   4. Review    — dedupe child guidance against ancestor guidance.
 *
 * All paths are absolute unless otherwise noted.
 */

/** Source-file extensions counted by Discovery. */
export const SOURCE_EXTENSIONS = [
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".py",
  ".go",
  ".rs",
  ".java",
  ".cpp",
  ".swift",
  ".kt",
  ".rb",
] as const

export type SourceExtension = (typeof SOURCE_EXTENSIONS)[number]

/** Directory names skipped during traversal regardless of `.gitignore`. */
export const ALWAYS_EXCLUDED_DIRS = [
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  ".turbo",
  "__pycache__",
  "target",
  ".venv",
  "venv",
  ".cache",
  "coverage",
  ".sst",
  ".worktrees",
  "ts-dist",
] as const

/** Decision options for a single directory. */
export type DirAction = "generate" | "update" | "skip"

/** Facts gathered for a single directory during Phase 1. */
export type DirStats = {
  /** Absolute filesystem path. */
  path: string
  /** Path relative to the discovery root, using POSIX separators. */
  relPath: string
  /** Distance from the discovery root (root itself is 0). */
  depth: number
  /** Source-file count directly in this directory (non-recursive). */
  fileCount: number
  /** Subdirectory count after applying the exclusion list (non-recursive). */
  subdirCount: number
  /** Total LOC across direct source files (newline count). */
  loc: number
  /** Distinct source extensions present directly in this directory. */
  languages: SourceExtension[]
  /** Pre-existing AGENTS.md contents at this directory (raw markdown). */
  existing?: string
  /** package.json description, if a package.json is present in this directory. */
  packageDescription?: string
  /** Manifest filenames present in this directory (package.json, go.mod, etc.). */
  manifests: string[]
}

/** Outcome of Phase 2 scoring. */
export type DirScore = {
  stats: DirStats
  score: number
  /** Loc share component (% of repo LOC, capped at 10). */
  locShare: number
  /** Decided action after applying the rule table. */
  action: DirAction
  /** Human-readable reason for the chosen action. */
  reason: string
}

/** Public input to {@link runInitDeep}. */
export type InitDeepOpts = {
  /** Directory to scan. Defaults to `process.cwd()`. */
  cwd?: string
  /** Maximum depth from `cwd` (root = depth 0). Defaults to 4. */
  maxDepth?: number
  /** Bypass scoring and emit at every directory with score >= 2. */
  createNew?: boolean
  /** Compute a plan and return it without touching the filesystem. */
  dryRun?: boolean
}

/** Public output of {@link runInitDeep}. */
export type InitDeepResult = {
  /** Absolute paths of AGENTS.md files written or updated. */
  generated: string[]
  /** Directories deliberately not emitted, with the reason. */
  skipped: { path: string; reason: string }[]
  /** Number of duplicate sections removed during Phase 4. */
  duplicatesRemoved: number
  /** Approximate token count of newly added content (chars / 4). */
  approxTokensAdded: number
  /** When `dryRun` is true, the per-directory action plan. */
  plan?: { path: string; score: number; action: DirAction }[]
}

/** A single AGENTS.md section, used by merge / dedupe machinery. */
export type Section = {
  /** Heading level (number of `#` characters). */
  level: number
  /** Heading text, e.g. "Overview". Empty string for the file preamble. */
  heading: string
  /** Section body, including any nested subsections. */
  body: string
  /** True when the section is one this generator manages automatically. */
  isAuto: boolean
  /** True when an explicit `<!-- preserve -->` marker was found. */
  preserved: boolean
}

/** Auto-managed section names. Anything else is treated as hand-written. */
export const AUTO_SECTIONS = [
  "Overview",
  "Languages & Stack",
  "Structure",
  "Where to find things",
  "Project Context",
  "Build & Test",
  "Related",
] as const

export type AutoSectionName = (typeof AUTO_SECTIONS)[number]
