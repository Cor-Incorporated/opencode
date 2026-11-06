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
import fs from "node:fs"

/** The bytes to hand `run` on stdin, or undefined to let the CLI inherit the launcher's stdin. */
export async function runInput(args, env = process.env) {
  if (args.find((a) => !a.startsWith("-")) !== "run" || !fs.fstatSync(0).isSocket()) return
  const wait = Number(env.OPENCODE_GUARDRAILS_STDIN_WAIT_MS || Number.NaN)
  const waitMs = Number.isInteger(wait) && wait >= 0 ? wait : 1000
  const input = await readStdin(waitMs)
  if (input) return input
  console.error(
    `opencode-guardrails: stdin is a socket with no input within ${waitMs} ms; running without piped input ` +
      "(OPENCODE_GUARDRAILS_STDIN_WAIT_MS sets the wait)",
  )
  return Buffer.alloc(0)
}

/** stdin to EOF once it starts within waitMs; undefined when neither a byte nor EOF arrives in time. */
function readStdin(waitMs) {
  const chunks = []
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer)
      resolve(Buffer.concat(chunks))
    }
    // pause rather than destroy: a writer that turns up later must not get EPIPE from the launcher itself
    const timer = setTimeout(() => {
      process.stdin.pause()
      resolve(undefined)
    }, waitMs)
    process.stdin.on("data", (chunk) => {
      clearTimeout(timer)
      chunks.push(chunk)
    })
    process.stdin.on("end", done)
    process.stdin.on("error", done)
  })
}
