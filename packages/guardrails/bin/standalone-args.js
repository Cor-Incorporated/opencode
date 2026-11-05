// Argument rewrite for bin/opencode-guardrails (kept separate so tests can import it without launching the CLI).
import { spawnSync } from "node:child_process"
import { stripVTControlCharacters } from "node:util"
import { cliCommand } from "./cli-command.js"

const direct = ["run", "models", "stats", "mini", "api", "reload"]
const nested = {
  auth: ["list", "login", "logout", "export", "import", "switch"],
  session: ["list", "delete", "export", "import"],
}
// Leaves that take --standalone only in some 2.x versions: 2.0.32 rejects it on all of these ("Unrecognized flag:
// --standalone in command opencode mcp list"), 2.2.5 accepts it on all of them. The selected binary's help decides.
// Without the flag, 2.0.32's debug leaves run locally, but its mcp and plugin leaves would use the background
// service, the very thing this launcher prevents, so those stop instead.
const local = ["debug"]
const probed = {
  debug: ["config", "agents"],
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
 * own their server lifecycle stay unchanged. For the debug, mcp and plugin leaves the selected CLI's help determines
 * whether it supports a private server (2.0.32 does not; its debug leaves are local, its mcp and plugin leaves stop).
 * A failed inspection stops rather than attaching to the service.
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
  if (i === -1 || ![...direct, ...pass, ...Object.keys(nested), ...Object.keys(probed)].includes(args[i]))
    return ["--standalone", ...args]
  if (pass.includes(args[i])) return args
  if (direct.includes(args[i])) return [...args.slice(0, i + 1), "--standalone", ...args.slice(i + 1)]
  const j = positional(args, i + 1)
  if (j === -1) return args
  const leaves = probed[args[i]] ?? nested[args[i]]
  if (!leaves.includes(args[j])) return args
  if (probed[args[i]] && !advertises(args[i], args[j], options)) {
    if (local.includes(args[i])) return args
    throw new Error(
      `opencode-guardrails: this CLI cannot run \`${args[i]} ${args[j]}\` on a private server; ` +
        "set OPENCODE_GUARDRAILS_ALLOW_SERVICE=1 to use the background service on purpose",
    )
  }
  return [...args.slice(0, j + 1), "--standalone", ...args.slice(j + 1)]
}

/** Whether the selected CLI's help for `<group> <leaf>` declares --standalone. A failed inspection stops the launch. */
function advertises(group, leaf, options) {
  if (!options.binary) throw new Error(`opencode-guardrails: could not inspect ${group} ${leaf} without a CLI binary`)
  const [command, ...probeArgs] = cliCommand(options.binary, [group, leaf, "--help"])
  const help = spawnSync(command, probeArgs, {
    encoding: "utf8",
    env: options.env,
    timeout: 10000,
    maxBuffer: 256 * 1024,
  })
  if (help.error || help.status !== 0)
    throw new Error(`opencode-guardrails: could not inspect ${group} ${leaf} capabilities`)
  return /^\s*--standalone(?:\s|$)/m.test(stripVTControlCharacters(help.stdout))
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
