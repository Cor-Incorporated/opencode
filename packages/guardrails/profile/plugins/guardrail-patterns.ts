import path from "path"

export const sec = [
  /(^|\/)\.env($|\.)/i,
  /(^|\/).*\.pem$/i,
  /(^|\/).*\.key$/i,
  /(^|\/).*\.p12$/i,
  /(^|\/).*\.pfx$/i,
  /(^|\/).*\.crt$/i,
  /(^|\/).*\.cer$/i,
  /(^|\/).*\.der$/i,
  /(^|\/).*id_rsa.*$/i,
  /(^|\/).*id_ed25519.*$/i,
  /(^|\/).*credentials.*$/i,
]

export const cfg = [
  /(^|\/)eslint\.config\.[^/]+$/i,
  /(^|\/)\.eslintrc(\.[^/]+)?$/i,
  /(^|\/)biome\.json(c)?$/i,
  /(^|\/)prettier\.config\.[^/]+$/i,
  /(^|\/)\.prettierrc(\.[^/]+)?$/i,
]

export const mut = [
  /\brm\s+/i,
  /\bmv\s+/i,
  /\bcp\s+/i,
  /\bchmod\b/i,
  /\bchown\b/i,
  /\btouch\b/i,
  /\btruncate\b/i,
  /\btee\b/i,
  /\bsed\s+-i\b/i,
  /\bperl\s+-pi\b/i,
  /\s>\s*[\/~$._a-zA-Z]|^>/,
]

export const MUTATING_TOOLS = new Set(["edit", "write", "apply_patch", "multiedit"])

export const src = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".py",
  ".go",
  ".rs",
  ".swift",
  ".kt",
  ".java",
  ".rb",
  ".php",
  ".vue",
  ".svelte",
  ".css",
  ".scss",
  ".sql",
  ".prisma",
  ".graphql",
  ".sh",
])

export const paid: Record<string, Set<string>> = {
  "zai-coding-plan": new Set([
    "glm-4.5",
    "glm-4.5-air",
    "glm-4.5-flash",
    "glm-4.5v",
    "glm-4.6",
    "glm-4.6v",
    "glm-4.7",
    "glm-4.7-flash",
    "glm-4.7-flashx",
    "glm-5",
    "glm-5-turbo",
    "glm-5.1",
  ]),
  openai: new Set([
    "gpt-5.1-codex",
    "gpt-5.1-codex-max",
    "gpt-5.1-codex-mini",
    "gpt-5.2",
    "gpt-5.2-codex",
    "gpt-5.3-codex",
    "gpt-5.5",
    "gpt-5.5-mini",
  ]),
}

export const secEnvExempt = /\.env\.(example|sample|template)$/i

export function norm(file: string) {
  return path.resolve(file).replaceAll("\\", "/")
}

export function rel(root: string, file: string) {
  const abs = norm(file)
  const dir = norm(root)
  if (!abs.startsWith(dir + "/")) return abs
  return abs.slice(dir.length + 1)
}

export function has(file: string, list: RegExp[]) {
  if (list === sec && secEnvExempt.test(file)) return false
  return list.some((item) => item.test(file))
}

export function ext(file: string) {
  return path.extname(file).toLowerCase()
}

export function stash(file: string) {
  return Bun.file(file)
    .json()
    .catch(() => ({} as Record<string, unknown>))
}

export async function save(file: string, data: Record<string, unknown>) {
  await Bun.write(file, JSON.stringify(data, null, 2) + "\n")
}

export async function line(file: string, data: Record<string, unknown>) {
  const prev = await Bun.file(file).text().catch(() => "")
  await Bun.write(file, prev + JSON.stringify(data) + "\n")
}

export function text(err: string) {
  return `Guardrail policy blocked this action: ${err}`
}

export function pick(args: unknown) {
  if (!args || typeof args !== "object") return
  if ("filePath" in args && typeof args.filePath === "string") return args.filePath
}

export function bash(cmd: string) {
  return mut.some((item) => item.test(cmd))
}

export function list(data: unknown) {
  return Array.isArray(data) ? data.filter((item): item is string => typeof item === "string" && item !== "") : []
}

export function num(data: unknown) {
  return typeof data === "number" && Number.isFinite(data) ? data : 0
}

export function flag(data: unknown) {
  return data === true
}

export function str(data: unknown) {
  return typeof data === "string" ? data : ""
}

export function json(data: unknown): Record<string, number> {
  if (data && typeof data === "object" && !Array.isArray(data)) return data as Record<string, number>
  return {}
}

export async function git(dir: string, args: string[]) {
  const proc = Bun.spawn(["git", "-C", dir, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { stdout, stderr, code }
}

export function free(data: {
  id?: unknown
  providerID?: unknown
  cost?: {
    input?: number
    output?: number
    cache?: { read?: number; write?: number }
  }
}) {
  const inCost = data.cost?.input ?? 0
  const outCost = data.cost?.output ?? 0
  const readCost = data.cost?.cache?.read ?? 0
  const writeCost = data.cost?.cache?.write ?? 0
  if (!(inCost === 0 && outCost === 0 && readCost === 0 && writeCost === 0)) return false
  const ids = paid[str(data.providerID)]
  return !(ids && ids.has(str(data.id)))
}

export function preview(data: {
  id?: unknown
  status?: unknown
}) {
  const id = str(data.id)
  const status = str(data.status)
  if (status && status !== "active") return true
  return /(preview|alpha|beta|exp|experimental|:free\b|\bfree\b)/i.test(id)
}

export function vers(text: string) {
  return [...text.matchAll(/\bv?\d+\.\d+\.\d+\b/g)].map((item) => item[0]).slice(0, 8)
}

export function semver(text: string) {
  const hit = text.match(/^v?(\d+)\.(\d+)\.(\d+)$/)
  if (!hit) return
  return hit.slice(1).map((item) => Number(item))
}

export function cmp(left: string, right: string) {
  const a = semver(left)
  const b = semver(right)
  if (!a || !b) return 0
  if (a[0] !== b[0]) return a[0] - b[0]
  if (a[1] !== b[1]) return a[1] - b[1]
  return a[2] - b[2]
}

