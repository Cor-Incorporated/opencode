// Compatibility bridge for the legacy auth.json store. Only a key explicitly
// saved under `zai-coding-plan` may supply ZHIPU_API_KEY: Z.AI's Standard and
// Coding Plan keys have separate scopes, even though both catalog lanes name
// the same environment variable. Promoting a plain `zai` Standard key can
// produce error 1113 on a correctly selected Coding Plan endpoint.
//
// Same delivery shape as cor-local-env.js: imported by bin/opencode-guardrails,
// the one entry point guaranteed to run before every invocation (managed
// deploy, the live wrapper, and a direct call alike), and split into its own
// file so it can be `import`-ed and unit tested without triggering the bin
// script's unconditional `spawnSync` of opencode itself. A caller-supplied
// non-empty ZHIPU_API_KEY is left unchanged. Native 2.x credential selection
// remains the CLI's responsibility; its active saved credential can take
// precedence over this environment fallback. This helper never reads its DB.
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

export const ZAI_ENV_KEY = "ZHIPU_API_KEY"

// Same conservative charset as cor-local-env.js's VALID_KEY_RE: a key with a
// quote, backslash, or newline is almost certainly a mis-paste, and env vars
// flow into spawnSync envs and logs -- reject rather than propagate.
export const VALID_ZAI_KEY_RE = /^[A-Za-z0-9._~+/=-]+$/

// The legacy auth file follows xdg-basedir semantics: XDG_DATA_HOME when set,
// else ~/.local/share. Native 2.x credentials are stored separately by the CLI.
export function defaultAuthFile(env) {
  const xdgData = env.XDG_DATA_HOME || path.join(env.HOME ?? os.homedir(), ".local", "share")
  return path.join(xdgData, "opencode", "auth.json")
}

/**
 * Extracts only the declared Coding Plan key from the legacy auth store shape
 * (`{ "zai-coding-plan": { type: "api", key: "..." } }`). A plain `zai`
 * entry is never a fallback, including when the Coding Plan entry is invalid.
 */
export function extractZaiKey(auth) {
  const entry = auth?.["zai-coding-plan"]
  if (entry?.type !== "api") return undefined
  if (typeof entry.key !== "string" || !VALID_ZAI_KEY_RE.test(entry.key)) return undefined
  return entry.key
}

function readAuthStore(env, authFile, warn) {
  // Preserve the legacy OPENCODE_AUTH_CONTENT-over-file contract. Invalid JSON
  // falls through to the file; this is not a native 2.x credential override.
  if (env.OPENCODE_AUTH_CONTENT) {
    try {
      return JSON.parse(env.OPENCODE_AUTH_CONTENT)
    } catch {}
  }
  const file = authFile ?? defaultAuthFile(env)
  let raw
  try {
    raw = fs.readFileSync(file, "utf-8")
  } catch {
    return undefined
  }
  try {
    return JSON.parse(raw)
  } catch {
    warn("zai-auth: auth store ignored (invalid JSON)")
    return undefined
  }
}

/**
 * Mutates `env` (defaults to `process.env`) in place: when ZHIPU_API_KEY is
 * unset or empty, reads the legacy auth store and exports only its declared
 * zai-coding-plan API key as ZHIPU_API_KEY. Never overrides a caller-supplied
 * non-empty value and never logs the key.
 */
export function applyZaiAuthDefaults(env = process.env, { authFile, warn = (msg) => console.error(msg) } = {}) {
  if (env[ZAI_ENV_KEY]) return
  const key = extractZaiKey(readAuthStore(env, authFile, warn))
  if (key) env[ZAI_ENV_KEY] = key
}
