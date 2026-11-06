// stdin for `opencode run` (kept separate from bin/opencode-guardrails so its contract has its own file and tests).
//
// Upstream `run` reads a non-TTY stdin to EOF before it connects to its server, with no timeout
// (packages/cli/src/run/run.ts `mergeInput(…, process.stdin.isTTY ? undefined : await readStdin())`, 2.0.32 through dev).
// A caller that hands the CLI a socket it never closes — the stdio of a Node/libuv harness (`spawn(…, { stdio: "pipe" })`)
// or of an agent's shell tool — therefore hangs `run` silently: its private server starts and never gets a request. All
// 19 hangs logged on 2026-11-05/06 before the canary carry that fingerprint; a never-closed socketpair reproduces it 4/4,
// /dev/null 0/3. For a socket stdin the launcher reads first: input that starts within OPENCODE_GUARDRAILS_STDIN_WAIT_MS
// (default 1000) is read to EOF and passed on unchanged; no input by then is taken as none coming, and the CLI gets an
// empty stdin. Pipes, files and terminals are left to the CLI, so a slow producer in a shell pipeline is still waited for.
// The hang does not depend on the server, so OPENCODE_GUARDRAILS_ALLOW_SERVICE=1 gets the same handling.
//
// Upstream dev fixed the same hang on 2026-11-05 (anomalyco/opencode#61911, a950fa2741: `readStdinIfReady`, 1000 ms
// grace, applied only when a message argument is given; reported as #42064). No release has it yet (latest is 2.2.5).
// Retire this file once the CLI the launcher runs includes that commit. Unlike upstream, the wait here also applies
// without a message argument; the CLI then stops with "You must provide a message" instead of waiting forever.
import fs from "node:fs"

// setTimeout caps its delay at 2^31 - 1 ms and fires after 1 ms beyond it
const MAX_WAIT_MS = 2 ** 31 - 1

/** The bytes to hand `run` on stdin, or undefined to let the CLI inherit the launcher's stdin. */
export async function runInput(args, env = process.env) {
  if (args.find((a) => !a.startsWith("-")) !== "run") return
  // help / version requests never read stdin (the same set withStandalone leaves alone)
  if (args.some((a) => ["--help", "-h", "--version", "-v", "--completions"].includes(a))) return
  // Windows has no socket stdin (Stats.isSocket() is always false there), and fd 0 may not exist at all
  if (process.platform === "win32" || !fs.fstatSync(0).isSocket()) return
  const wait = Number(env.OPENCODE_GUARDRAILS_STDIN_WAIT_MS || Number.NaN)
  const waitMs = Number.isInteger(wait) && wait >= 0 ? Math.min(wait, MAX_WAIT_MS) : 1000
  const input = await readStdin(waitMs)
  if (input !== undefined) return input
  console.error(
    `opencode-guardrails: stdin is a socket with no input within ${waitMs} ms; running without piped input ` +
      "(OPENCODE_GUARDRAILS_STDIN_WAIT_MS sets the wait)",
  )
  return Buffer.alloc(0)
}

/** stdin to EOF once it starts within waitMs; undefined when neither a byte nor EOF arrives in time. */
function readStdin(waitMs) {
  const chunks = []
  return new Promise((resolve, reject) => {
    // pause rather than destroy: a writer that turns up later must not get EPIPE from the launcher itself
    const timer = setTimeout(() => {
      process.stdin.pause()
      resolve(undefined)
    }, waitMs)
    process.stdin.on("data", (chunk) => {
      clearTimeout(timer)
      chunks.push(chunk)
    })
    process.stdin.on("end", () => {
      clearTimeout(timer)
      resolve(Buffer.concat(chunks))
    })
    // a broken stdin is an error, as it is for upstream's `text(process.stdin)`, not a shorter prompt
    process.stdin.on("error", (error) => {
      clearTimeout(timer)
      reject(error)
    })
  })
}
