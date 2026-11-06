/**
 * `opencode run` with a socket stdin nobody closes (bin/run-stdin.js).
 *
 * Upstream `run` reads a non-TTY stdin to EOF before it connects to its server, with no timeout. The stub CLI below
 * does the same (`text(process.stdin)` for `run`), so a launcher that hands it a never-closed socket hangs exactly as
 * the real CLI does. The driver spawns the launcher from real Node with `stdio: "pipe"` — a libuv socketpair, the
 * stdio an agent harness or `child_process` caller gives a child — and kills the launcher's process group after 3 s.
 * Offline; no real CLI, credentials or model calls.
 */
import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const bin = fileURLToPath(new URL("../../bin/opencode-guardrails", import.meta.url))

const cli = `
import { text } from "node:stream/consumers"
if (process.env.STUB_EXIT) process.exit(Number(process.env.STUB_EXIT))
const args = process.argv.slice(2)
const reads = args[0] === "run" && !args.includes("--help") && !process.stdin.isTTY
const piped = reads ? await text(process.stdin) : null
process.stdout.write(JSON.stringify({ args, piped }))
`

// <mode> <launcher> <args...>; modes: open (never written or closed), eof (closed at once), data, big (4 MiB),
// slow-end (written at once, closed later), late (written and closed after 1 s)
const driver = `
import { spawn, spawnSync } from "node:child_process"
const [mode, launcher, ...args] = process.argv.slice(2)
const probe = spawnSync(process.execPath, ["-e", "process.stdout.write(String(require('node:fs').fstatSync(0).isSocket()))"], { stdio: ["pipe", "pipe", "inherit"] })
const child = spawn(process.execPath, [launcher, ...args], { stdio: ["pipe", "pipe", "pipe"], detached: true })
let stdout = ""
let stderr = ""
child.stdout.on("data", (chunk) => (stdout += chunk))
child.stderr.on("data", (chunk) => (stderr += chunk))
child.stdin.on("error", () => {})
if (mode === "eof") child.stdin.end()
if (mode === "data") child.stdin.end("piped text")
if (mode === "big") child.stdin.end("x".repeat(4 * 1024 * 1024))
if (mode === "slow-end") {
  child.stdin.write("piped ")
  setTimeout(() => child.stdin.end("text"), 600)
}
if (mode === "late") setTimeout(() => child.stdin.end("late text"), 1000)
const killer = setTimeout(() => process.kill(-child.pid, "SIGKILL"), 3000)
child.on("close", (code, signal) => {
  clearTimeout(killer)
  process.stdout.write(JSON.stringify({ socket: probe.stdout.toString() === "true", code, signal, stdout, stderr }))
  process.exit(0)
})
`

function launch(mode: string, args: string[], env: Record<string, string>) {
  const dir = mkdtempSync(path.join(tmpdir(), "guardrails-run-stdin-"))
  try {
    writeFileSync(path.join(dir, "cli.mjs"), cli, { mode: 0o600 })
    writeFileSync(path.join(dir, "driver.mjs"), driver, { mode: 0o600 })
    const run = Bun.spawnSync(["node", path.join(dir, "driver.mjs"), mode, bin, ...args], {
      cwd: dir,
      timeout: 8_000,
      env: {
        PATH: process.env.PATH,
        HOME: dir,
        USERPROFILE: dir,
        OPENCODE_BIN_PATH: path.join(dir, "cli.mjs"),
        ...env,
      },
    })
    const result = JSON.parse(new TextDecoder().decode(run.stdout)) as {
      socket: boolean
      code: number | null
      signal: string | null
      stdout: string
      stderr: string
    }
    return {
      ...result,
      cli: result.code === 0 ? (JSON.parse(result.stdout) as { args: string[]; piped: string | null }) : undefined,
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// A regression hangs until the driver kills the launcher at 3 s, past bun's 5 s default once spawns are added.
const HANG = 10_000

// libuv socketpair stdio and POSIX sh are what these cases exercise; the guardrails job runs on ubuntu-latest.
describe.skipIf(process.platform === "win32")("run with a socket stdin", () => {
  test(
    "a socket nobody closes no longer hangs run: the CLI gets an empty stdin and the launcher says so",
    () => {
      const result = launch("open", ["run", "hi"], { OPENCODE_GUARDRAILS_STDIN_WAIT_MS: "200" })
      expect(result.socket).toBe(true)
      expect(result.signal, result.stderr).toBeNull()
      expect(result.code, result.stderr).toBe(0)
      expect(result.cli).toEqual({ args: ["run", "--standalone", "hi"], piped: "" })
      expect(result.stderr).toContain("no input within 200 ms")
    },
    HANG,
  )

  test("input written to the socket reaches the CLI unchanged", () => {
    const result = launch("data", ["run", "hi"], { OPENCODE_GUARDRAILS_STDIN_WAIT_MS: "200" })
    expect(result.code, result.stderr).toBe(0)
    expect(result.cli?.piped).toBe("piped text")
    expect(result.stderr).toBe("")
  })

  test("once input starts, it is read to EOF however long the writer takes to close", () => {
    const result = launch("slow-end", ["run", "hi"], { OPENCODE_GUARDRAILS_STDIN_WAIT_MS: "200" })
    expect(result.code, result.stderr).toBe(0)
    expect(result.cli?.piped).toBe("piped text")
  })

  test("input that starts after the wait is not passed on, and the launcher says so", () => {
    const result = launch("late", ["run", "hi"], { OPENCODE_GUARDRAILS_STDIN_WAIT_MS: "200" })
    expect(result.code, result.stderr).toBe(0)
    expect(result.cli?.piped).toBe("")
    expect(result.stderr).toContain("OPENCODE_GUARDRAILS_STDIN_WAIT_MS")
  })

  test(
    "a stdin already at EOF is passed on as empty, without waiting or a notice",
    () => {
      const result = launch("eof", ["run", "hi"], { OPENCODE_GUARDRAILS_STDIN_WAIT_MS: "20000" })
      expect(result.signal, result.stderr).toBeNull()
      expect(result.cli?.piped).toBe("")
      expect(result.stderr).toBe("")
    },
    HANG,
  )

  test("a CLI that exits without reading large input keeps its own exit status", () => {
    // more than any socket buffer, so the launcher's write to the exited CLI fails with EPIPE
    const result = launch("big", ["run", "hi"], { STUB_EXIT: "3" })
    expect(result.signal, result.stderr).toBeNull()
    expect(result.code, result.stderr).toBe(3)
    expect(result.stderr).not.toContain("EPIPE")
  })

  test(
    "help requests are not held on stdin",
    () => {
      const result = launch("open", ["run", "--help"], { OPENCODE_GUARDRAILS_STDIN_WAIT_MS: "20000" })
      expect(result.signal, result.stderr).toBeNull()
      expect(result.cli).toEqual({ args: ["run", "--help"], piped: null })
      expect(result.stderr).toBe("")
    },
    HANG,
  )

  test("OPENCODE_GUARDRAILS_ALLOW_SERVICE=1 gets the same handling, since the hang does not depend on the server", () => {
    const result = launch("open", ["run", "hi"], {
      OPENCODE_GUARDRAILS_ALLOW_SERVICE: "1",
      OPENCODE_GUARDRAILS_STDIN_WAIT_MS: "200",
    })
    expect(result.code, result.stderr).toBe(0)
    expect(result.cli).toEqual({ args: ["run", "hi"], piped: "" })
  })

  test(
    "other commands keep the inherited stdin and do not wait on it",
    () => {
      const result = launch("open", ["models"], { OPENCODE_GUARDRAILS_STDIN_WAIT_MS: "20000" })
      expect(result.signal, result.stderr).toBeNull()
      expect(result.cli).toEqual({ args: ["models", "--standalone"], piped: null })
    },
    HANG,
  )

  test("a pipe stdin is left to the CLI, so a slow producer is still waited for", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "guardrails-run-pipe-"))
    try {
      writeFileSync(path.join(dir, "cli.mjs"), cli, { mode: 0o600 })
      const run = Bun.spawnSync(["sh", "-c", `(sleep 1; printf 'late text') | node "${bin}" run hi`], {
        cwd: dir,
        timeout: 8_000,
        env: {
          PATH: process.env.PATH,
          HOME: dir,
          USERPROFILE: dir,
          OPENCODE_BIN_PATH: path.join(dir, "cli.mjs"),
          OPENCODE_GUARDRAILS_STDIN_WAIT_MS: "200",
        },
      })
      expect(run.exitCode, new TextDecoder().decode(run.stderr)).toBe(0)
      expect(JSON.parse(new TextDecoder().decode(run.stdout))).toEqual({
        args: ["run", "--standalone", "hi"],
        piped: "late text",
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
