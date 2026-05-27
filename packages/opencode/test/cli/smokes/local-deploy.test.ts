import { describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { existsSync, mkdtempSync, readlinkSync, rmSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import path from "node:path"

const entrypoint = path.join(homedir(), ".local/bin/opencode")
const liveWrapper = path.join(homedir(), ".local/bin/opencode-live-guardrails-wrapper")
const repo = path.resolve(import.meta.dir, "../../../../..")
const guardrailsProfile = path.join(repo, "packages/guardrails/profile")
const localDeployTest = existsSync(entrypoint) && existsSync(liveWrapper) ? test : test.skip

function runLocal(args: string[], cwd: string) {
  const env = { ...process.env }
  for (const key of [
    "OPENCODE_CONFIG",
    "OPENCODE_CONFIG_CONTENT",
    "OPENCODE_CONFIG_DIR",
    "OPENCODE_PURE",
    "TERM_PROGRAM",
    "TERM_PROGRAM_VERSION",
  ]) {
    delete env[key]
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

  localDeployTest("runs a read-only command through the guardrails profile and cwd .env", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "opencode-local-deploy-"))
    try {
      writeFileSync(path.join(dir, ".env"), "TERM_PROGRAM=opencode-local-env-smoke\n")

      const result = runLocal(["debug", "info"], dir)
      expect(result.status, result.stderr.toString()).toBe(0)
      expect(result.stdout).toContain("terminal: opencode-local-env-smoke")
      expect(result.stdout).toContain(path.join(guardrailsProfile, "plugins/guardrail.ts"))
      expect(result.stdout).toContain(path.join(guardrailsProfile, "plugins/team.ts"))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
