// Argument rewrite for bin/opencode-guardrails (kept separate so tests can import it without launching the CLI).

/**
 * Always run on a private server (`--standalone`). In 2.x the TUI and `run` otherwise attach to the background service,
 * a long-lived process started earlier with *its own* environment and config: the profile (OPENCODE_CONFIG_DIR /
 * OPENCODE_CONFIG_CONTENT) and the provider keys injected for this call (e.g. `bw-secrets run …`) never reach it, so
 * the guardrail plugins are not loaded and the model is "unavailable" (2026-10-19, owner's live run). The flag goes
 * right after the subcommand (or first, for the TUI). Left alone: an explicit --server / --standalone, the service
 * commands themselves, upgrade / uninstall, and help / version / completion requests.
 */
export function withStandalone(args) {
  if (args.some((a) => a === "--standalone" || a === "--server" || a.startsWith("--server="))) return args
  if (args.some((a) => ["--help", "-h", "--version", "-v", "--completions"].includes(a))) return args
  const SUBCOMMANDS = ["run", "models", "stats", "session", "mcp", "auth", "plugin", "debug", "acp", "mini", "api", "service", "upgrade", "update", "uninstall"]
  const PASS = ["service", "upgrade", "update", "uninstall"]
  const i = args.findIndex((a) => !a.startsWith("-"))
  if (i === -1 || !SUBCOMMANDS.includes(args[i])) return ["--standalone", ...args] // TUI (optionally with a directory)
  if (PASS.includes(args[i])) return args
  return [...args.slice(0, i + 1), "--standalone", ...args.slice(i + 1)]
}
