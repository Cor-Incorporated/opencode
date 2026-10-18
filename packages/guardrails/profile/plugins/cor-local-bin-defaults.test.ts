/**
 * Packet A3b (review follow-up): `cor-local`'s `options.baseURL`/`options.apiKey`
 * are `{env:COR_LOCAL_BASE_URL}`/`{env:COR_LOCAL_API_KEY}`
 * (packages/guardrails/{managed,profile}/opencode.json). `{env:VAR}`
 * substitution (packages/opencode/src/config/variable.ts) resolves an unset
 * var to `""` unconditionally -- it never errors -- so an unset
 * `COR_LOCAL_BASE_URL` breaks every cor-local call with a
 * `TypeError: Invalid URL` well past `opencode models`.
 *
 * The default is supplied by `packages/guardrails/bin/cor-local-env.js`
 * (imported by `bin/opencode-guardrails`, the single Node entry point that
 * runs before every invocation -- managed deploy, the live wrapper, and a
 * direct `opencode-guardrails` call alike). This replaces the earlier
 * shell-heredoc-only defaulting (scripts/local-dev-deploy.sh), which left
 * the Node entry point unprotected and went stale between a `git pull` and
 * the next `local:deploy`/`local:fix`.
 *
 * Cases (a)-(b) and (d)-(f) unit-test `cor-local-env.js` directly. Case (c)
 * (project `.env` ordering) runs the real `bin/opencode-guardrails` entry
 * point as a subprocess against a stub "opencode" binary (via
 * `OPENCODE_BIN_PATH`), because the load-project-`.env` step lives in the
 * bin script itself, not in the extracted module -- this is the only way to
 * prove the actual order without ever touching the real opencode binary or
 * network (OPENCODE_DISABLE_MODELS_FETCH=1, stub never fetches).
 */
import { describe, expect, test } from "bun:test"
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { applyCorLocalDefaults, loadCorLocalKeyFromFile } from "../../bin/cor-local-env.js"

const binPath = fileURLToPath(new URL("../../bin/opencode-guardrails", import.meta.url))

function withTmpDir<T>(prefix: string, fn: (dir: string) => T): T {
  const dir = mkdtempSync(path.join(tmpdir(), prefix))
  try {
    return fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe("cor-local-env.js: COR_LOCAL_BASE_URL defaulting", () => {
  test("(a) unset -> defaults to the Mac Studio router", () => {
    const env: Record<string, string> = {}
    applyCorLocalDefaults(env, { warn: () => {} })
    expect(env.COR_LOCAL_BASE_URL).toBe("http://127.0.0.1:18082/v1")
  })

  test("(b) already set -> caller's value is never overridden", () => {
    const env: Record<string, string> = { COR_LOCAL_BASE_URL: "http://mac-studio.tailb30e58.ts.net:18082/v1" }
    applyCorLocalDefaults(env, { warn: () => {} })
    expect(env.COR_LOCAL_BASE_URL).toBe("http://mac-studio.tailb30e58.ts.net:18082/v1")
  })
})

describe("cor-local-env.js: key file validation", () => {
  test("(d) group/other-readable key file is ignored, with a warning that never echoes the value", () => {
    withTmpDir("cor-local-key-perm-", (dir) => {
      const keyFile = path.join(dir, "cor-local.key")
      writeFileSync(keyFile, "top-secret-value\n")
      chmodSync(keyFile, 0o644)

      const warnings: string[] = []
      const key = loadCorLocalKeyFromFile(keyFile, { warn: (msg) => warnings.push(msg) })

      expect(key).toBeUndefined()
      expect(warnings).toHaveLength(1)
      expect(warnings[0]).not.toContain("top-secret-value")
      expect(warnings[0]).toBe("cor-local: key file ignored (invalid format)")
    })
  })

  test("(e) a key containing a quote is ignored (would corrupt the spliced JSON config)", () => {
    withTmpDir("cor-local-key-quote-", (dir) => {
      const keyFile = path.join(dir, "cor-local.key")
      writeFileSync(keyFile, 'sk-"bad\n')
      chmodSync(keyFile, 0o600)

      const key = loadCorLocalKeyFromFile(keyFile, { warn: () => {} })
      expect(key).toBeUndefined()
    })
  })

  test("(e) a key with a second line is ignored", () => {
    withTmpDir("cor-local-key-2line-", (dir) => {
      const keyFile = path.join(dir, "cor-local.key")
      writeFileSync(keyFile, "sk-good\nextra-line\n")
      chmodSync(keyFile, 0o600)

      const key = loadCorLocalKeyFromFile(keyFile, { warn: () => {} })
      expect(key).toBeUndefined()
    })
  })

  test("(f) a normal owner-only key with a trailing newline is adopted without the newline", () => {
    withTmpDir("cor-local-key-ok-", (dir) => {
      const keyFile = path.join(dir, "cor-local.key")
      writeFileSync(keyFile, "sk-good-value123\n")
      chmodSync(keyFile, 0o600)

      const key = loadCorLocalKeyFromFile(keyFile, { warn: () => {} })
      expect(key).toBe("sk-good-value123")
    })
  })

  test("missing key file: COR_LOCAL_API_KEY stays unset, base URL still defaults", () => {
    withTmpDir("cor-local-key-missing-", (dir) => {
      const env: Record<string, string> = { COR_LOCAL_KEY_FILE: path.join(dir, "does-not-exist.key") }
      applyCorLocalDefaults(env, { warn: () => {} })
      expect(env.COR_LOCAL_BASE_URL).toBe("http://127.0.0.1:18082/v1")
      expect(env.COR_LOCAL_API_KEY).toBeUndefined()
    })
  })

  test("applyCorLocalDefaults reads a valid key file into COR_LOCAL_API_KEY", () => {
    withTmpDir("cor-local-key-apply-", (dir) => {
      const keyFile = path.join(dir, "cor-local.key")
      writeFileSync(keyFile, "sk-applied-value\n")
      chmodSync(keyFile, 0o600)

      const env: Record<string, string> = { COR_LOCAL_KEY_FILE: keyFile }
      applyCorLocalDefaults(env, { warn: () => {} })
      expect(env.COR_LOCAL_API_KEY).toBe("sk-applied-value")
    })
  })

  test("applyCorLocalDefaults never overrides a caller-supplied COR_LOCAL_API_KEY", () => {
    withTmpDir("cor-local-key-noverride-", (dir) => {
      const keyFile = path.join(dir, "cor-local.key")
      writeFileSync(keyFile, "should-not-be-read\n")
      chmodSync(keyFile, 0o600)

      const env: Record<string, string> = { COR_LOCAL_KEY_FILE: keyFile, COR_LOCAL_API_KEY: "caller-value" }
      applyCorLocalDefaults(env, { warn: () => {} })
      expect(env.COR_LOCAL_API_KEY).toBe("caller-value")
    })
  })
})

describe("bin/opencode-guardrails: real entry point ordering (subprocess, offline)", () => {
  /**
   * Runs the real bin/opencode-guardrails with a stub "opencode" binary
   * (OPENCODE_BIN_PATH) that prints the two cor-local env vars it received
   * and exits -- proving the entry point's actual behavior end to end
   * without ever spawning the real opencode binary or touching the network.
   */
  function runEntryPoint(opts: { projectDir: string; homeDir: string; env?: Record<string, string> }) {
    const stubPath = path.join(opts.projectDir, "stub-opencode.mjs")
    writeFileSync(
      stubPath,
      [
        "#!/usr/bin/env node",
        'process.stdout.write(`BASE_URL=${process.env.COR_LOCAL_BASE_URL ?? "<unset>"}\\n`)',
        'process.stdout.write(`API_KEY=${process.env.COR_LOCAL_API_KEY ?? "<unset>"}\\n`)',
      ].join("\n"),
    )
    chmodSync(stubPath, 0o755)

    const run = Bun.spawnSync(["node", binPath], {
      cwd: opts.projectDir,
      env: {
        PATH: process.env.PATH ?? "",
        HOME: opts.homeDir,
        OPENCODE_BIN_PATH: stubPath,
        OPENCODE_DISABLE_MODELS_FETCH: "1",
        ...opts.env,
      },
    })
    expect(run.exitCode, new TextDecoder().decode(run.stderr)).toBe(0)
    return new TextDecoder().decode(run.stdout)
  }

  test("(c) a project .env's COR_LOCAL_BASE_URL wins over the built-in default", () => {
    withTmpDir("cor-local-entry-project-", (projectDir) => {
      withTmpDir("cor-local-entry-home-", (homeDir) => {
        writeFileSync(path.join(projectDir, ".env"), "COR_LOCAL_BASE_URL=http://from-dot-env:18082/v1\n")
        const out = runEntryPoint({ projectDir, homeDir })
        expect(out).toContain("BASE_URL=http://from-dot-env:18082/v1")
      })
    })
  })

  test("no .env, no env vars: the entry point still defaults the base URL", () => {
    withTmpDir("cor-local-entry-noenv-", (projectDir) => {
      withTmpDir("cor-local-entry-home2-", (homeDir) => {
        const out = runEntryPoint({ projectDir, homeDir })
        expect(out).toContain("BASE_URL=http://127.0.0.1:18082/v1")
        expect(out).toContain("API_KEY=<unset>")
      })
    })
  })

  test("HOME's ~/cluster-ops/cor-local.key is picked up when COR_LOCAL_API_KEY is unset", () => {
    withTmpDir("cor-local-entry-keyed-", (projectDir) => {
      withTmpDir("cor-local-entry-home3-", (homeDir) => {
        mkdirSync(path.join(homeDir, "cluster-ops"), { recursive: true })
        const keyFile = path.join(homeDir, "cluster-ops", "cor-local.key")
        writeFileSync(keyFile, "sk-from-home\n")
        chmodSync(keyFile, 0o600)

        const out = runEntryPoint({ projectDir, homeDir })
        expect(out).toContain("API_KEY=sk-from-home")
      })
    })
  })
})
