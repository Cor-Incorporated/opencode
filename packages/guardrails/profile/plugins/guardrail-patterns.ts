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
  zai: new Set([
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
    "glm-5.2",
    "glm-5.3",
    "glm-5.3-flash",
    "glm-5v-turbo",
  ]),
  "zai-coding-plan": new Set([
    "glm-4.5-air",
    "glm-4.7",
    "glm-5-turbo",
    "glm-5.1",
    "glm-5.2",
    "glm-5.2-highspeed",
    "glm-5.3",
    "glm-5.3-flash",
    "glm-5.3-highspeed",
    "glm-5v-turbo",
  ]),
  openai: new Set([
    "gpt-4",
    "gpt-4-turbo",
    "gpt-4.1",
    "gpt-4.1-mini",
    "gpt-4.1-nano",
    "gpt-4o",
    "gpt-4o-2024-05-13",
    "gpt-4o-2024-08-06",
    "gpt-4o-2024-11-20",
    "gpt-4o-mini",
    "gpt-5",
    "gpt-5-mini",
    "gpt-5-nano",
    "gpt-5-pro",
    "gpt-5.1",
    "gpt-5.1-codex",
    "gpt-5.1-codex-max",
    "gpt-5.1-codex-mini",
    "gpt-5.2",
    "gpt-5.2-chat-latest",
    "gpt-5.2-codex",
    "gpt-5.2-pro",
    "gpt-5.3-chat-latest",
    "gpt-5.3-codex",
    "gpt-5.3-codex-spark",
    "gpt-5.4",
    "gpt-5.4-mini",
    "gpt-5.4-nano",
    "gpt-5.4-pro",
    "gpt-5.5",
    "gpt-5.5-pro",
    "gpt-5.6",
    "gpt-5.6-luna",
    "gpt-5.6-sol",
    "gpt-5.6-terra",
    "gpt-realtime-2.1",
    "o1",
    "o1-pro",
    "o3",
    "o3-mini",
    "o3-pro",
    "o4-mini",
  ]),
  deepseek: new Set([
    "deepseek-chat",
    "deepseek-reasoner",
    "deepseek-v4-flash",
    "deepseek-v4-flash-vision-exp",
    "deepseek-v4-pro",
  ]),
  // cor-local: self-hosted llama-server router (Mac Studio). Cost is always 0 (no
  // billing), but these are not free-tier models — list them here so free() stays
  // false and denyFree does not block the opt-in local lane.
  "cor-local": new Set(["glm53-flash", "deepseek-v4-flash-0731", "qwen3.8-27b"]),
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

/** OC-D1 helpers: path-like tokens only (not whole-command substring matches). */
export function pathLikeToken(token: string): boolean {
  const t = token.replaceAll("\\", "/")
  if (!t || t.startsWith("-")) return false
  if (t.includes("/")) return true
  if (/^\.?[\w.-]+\.[\w.-]+$/.test(t)) return true
  if (/^\.(?:env|pem|key|p12|pfx|crt|cer|der)$/i.test(t)) return true
  if (/^id_(?:rsa|ed25519)/i.test(t)) return true
  return false
}

export function splitShellTokens(cmd: string): string[] {
  const tokens: string[] = []
  let current = ""
  let quote = ""
  let escaped = false
  for (let index = 0; index < cmd.length; index++) {
    const char = cmd[index]
    if (escaped) {
      current += char
      escaped = false
      continue
    }
    if (char === "\\") {
      escaped = true
      continue
    }
    if (quote) {
      if (char === quote) quote = ""
      else current += char
      continue
    }
    if (char === "'" || char === '"') {
      quote = char
      continue
    }
    if (/\s/.test(char)) {
      if (current) {
        tokens.push(current)
        current = ""
      }
      continue
    }
    if (char === ";" || char === "|" || char === "&") {
      if (current) {
        tokens.push(current)
        current = ""
      }
      continue
    }
    current += char
  }
  if (current) tokens.push(current)
  return tokens
}

/** True when a bash command references secret paths as path-like tokens (not as search text). */
export function bashTouchesProtectedSecrets(cmd: string): boolean {
  const tokens = splitShellTokens(cmd)
  if (tokens.length === 0) return false
  const searchTools = new Set(["grep", "egrep", "fgrep", "rg", "find"])
  const skip = new Set<number>()
  for (let i = 0; i < tokens.length; i++) {
    const base = tokens[i].replace(/^.*\//, "")
    if (!searchTools.has(base)) continue
    let j = i + 1
    while (j < tokens.length && tokens[j].startsWith("-")) j++
    if (j < tokens.length) skip.add(j)
  }
  for (let i = 0; i < tokens.length; i++) {
    if (skip.has(i)) continue
    const token = tokens[i].replaceAll("\\", "/")
    if (!pathLikeToken(token)) continue
    if (has(token, sec)) return true
  }
  return false
}

export function ext(file: string) {
  return path.extname(file).toLowerCase()
}

export function stash(file: string) {
  return Bun.file(file)
    .json()
    .catch(() => ({}) as Record<string, unknown>)
}

export async function save(file: string, data: Record<string, unknown>) {
  await Bun.write(file, JSON.stringify(data, null, 2) + "\n")
}

export async function line(file: string, data: Record<string, unknown>) {
  const prev = await Bun.file(file)
    .text()
    .catch(() => "")
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

export function ciChecksGreen(output: string, exitCode: unknown) {
  if (exitCode !== 0) return false
  const text = output.trim()
  if (!text) return false
  const jsonResult = ciChecksJsonGreen(text)
  if (jsonResult !== undefined) return jsonResult
  return ciChecksTextGreen(text)
}

function ciChecksJsonGreen(text: string) {
  if (!/^\s*\[/.test(text)) return undefined
  try {
    const checks = JSON.parse(text) as unknown
    if (!Array.isArray(checks) || checks.length === 0) return false
    return checks.every((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return false
      return str((item as Record<string, unknown>).bucket).toLowerCase() === "pass"
    })
  } catch {
    return false
  }
}

function ciChecksTextGreen(text: string) {
  const rows = text.split(/\r?\n/).filter((line) => line.trim())
  if (rows.length === 0) return false
  return rows.every((line) => str(line.split("\t")[1]).toLowerCase() === "pass")
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

export function preview(data: { id?: unknown; status?: unknown }) {
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
