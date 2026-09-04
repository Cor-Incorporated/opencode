/**
 * Packet A3b: `cor-local`'s `options.baseURL`/`options.apiKey` moved from
 * hardcoded strings to `{env:COR_LOCAL_BASE_URL}`/`{env:COR_LOCAL_API_KEY}`
 * (packages/guardrails/{managed,profile}/opencode.json). `variable.ts`'s
 * `{env:VAR}` substitution resolves an *unset* var to `""` unconditionally --
 * it never errors, regardless of the `missing` option (that only governs
 * `{file:...}`). An empty `baseURL` breaks every existing Mac Studio
 * `cor-local` call (the AI SDK client cannot build a request against `""`),
 * so the deployed live wrapper (`scripts/local-dev-deploy.sh`'s
 * `repair_links` heredoc, installed at
 * `~/.local/bin/opencode-live-guardrails-wrapper`) must supply defaults
 * before opencode ever substitutes the config.
 *
 * This test extracts the *actual* heredoc bytes from
 * `scripts/local-dev-deploy.sh` (not a hand-copied duplicate -- a link test:
 * if the generator changes without updating the defaulting lines, this test
 * re-extracts the current bytes and still catches the regression), replays
 * them through bash's own heredoc engine with placeholder path variables,
 * and sources the result to prove the env-default / key-file-fallback /
 * explicit-override behavior end to end -- without ever touching the real
 * `~/.local/bin` wrapper or the real `~/cluster-ops/cor-local.key`.
 */
import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

const scriptPath = new URL("../../../../scripts/local-dev-deploy.sh", import.meta.url).pathname
const scriptSource = readFileSync(scriptPath, "utf8")

function extractWrapperHeredoc(): string {
  const startMarker = 'cat > "$LIVE_WRAPPER" <<EOF'
  const start = scriptSource.indexOf(startMarker)
  expect(start, "scripts/local-dev-deploy.sh should generate the live wrapper via `cat > \"$LIVE_WRAPPER\" <<EOF`").toBeGreaterThan(-1)
  const bodyStart = scriptSource.indexOf("\n", start) + 1
  const end = scriptSource.indexOf("\nEOF", bodyStart)
  expect(end, "heredoc terminator EOF not found after cat > \"$LIVE_WRAPPER\"").toBeGreaterThan(-1)
  return scriptSource.slice(bodyStart, end)
}

/**
 * Reproduces the heredoc through bash's own engine (placeholder values for
 * the unrelated pinned-path variables), drops the trailing `exec ...` line
 * (we are not launching bun/opencode-guardrails here), then sources the
 * resulting wrapper body under a scratch $HOME so `~/cluster-ops/cor-local.key`
 * resolves to a controllable fixture instead of this machine's real key file.
 */
function renderWrapperEnv(opts: { env?: Record<string, string>; keyFileContent?: string }) {
  const heredocBody = extractWrapperHeredoc()
  const bodyWithoutExec = heredocBody
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("exec "))
    .join("\n")

  const dir = mkdtempSync(path.join(tmpdir(), "cor-local-wrapper-render-"))
  const homeDir = mkdtempSync(path.join(tmpdir(), "cor-local-wrapper-home-"))
  try {
    const outPath = path.join(dir, "wrapper.sh")
    const generatorPath = path.join(dir, "generate.sh")
    const generator = [
      "#!/bin/bash",
      "set -euo pipefail",
      "ROOT=dummy-root",
      "ACTIVE_BINARY=dummy-active-binary",
      "GUARDRAILS_BIN=dummy-guardrails-bin",
      "active_q=dummy-active-q",
      "local_db_q=dummy-local-db-q",
      "profile_q=dummy-profile-q",
      "bun_q=dummy-bun-q",
      "guard_q=dummy-guard-q",
      `LIVE_WRAPPER=${JSON.stringify(outPath)}`,
      'cat > "$LIVE_WRAPPER" <<EOF',
      bodyWithoutExec,
      "EOF",
    ].join("\n")
    writeFileSync(generatorPath, generator)
    const gen = Bun.spawnSync(["bash", generatorPath])
    expect(gen.exitCode, new TextDecoder().decode(gen.stderr)).toBe(0)

    if (opts.keyFileContent !== undefined) {
      mkdirSync(path.join(homeDir, "cluster-ops"), { recursive: true })
      writeFileSync(path.join(homeDir, "cluster-ops/cor-local.key"), opts.keyFileContent)
    }

    const probePath = path.join(dir, "probe.sh")
    writeFileSync(
      probePath,
      [
        "#!/bin/bash",
        "set -euo pipefail",
        `source ${JSON.stringify(outPath)}`,
        'printf "BASE_URL=%s\\n" "$COR_LOCAL_BASE_URL"',
        'if [[ -z "${COR_LOCAL_API_KEY+set}" ]]; then',
        '  printf "API_KEY=<unset>\\n"',
        "else",
        '  printf "API_KEY=%s\\n" "$COR_LOCAL_API_KEY"',
        "fi",
      ].join("\n"),
    )

    const runEnv: Record<string, string> = { PATH: process.env.PATH ?? "", HOME: homeDir }
    for (const [key, value] of Object.entries(opts.env ?? {})) runEnv[key] = value

    const run = Bun.spawnSync(["bash", probePath], { env: runEnv })
    expect(run.exitCode, new TextDecoder().decode(run.stderr)).toBe(0)
    return new TextDecoder().decode(run.stdout)
  } finally {
    rmSync(dir, { recursive: true, force: true })
    rmSync(homeDir, { recursive: true, force: true })
  }
}

describe("cor-local live wrapper env defaults (packet A3b)", () => {
  test("the generator heredoc declares the base URL default and key-file fallback", () => {
    const heredoc = extractWrapperHeredoc()
    expect(heredoc).toContain("COR_LOCAL_BASE_URL:=http://127.0.0.1:18082/v1")
    expect(heredoc).toContain("cluster-ops/cor-local.key")
    expect(heredoc).toContain("COR_LOCAL_API_KEY+set")
  })

  test("both env vars unset: resolves to the Mac Studio default, no api key exported", () => {
    const out = renderWrapperEnv({})
    expect(out).toContain("BASE_URL=http://127.0.0.1:18082/v1")
    expect(out).toContain("API_KEY=<unset>")
  })

  test("COR_LOCAL_API_KEY unset and key file readable: exports the file's content", () => {
    const out = renderWrapperEnv({ keyFileContent: "sekret-value\n" })
    expect(out).toContain("BASE_URL=http://127.0.0.1:18082/v1")
    expect(out).toContain("API_KEY=sekret-value")
  })

  test("COR_LOCAL_API_KEY unset and no key file: stays unset (not an empty string)", () => {
    const out = renderWrapperEnv({})
    // Distinguishing "<unset>" from "API_KEY=" (an explicit empty string) matters:
    // @ai-sdk/openai-compatible only omits the Authorization header when
    // apiKey is falsy either way, but an *unset* var lets a future
    // `{env:COR_LOCAL_API_KEY}` -> "" substitution happen without this
    // wrapper claiming it "set" anything.
    expect(out).toContain("API_KEY=<unset>")
  })

  test("explicit env vars from the caller are never overridden by the wrapper", () => {
    const out = renderWrapperEnv({
      env: {
        COR_LOCAL_BASE_URL: "http://mac-studio.tailb30e58.ts.net:18082/v1",
        COR_LOCAL_API_KEY: "",
      },
      keyFileContent: "should-not-be-read",
    })
    expect(out).toContain("BASE_URL=http://mac-studio.tailb30e58.ts.net:18082/v1")
    expect(out).not.toContain("API_KEY=<unset>")
    expect(out).not.toContain("should-not-be-read")
  })
})
