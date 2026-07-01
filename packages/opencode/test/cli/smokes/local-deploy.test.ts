import { describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { homedir, tmpdir } from "node:os"
import path from "node:path"

const entrypoint = path.join(homedir(), ".local/bin/opencode")
const liveWrapper = path.join(homedir(), ".local/bin/opencode-live-guardrails-wrapper")
const liveWrapperManifest = `${liveWrapper}.json`
const repoRoot = path.resolve(import.meta.dir, "../../../../..")
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

function runLocalDeployScript(args: string[], overrides: Record<string, string>) {
  return spawnSync("bash", [path.join(repoRoot, "scripts/local-dev-deploy.sh"), ...args], {
    cwd: repoRoot,
    env: { ...process.env, ...overrides },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 30_000,
  })
}

function readWrapperManifest() {
  const manifest = JSON.parse(readFileSync(liveWrapperManifest, "utf8")) as unknown
  expect(isRecord(manifest), `${liveWrapperManifest} should contain a JSON object`).toBe(true)
  return manifest as Record<string, unknown>
}

function stringField(manifest: Record<string, unknown>, keys: string[]) {
  const value = keys.map((key) => manifest[key]).find((item): item is string => typeof item === "string")
  expect(value, `manifest should include one of: ${keys.join(", ")}`).toBeDefined()
  expect(value!.length, `manifest field ${keys.join("/")} should not be empty`).toBeGreaterThan(0)
  return value!
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

describe("deployed local opencode (smoke)", () => {
  localDeployTest("entrypoint points at the guardrails live wrapper", () => {
    expect(readlinkSync(entrypoint)).toBe(liveWrapper)
  })

  localDeployTest("writes a wrapper manifest with the pinned local runtime targets", () => {
    expect(existsSync(liveWrapperManifest)).toBe(true)

    const manifest = readWrapperManifest()
    const activeBinary = stringField(manifest, ["activeBinary", "active_binary"])
    const guardrailsBin = stringField(manifest, ["guardrailsBin", "guardrails_bin"])
    const pinnedRepoRoot = stringField(manifest, ["repoRoot", "repo_root"])
    const localDatabase = stringField(manifest, ["localDatabase", "local_database", "localDb", "local_db"])
    const localGuardrailsProfile = stringField(manifest, ["localGuardrailsProfile", "local_guardrails_profile"])

    expect(path.isAbsolute(activeBinary)).toBe(true)
    expect(path.isAbsolute(guardrailsBin)).toBe(true)
    expect(path.isAbsolute(pinnedRepoRoot)).toBe(true)
    expect(path.isAbsolute(localGuardrailsProfile)).toBe(true)
    expect(localDatabase).toContain("opencode-local.db")
    expect(localGuardrailsProfile).toBe(path.join(pinnedRepoRoot, "packages/guardrails/profile"))
  })

  localDeployTest("wrapper manifest does not point at a deleted worktree", () => {
    const manifest = readWrapperManifest()
    const activeBinary = path.resolve(stringField(manifest, ["activeBinary", "active_binary"]))
    const guardrailsBin = path.resolve(stringField(manifest, ["guardrailsBin", "guardrails_bin"]))
    const pinnedRepoRoot = path.resolve(stringField(manifest, ["repoRoot", "repo_root"]))

    expect(existsSync(path.join(pinnedRepoRoot, "scripts/local-dev-deploy.sh"))).toBe(true)
    expect(existsSync(activeBinary), `manifest active binary should exist: ${activeBinary}`).toBe(true)
    expect(existsSync(guardrailsBin), `manifest guardrails bin should exist: ${guardrailsBin}`).toBe(true)
    expect(activeBinary.startsWith(path.join(pinnedRepoRoot, "packages/opencode/dist") + path.sep)).toBe(true)
    expect(guardrailsBin).toBe(path.join(pinnedRepoRoot, "packages/guardrails/bin/opencode-guardrails"))
  })

  localDeployTest("local pinned-wrapper assertion allows unrelated deletion targets", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "opencode-local-unpinned-worktree-"))
    try {
      const result = spawnSync(process.execPath, ["run", "local:assert-not-pinned", "--", dir], {
        cwd: repoRoot,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 30_000,
      })
      expect(result.status, `${result.stdout}${result.stderr}`).toBe(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("local pinned-wrapper assertion rejects stale manifest when wrapper still references target", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "opencode-local-stale-manifest-"))
    try {
      const target = path.join(dir, "worktree")
      const bin = path.join(dir, "bin")
      const wrapper = path.join(bin, "opencode-live-guardrails-wrapper")
      const manifest = `${wrapper}.json`
      const entry = path.join(bin, "opencode")
      mkdirSync(target)
      mkdirSync(bin)
      writeFileSync(
        wrapper,
        [
          "#!/bin/zsh",
          `# opencode-local-wrapper-active-binary: ${path.join(target, "packages/opencode/dist/opencode-darwin-arm64/bin/opencode")}`,
          `exec bun ${path.join(target, "packages/guardrails/bin/opencode-guardrails")} "$@"`,
          "",
        ].join("\n"),
      )
      writeFileSync(
        manifest,
        JSON.stringify({
          repo_root: path.join(dir, "old-worktree"),
          active_binary: path.join(dir, "old-worktree/packages/opencode/dist/opencode-darwin-arm64/bin/opencode"),
          guardrails_bin: path.join(dir, "old-worktree/packages/guardrails/bin/opencode-guardrails"),
        }),
      )
      symlinkSync(wrapper, entry)

      const result = runLocalDeployScript(["--assert-not-pinned", target], {
        OPENCODE_LOCAL_ENTRYPOINT: entry,
        OPENCODE_LOCAL_WRAPPER: wrapper,
        OPENCODE_LOCAL_WRAPPER_MANIFEST: manifest,
      })
      expect(result.status).not.toBe(0)
      expect(`${result.stdout}${result.stderr}`).toContain("refusing to remove pinned local opencode worktree")
      expect(`${result.stdout}${result.stderr}`).toContain("wrapper text references")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("local pinned-wrapper assertion rejects entrypoint symlinks inside the deletion target", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "opencode-local-entrypoint-target-"))
    try {
      const target = path.join(dir, "worktree")
      const bin = path.join(dir, "bin")
      const entry = path.join(bin, "opencode")
      mkdirSync(path.join(target, "bin"), { recursive: true })
      mkdirSync(bin)
      writeFileSync(path.join(target, "bin/opencode"), "#!/bin/zsh\n")
      symlinkSync(path.join(target, "bin/opencode"), entry)

      const result = runLocalDeployScript(["--assert-not-pinned", target], {
        OPENCODE_LOCAL_ENTRYPOINT: entry,
        OPENCODE_LOCAL_WRAPPER: path.join(bin, "missing-wrapper"),
        OPENCODE_LOCAL_WRAPPER_MANIFEST: path.join(bin, "missing-wrapper.json"),
      })
      expect(result.status).not.toBe(0)
      expect(`${result.stdout}${result.stderr}`).toContain("refusing to remove pinned local opencode worktree")
      expect(`${result.stdout}${result.stderr}`).toContain("entrypoint symlink")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  localDeployTest("wrapper defaults to a stable local database and preserves explicit database overrides", () => {
    const wrapper = readFileSync(liveWrapper, "utf8")
    expect(wrapper).toContain("OPENCODE_DB=${OPENCODE_DB:-opencode-local.db}")
    expect(wrapper).toContain("OPENCODE_LOCAL_GUARDRAILS_PROFILE=")

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
      expect(result.stdout).not.toContain(".config/opencode/plugins/guardrail.ts")
      expect(result.stdout).not.toContain(".config/opencode/plugins/git-guard.ts")
      expect(result.stdout).not.toContain(".config/opencode/plugins/team.ts")
      expect(result.stdout).not.toContain("plugins/guardrail-git.ts")
      expect(result.stdout).not.toContain("plugins/guardrail-review.ts")
      expect(result.stdout).not.toContain("external plugins disabled")
      expect(result.stdout).not.toContain("plugins: none")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
