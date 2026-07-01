import { describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import path from "node:path"

const entrypoint = path.join(homedir(), ".local/bin/opencode")
const liveWrapper = path.join(homedir(), ".local/bin/opencode-live-guardrails-wrapper")
const localDeployTest = existsSync(entrypoint) && existsSync(liveWrapper) ? test : test.skip

function runLocal(args: string[], cwd: string, overrides: Record<string, string | undefined> = {}) {
  const env = { ...process.env }
  for (const key of [
    "OPENCODE_DB",
    "OPENCODE_CONFIG",
    "OPENCODE_CONFIG_CONTENT",
    "OPENCODE_CONFIG_DIR",
    "OPENCODE_PURE",
    "TERM_PROGRAM",
    "TERM_PROGRAM_VERSION",
  ]) {
    delete env[key]
  }
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete env[key]
    else env[key] = value
  }
  return spawnSync(entrypoint, args, {
    cwd,
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 30_000,
  })
}

describe("deployed local opencode (smoke)", () => {
  localDeployTest("entrypoint points at the guardrails live wrapper", () => {
    expect(readlinkSync(entrypoint)).toBe(liveWrapper)
  })

  localDeployTest("wrapper defaults to a stable local database and preserves explicit database overrides", () => {
    expect(readFileSync(liveWrapper, "utf8")).toContain("OPENCODE_DB=${OPENCODE_DB:-opencode-local.db}")

    const dir = mkdtempSync(path.join(tmpdir(), "opencode-local-db-"))
    try {
      const defaultResult = runLocal(["db", "path"], dir, {
        XDG_DATA_HOME: path.join(dir, "data"),
      })
      expect(defaultResult.status, defaultResult.stderr.toString()).toBe(0)
      expect(defaultResult.stdout.trim()).toBe(path.join(dir, "data", "opencode", "opencode-local.db"))

      const explicitDatabase = path.join(dir, "explicit.db")
      const explicitResult = runLocal(["db", "path"], dir, {
        OPENCODE_DB: explicitDatabase,
        XDG_DATA_HOME: path.join(dir, "data"),
      })
      expect(explicitResult.status, explicitResult.stderr.toString()).toBe(0)
      expect(explicitResult.stdout.trim()).toBe(explicitDatabase)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  localDeployTest("runs a read-only command through the guardrails profile and cwd .env", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "opencode-local-deploy-"))
    try {
      writeFileSync(path.join(dir, ".env"), "TERM_PROGRAM=opencode-local-env-smoke\n")

      const result = runLocal(["debug", "info"], dir)
      expect(result.status, result.stderr.toString()).toBe(0)
      expect(result.stdout).toContain("terminal: opencode-local-env-smoke")
      expect(result.stdout).toContain("plugins/guardrail.ts")
      expect(result.stdout).toContain("plugins/team.ts")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
