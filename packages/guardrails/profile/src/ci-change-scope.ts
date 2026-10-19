/** Pattern J: classify changed paths into CI intensity tiers (structural path rules). */

export type CiTier = "docs" | "code" | "guardrails"

const DOCS_PREFIXES = ["specs/", "docs/"]
const DOCS_EXT = [".md", ".mdx"]
const GUARDRAILS_PREFIX = "packages/guardrails/"
const WORKFLOW_PREFIX = ".github/workflows/"

export function isDocsPath(file: string) {
  const normalized = file.replaceAll("\\", "/")
  if (normalized.startsWith(GUARDRAILS_PREFIX)) return false
  if (normalized.startsWith(WORKFLOW_PREFIX)) return false
  if (DOCS_PREFIXES.some((prefix) => normalized.startsWith(prefix))) return true
  return DOCS_EXT.some((ext) => normalized.endsWith(ext))
}

export function isGuardrailsPath(file: string) {
  const normalized = file.replaceAll("\\", "/")
  return normalized.startsWith(GUARDRAILS_PREFIX) || normalized.startsWith(WORKFLOW_PREFIX)
}

export function classifyCiTier(files: string[]): CiTier {
  if (files.some(isGuardrailsPath)) return "guardrails"
  if (files.length > 0 && files.every(isDocsPath)) return "docs"
  return "code"
}

export function shouldRunFullCi(files: string[]) {
  return classifyCiTier(files) !== "docs"
}

export function shouldRunDocsLint(files: string[]) {
  return files.some(isDocsPath) || classifyCiTier(files) === "docs"
}
