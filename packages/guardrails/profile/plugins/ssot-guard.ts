import path from "path"
import type { GuardrailContext } from "./guardrail-context"
import { MUTATING_TOOLS, list, stash, str } from "./guardrail-patterns"

export type MirrorSide = {
  name: string
  patterns: string[]
}

export type MirrorSet = {
  id: string
  description: string
  sides: MirrorSide[]
  checkHint: string
}

export type SsotAdvisory = {
  set: MirrorSet
  touched: string[]
  missing: string[]
}

/**
 * Pattern K defaults: artifacts that must converge on the same final state.
 * Structural path matchers only — never word-match on "high" / "DROP" / etc.
 */
export const DEFAULT_MIRROR_SETS: MirrorSet[] = [
  {
    id: "db-schema",
    description: "migration DDL vs initial-schema SSOT",
    sides: [
      { name: "migrations", patterns: ["**/migrations/**", "**/*.up.sql", "**/*.down.sql"] },
      { name: "ssot", patterns: ["**/initial-schema.sql", "packages/contracts/**/*.sql"] },
    ],
    checkHint: "Run /ssot-check (migrate-built DB vs SSOT-built DB comparison)",
  },
  {
    id: "version-pins",
    description: "version pins that must agree across workflow/policy/preflight",
    sides: [
      { name: "policy", patterns: ["**/*deployment*policies*.json"] },
      { name: "preflight", patterns: ["**/*migration*preflight*", "**/*preflight*.go"] },
      { name: "contract-check", patterns: ["**/*deployment-contract*", "**/*contract-validation*"] },
      { name: "workflow", patterns: ["**/*-cd.yml", "**/*-cd.yaml"] },
    ],
    checkHint: "Align every expected-version declaration, then run /ssot-check",
  },
  {
    id: "api-contract",
    description: "OpenAPI vs generated clients/stubs",
    sides: [
      { name: "openapi", patterns: ["**/openapi.yaml", "**/openapi.yml", "**/openapi.json"] },
      { name: "generated", patterns: ["**/generated/**", "**/gen/**"] },
    ],
    checkHint: "Regenerate clients/stubs from OpenAPI and verify the diff",
  },
]

export function ssotGuardDisabled(env: NodeJS.ProcessEnv = process.env) {
  return /^(0|false|off|no)$/i.test(env.OPENCODE_SSOT_GUARD ?? "")
}

export function normalizeRepoPath(file: string) {
  return file.replaceAll("\\", "/").replace(/^\.\//, "")
}

/** Minimal glob: `*` within a segment, `**` across segments. */
export function matchGlob(file: string, pattern: string) {
  const normalized = normalizeRepoPath(file)
  const escaped = pattern
    .replaceAll("\\", "/")
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "{{GLOBSTAR}}")
    .replace(/\*/g, "[^/]*")
    .replace(/{{GLOBSTAR}}/g, ".*")
  return new RegExp(`^${escaped}$`, "i").test(normalized)
}

export function sideHit(file: string, side: MirrorSide) {
  return side.patterns.some((pattern) => matchGlob(file, pattern))
}

export function evaluateSsotDrift(changedFiles: string[], sets: MirrorSet[] = DEFAULT_MIRROR_SETS) {
  const files = changedFiles.map(normalizeRepoPath).filter(Boolean)
  const advisories: SsotAdvisory[] = []
  for (const set of sets) {
    const touched = set.sides.filter((side) => files.some((file) => sideHit(file, side))).map((side) => side.name)
    if (!touched.length) continue
    if (touched.length === set.sides.length) continue
    const missing = set.sides.map((side) => side.name).filter((name) => !touched.includes(name))
    advisories.push({ set, touched, missing })
  }
  return advisories
}

export function formatSsotAdvisory(advisories: SsotAdvisory[]) {
  if (!advisories.length) return ""
  const body = advisories
    .map(
      (item) =>
        `- ${item.set.id} (${item.set.description}): touched [${item.touched.join(", ")}] missing [${item.missing.join(", ")}]\n` +
        `  → ${item.set.checkHint}`,
    )
    .join("\n")
  return (
    `⚠️ [SSOT SYNC ADVISORY — pattern K] Mirrored artifact(s) changed without updating every side.\n` +
    `${body}\n` +
    `This is guidance only (not a hard block). Run /ssot-check before opening a PR. ` +
    `Set OPENCODE_SSOT_GUARD=off to silence.`
  )
}

/** Extract numeric/version pins from file texts for CI wiring-style equality checks. */
export function extractVersionPins(
  files: { file: string; text: string }[],
  patterns: RegExp[] = [
    /expected[_-]?version["'\s:=]+(\d+)/i,
    /migration[_-]?version["'\s:=]+(\d+)/i,
    /post[_-]?migration[_-]?version["'\s:=]+(\d+)/i,
    /ALPHA_EXPECTED_VERSION["'\s:=]+(\d+)/i,
    /"version"\s*:\s*(\d+)/,
  ],
) {
  return files.flatMap((item) => {
    for (const pattern of patterns) {
      const match = item.text.match(pattern)
      if (match?.[1]) return [{ file: item.file, value: match[1] }]
    }
    return []
  })
}

export function assertVersionPinsEqual(pins: { file: string; value: string }[]) {
  if (pins.length < 2) {
    return { ok: true as const, values: pins.map((pin) => pin.value), detail: "fewer than 2 pins — nothing to compare" }
  }
  const values = [...new Set(pins.map((pin) => pin.value))]
  if (values.length === 1) return { ok: true as const, values, detail: `all pins=${values[0]}` }
  const detail = pins.map((pin) => `${pin.file}=${pin.value}`).join(", ")
  return { ok: false as const, values, detail: `version pin drift: ${detail}` }
}

export function collectTouchedPaths(item: { tool: string; args?: Record<string, unknown> }, out?: { args?: Record<string, unknown> }) {
  if (!MUTATING_TOOLS.has(item.tool)) return [] as string[]
  const args = { ...(item.args ?? {}), ...(out?.args ?? {}) }
  const paths: string[] = []
  for (const key of ["filePath", "path", "file"]) {
    const value = args[key]
    if (typeof value === "string" && value) paths.push(value)
  }
  if (Array.isArray(args.files)) {
    for (const file of args.files) {
      if (typeof file === "string" && file) paths.push(file)
    }
  }
  return paths.map(normalizeRepoPath)
}

export async function loadMirrorSets(worktree: string) {
  const custom = await Bun.file(path.join(worktree, ".opencode", "guardrails", "ssot-mirrors.json"))
    .json()
    .catch(() => null)
  if (!custom || typeof custom !== "object") return DEFAULT_MIRROR_SETS
  const sets = (custom as { sets?: unknown }).sets
  if (!Array.isArray(sets) || !sets.length) return DEFAULT_MIRROR_SETS
  const parsed = sets.filter((item): item is MirrorSet => {
    if (!item || typeof item !== "object") return false
    const set = item as MirrorSet
    return typeof set.id === "string" && Array.isArray(set.sides) && set.sides.length > 0
  })
  return parsed.length ? parsed : DEFAULT_MIRROR_SETS
}

export function createSsotHandlers(ctx: GuardrailContext) {
  async function afterMutatingTool(
    item: { tool: string; args?: Record<string, unknown> },
    out: { args?: Record<string, unknown>; output?: string },
  ) {
    if (ssotGuardDisabled()) return
    const touched = collectTouchedPaths(item, out)
    if (!touched.length) return

    const data = await stash(ctx.state)
    const accumulated = [...new Set([...list(data.ssot_touched_files), ...touched])]
    const sets = await loadMirrorSets(ctx.input.worktree)
    const advisories = evaluateSsotDrift(accumulated, sets)
    const message = formatSsotAdvisory(advisories)
    await ctx.mark({
      ssot_touched_files: accumulated,
      ssot_advisory: message,
    })
    if (!message) return
    out.output = `${out.output || ""}\n\n${message}`
    await ctx.seen("ssot.drift_advisory", {
      sets: advisories.map((item) => item.set.id),
      touched: accumulated,
    })
  }

  return { afterMutatingTool }
}

export function pendingSsotAdvisory(data: Record<string, unknown>) {
  return str(data.ssot_advisory)
}
