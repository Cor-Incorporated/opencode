/**
 * bin/standalone-args.js: the guardrails launcher always runs the 2.x CLI on a private server, because the background
 * service never receives the profile (OPENCODE_CONFIG_DIR / CONTENT) or the provider keys of the current call.
 * 2026-10-19 live run: `opencode2 run -m openrouter/google/gemini-2.5-flash …` → "Model unavailable" through the
 * service (it listed 0 openrouter models), 385 openrouter models with --standalone.
 */
import { describe, expect, test } from "bun:test"
import { withStandalone } from "../../bin/standalone-args.js"

describe("withStandalone", () => {
  test("TUI (no args, flags only, or a directory) gets --standalone first", () => {
    expect(withStandalone([])).toEqual(["--standalone"])
    expect(withStandalone(["-c"])).toEqual(["--standalone", "-c"])
    expect(withStandalone(["/some/dir"])).toEqual(["--standalone", "/some/dir"])
  })
  test("subcommands get it right after the subcommand", () => {
    expect(withStandalone(["run", "-m", "openrouter/google/gemini-2.5-flash", "hi"])).toEqual(["run", "--standalone", "-m", "openrouter/google/gemini-2.5-flash", "hi"])
    expect(withStandalone(["models", "openrouter"])).toEqual(["models", "--standalone", "openrouter"])
    expect(withStandalone(["auth", "login"])).toEqual(["auth", "--standalone", "login"])
  })
  test("explicit --server / --standalone, service, upgrade, uninstall, help and version are left alone", () => {
    for (const args of [["run", "--standalone", "x"], ["--server", "http://h", "run", "x"], ["--server=http://h"], ["service", "status"], ["upgrade"], ["uninstall"], ["--version"], ["run", "--help"]])
      expect(withStandalone(args)).toEqual(args)
  })
})
