// Argument rewrite for bin/opencode-guardrails (kept separate so tests can import it without launching the CLI).
import { spawnSync } from "node:child_process"
import { stripVTControlCharacters } from "node:util"

const direct = ["run", "models", "stats", "mini", "api", "reload"]
const nested = {
  auth: ["list", "login", "logout", "export", "import", "switch"],
  session: ["list", "delete", "export", "import"],
  mcp: ["list", "auth", "logout"],
  plugin: ["list", "check", "update"],
}
const pass = ["service", "upgrade", "update", "uninstall", "acp", "serve", "pair"]
const values = ["--log-level", "--session", "-s", "--prompt"]

/**
 * Always run on a private server (`--standalone`). In 2.x the TUI and `run` otherwise attach to the background service,
 * a long-lived process started earlier with *its own* environment and config: the profile (OPENCODE_CONFIG_DIR /
 * OPENCODE_CONFIG_CONTENT) and the provider keys injected for this call (e.g. `bw-secrets run …`) never reach it, so
 * the guardrail plugins are not loaded and the model is "unavailable" (2026-10-19, owner's live run). The flag goes
 * after the command that owns the flag (or first, for the TUI). Local configuration commands and commands that
 * own their server lifecycle stay unchanged. Older 2.x debug commands are local; their help determines whether
 * the selected CLI supports a private server. A failed inspection stops rather than attaching to the service.
 */
export function withStandalone(args, options = {}) {
  const flags = args.includes("--") ? args.slice(0, args.indexOf("--")) : args
  if (
    flags.some(
      (a) => a === "--standalone" || a.startsWith("--standalone=") || a === "--server" || a.startsWith("--server="),
    )
  )
    return args
  if (
    flags.some(
      (a) => ["--help", "-h", "--version", "-v", "--completions"].includes(a) || a.startsWith("--completions="),
    )
  )
    return args
  const i = positional(args)
  if (i === -1 || ![...direct, ...pass, ...Object.keys(nested), "debug"].includes(args[i]))
    return ["--standalone", ...args]
  if (pass.includes(args[i])) return args
  if (direct.includes(args[i])) return [...args.slice(0, i + 1), "--standalone", ...args.slice(i + 1)]
  const j = positional(args, i + 1)
  if (j === -1) return args
  if (args[i] === "debug") {
    if (!["config", "agents"].includes(args[j])) return args
    if (!options.binary) throw new Error(`opencode-guardrails: could not inspect debug ${args[j]} without a CLI binary`)
    const help = spawnSync(options.binary, ["debug", args[j], "--help"], {
      encoding: "utf8",
      env: options.env,
      timeout: 10000,
      maxBuffer: 256 * 1024,
    })
    if (help.error || help.status !== 0)
      throw new Error(`opencode-guardrails: could not inspect debug ${args[j]} capabilities`)
    if (!/^\s*--standalone(?:\s|$)/m.test(stripVTControlCharacters(help.stdout))) return args
  }
  if (args[i] !== "debug" && !nested[args[i]].includes(args[j])) return args
  return [...args.slice(0, j + 1), "--standalone", ...args.slice(j + 1)]
}

function positional(args, start = 0) {
  for (let i = start; i < args.length; i++) {
    if (args[i] === "--") return -1
    if (values.includes(args[i])) {
      i++
      continue
    }
    if (!args[i].startsWith("-")) return i
  }
  return -1
}
