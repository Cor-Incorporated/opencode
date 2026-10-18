// The guardrails profile admits both Z.AI lanes (`zai` on
// api.z.ai/api/paas/v4 and `zai-coding-plan` on api.z.ai/api/coding/paas/v4)
// via enabled_providers, and both declare the same models.dev env var
// (`ZHIPU_API_KEY`). `opencode auth login` for the coding plan stores the key
// under the `zai-coding-plan` provider id only, so the plain `zai` provider
// stays credential-less: config-defined providers are listed without a key,
// @ai-sdk/openai-compatible then omits the Authorization header entirely, and
// every request fails at the z.ai gateway with code 1001 "Authentication
// parameter not received in Header, unable to authenticate". Z.AI accepts one
// account key on both endpoints (the Coding Plan key returns 200 from
// `GET /api/paas/v4/models`), so the stored key can bridge the gap.
//
// Same delivery shape as cor-local-env.js: imported by bin/opencode-guardrails,
// the one entry point guaranteed to run before every invocation (managed
// deploy, the live wrapper, and a direct call alike), and split into its own
// file so it can be `import`-ed and unit tested without triggering the bin
// script's unconditional `spawnSync` of opencode itself. A caller-supplied
// non-empty ZHIPU_API_KEY, or a direct `opencode auth login` on the `zai`
// provider id, always wins; this bridge only fills the gap.
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

export const ZAI_ENV_KEY = "ZHIPU_API_KEY"

// Same conservative charset as cor-local-env.js's VALID_KEY_RE: a key with a
// quote, backslash, or newline is almost certainly a mis-paste, and env vars
// flow into spawnSync envs and logs -- reject rather than propagate.
export const VALID_ZAI_KEY_RE = /^[A-Za-z0-9._~+/=-]+$/

// xdg-basedir semantics, as used by upstream Global.Path.data
// (packages/core/src/global.ts): XDG_DATA_HOME when set, else
// ~/.local/share.
export function defaultAuthFile(env) {
  const xdgData = env.XDG_DATA_HOME || path.join(env.HOME ?? os.homedir(), ".local", "share")
  return path.join(xdgData, "opencode", "auth.json")
}

/**
 * Extracts the Z.AI API key from opencode's auth store shape
 * (`{ "<providerID>": { type: "api", key: "..." } }`). A direct `zai` entry
 * wins over a shared `zai-coding-plan` entry; anything that is not an
 * `{type:"api"}` entry with a valid-charset key is ignored.
 */
export function extractZaiKey(auth) {
  for (const id of ["zai", "zai-coding-plan"]) {
    const entry = auth?.[id]
    if (entry?.type !== "api") continue
    if (typeof entry.key !== "string" || !VALID_ZAI_KEY_RE.test(entry.key)) continue
    return entry.key
  }
  return undefined
}

function readAuthStore(env, authFile, warn) {
  // OPENCODE_AUTH_CONTENT replaces the file (upstream Auth.all checks it
  // first); a parse failure falls through to the file, as upstream does.
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
 * unset or empty, reads opencode's auth store and exports the stored
 * zai/zai-coding-plan API key as ZHIPU_API_KEY so the credential-less `zai`
 * lane authenticates. Never overrides a caller-supplied non-empty value and
 * never logs the key.
 */
export function applyZaiAuthDefaults(env = process.env, { authFile, warn = (msg) => console.error(msg) } = {}) {
  if (env[ZAI_ENV_KEY]) return
  const key = extractZaiKey(readAuthStore(env, authFile, warn))
  if (key) env[ZAI_ENV_KEY] = key
}
