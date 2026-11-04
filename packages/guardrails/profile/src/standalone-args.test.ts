/**
 * bin/standalone-args.js: the guardrails launcher always runs the 2.x CLI on a private server, because the background
 * service never receives the profile (OPENCODE_CONFIG_DIR / CONTENT) or the provider keys of the current call.
 * 2026-10-19 live run: `opencode2 run -m openrouter/google/gemini-2.5-flash …` → "Model unavailable" through the
 * service (it listed 0 openrouter models), 385 openrouter models with --standalone.
 */
import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { withStandalone } from "../../bin/standalone-args.js"

describe("withStandalone", () => {
  test("TUI (no args, flags only, or a directory) gets --standalone first", () => {
    expect(withStandalone([])).toEqual(["--standalone"])
    expect(withStandalone(["-c"])).toEqual(["--standalone", "-c"])
    expect(withStandalone(["/some/dir"])).toEqual(["--standalone", "/some/dir"])
  })
  test("subcommands get it right after the subcommand", () => {
    expect(withStandalone(["run", "-m", "openrouter/google/gemini-2.5-flash", "hi"])).toEqual([
      "run",
      "--standalone",
      "-m",
      "openrouter/google/gemini-2.5-flash",
      "hi",
    ])
    expect(withStandalone(["models", "openrouter"])).toEqual(["models", "--standalone", "openrouter"])
  })
  test.each([
    ["auth", "login"],
    ["auth", "list"],
    ["auth", "logout"],
    ["auth", "export"],
    ["auth", "import"],
    ["auth", "switch"],
    ["session", "list"],
    ["session", "delete"],
    ["session", "export"],
    ["session", "import"],
    ["mcp", "list"],
    ["mcp", "auth"],
    ["mcp", "logout"],
    ["plugin", "list"],
    ["plugin", "check"],
    ["plugin", "update"],
  ])("%s %s receives the server flag after the leaf", (group, leaf) => {
    expect(withStandalone([group, leaf, "target"])).toEqual([group, leaf, "--standalone", "target"])
  })
  test.each([
    ["acp"],
    ["serve"],
    ["pair"],
    ["reload", "--server", "http://h"],
    ["mcp", "add", "server", "--", "node", "server.js"],
    ["plugin", "add", "example-plugin"],
    ["plugin", "remove", "example-plugin"],
    ["debug", "paths"],
    ["debug", "heap-dump"],
    ["auth"],
    ["auth", "unknown"],
  ])("commands without standalone support remain unchanged: %j", (...args) => {
    expect(withStandalone(args)).toEqual(args)
  })
  test("reload is a server command, while root flag values and literal arguments are not commands", () => {
    expect(withStandalone(["reload"])).toEqual(["reload", "--standalone"])
    expect(withStandalone(["--log-level", "debug", "models"])).toEqual([
      "--log-level",
      "debug",
      "models",
      "--standalone",
    ])
    expect(withStandalone(["auth", "--log-level", "debug", "list"])).toEqual([
      "auth",
      "--log-level",
      "debug",
      "list",
      "--standalone",
    ])
    expect(withStandalone(["--prompt", "auth", "/some/dir"])).toEqual(["--standalone", "--prompt", "auth", "/some/dir"])
    expect(withStandalone(["run", "--", "--server", "--help"])).toEqual([
      "run",
      "--standalone",
      "--",
      "--server",
      "--help",
    ])
    expect(withStandalone(["--", "run"])).toEqual(["--standalone", "--", "run"])
  })
  test("explicit --server / --standalone, service, upgrade, uninstall, help and version are left alone", () => {
    for (const args of [
      ["run", "--standalone", "x"],
      ["--server", "http://h", "run", "x"],
      ["--server=http://h"],
      ["service", "status"],
      ["upgrade"],
      ["uninstall"],
      ["--version"],
      ["run", "--help"],
    ])
      expect(withStandalone(args)).toEqual(args)
  })
})

describe("launcher argv against the 2.x command help contract (offline)", () => {
  // The installed 2.0.32 debug commands are local; newer CLI versions advertise
  // --standalone for debug config/agents. This stub returns each real help shape
  // and rejects the invalid intermediate-group flag without loading credentials.
  function run(args: string[], debug: "local" | "server" | "color" | "failed", extension: "js" | "mjs" | "cjs" = "mjs") {
    const dir = mkdtempSync(path.join(tmpdir(), "opencode-argv-"))
    try {
      const binary = path.join(dir, `opencode.${extension}`)
      writeFileSync(
        binary,
        `#!/usr/bin/env node
const args = process.argv.slice(2)
if (${JSON.stringify(extension)} === "cjs" && process.env.OPENCODE_BIN_PATH) process.exit(3)
if (args[0] === "debug" && args.at(-1) === "--help") {
  if (${JSON.stringify(debug)} === "failed") process.exit(2)
  process.stdout.write(${JSON.stringify(debug === "server" ? "FLAGS\n  --standalone  Run with a private server\n" : debug === "color" ? "FLAGS\n  \u001b[1m--standalone\u001b[0m  Run with a private server\n" : "GLOBAL FLAGS\n  --print-logs  Print logs (server logs require --standalone)\n")})
  process.exit(0)
}
if (args[0] === "auth" && (args[1] !== "export" || args[2] !== "--standalone")) process.exit(2)
if (args[0] === "debug" && (!["config", "agents"].includes(args[1]) || args.includes("--standalone") !== ${debug === "server" || debug === "color"})) process.exit(2)
process.stdout.write(JSON.stringify(args))
`,
        { mode: 0o600 },
      )
      const result = Bun.spawnSync(
        ["node", fileURLToPath(new URL("../../bin/opencode-guardrails", import.meta.url)), ...args],
        {
          cwd: dir,
          env: {
            PATH: process.env.PATH,
            HOME: dir,
            XDG_DATA_HOME: dir,
            OPENCODE_BIN_PATH: binary,
            OPENCODE_DISABLE_MODELS_FETCH: "1",
          },
        },
      )
      return { code: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  test("auth export reaches the leaf parser on the actual launcher entry point", () => {
    const result = run(["auth", "export"], "local")
    expect(result.code, result.stderr).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual(["auth", "export", "--standalone"])
  })
  test.each(["local", "server", "color"] as const)("debug config honors the %s CLI capability", (capability) => {
    const result = run(["debug", "config"], capability)
    expect(result.code, result.stderr).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual(
      capability !== "local" ? ["debug", "config", "--standalone"] : ["debug", "config"],
    )
  })
  for (const leaf of ["config", "agents"]) {
    test.each(["js", "mjs", "cjs"] as const)(`debug ${leaf} probe executes a non-executable .%s shim through Node`, (extension) => {
      const result = run(["debug", leaf], "server", extension)
      expect(result.code, result.stderr).toBe(0)
      expect(JSON.parse(result.stdout)).toEqual(["debug", leaf, "--standalone"])
    })
  }
  test("failed capability inspection stops instead of using the background service", () => {
    const result = run(["debug", "config"], "failed")
    expect(result.code).not.toBe(0)
    expect(result.stdout).toBe("")
    expect(result.stderr).toContain("could not inspect debug config")
  })
})
