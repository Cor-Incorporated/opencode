import { expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const bin = fileURLToPath(new URL("../../bin/opencode-guardrails", import.meta.url))

test("explicit JavaScript CLI paths run through Node without executable permission", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "guardrails-launcher-"))
  try {
    for (const extension of ["js", "mjs", "cjs"]) {
      const target = path.join(dir, `cli.${extension}`)
      writeFileSync(
        target,
        "process.stdout.write(JSON.stringify({ args: process.argv.slice(2), binary: process.env.OPENCODE_BIN_PATH }))",
        { mode: 0o600 },
      )
      const run = Bun.spawnSync(["node", bin, "models"], {
        cwd: dir,
        env: { PATH: process.env.PATH, HOME: dir, USERPROFILE: dir, OPENCODE_BIN_PATH: target },
      })
      expect(run.exitCode, new TextDecoder().decode(run.stderr)).toBe(0)
      expect(JSON.parse(new TextDecoder().decode(run.stdout))).toEqual({
        args: ["models", "--standalone"],
        ...(extension === "cjs" ? {} : { binary: target }),
      })
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("a native CLI executable keeps its original arguments", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "guardrails-launcher-native-"))
  try {
    const target = Bun.which("node")
    expect(target).toBeTruthy()
    const run = Bun.spawnSync(["node", bin, "--version"], {
      cwd: dir,
      env: { PATH: process.env.PATH, HOME: dir, USERPROFILE: dir, OPENCODE_BIN_PATH: target! },
    })
    expect(run.exitCode, new TextDecoder().decode(run.stderr)).toBe(0)
    expect(new TextDecoder().decode(run.stdout)).toMatch(/^v\d+\.\d+\.\d+/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
