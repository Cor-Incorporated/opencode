/**
 * `zai` (Z.AI, api.z.ai/api/paas/v4) is admitted by the guardrails profile
 * without its own credential: `opencode auth login` for the coding plan
 * stores the key under the `zai-coding-plan` id only, so `zai` requests carry
 * no Authorization header and the z.ai gateway rejects them with code 1001
 * "Authentication parameter not received in Header, unable to authenticate"
 * (@ai-sdk/openai-compatible omits the header entirely when apiKey is
 * undefined -- packages/opencode/src/provider/provider.ts resolveSDK).
 *
 * The bridge is `packages/guardrails/bin/zai-auth-env.js`, imported by
 * `bin/opencode-guardrails` (the single Node entry point that runs before
 * every invocation -- managed deploy, the live wrapper, and a direct call
 * alike). Z.AI accepts one account key on both the coding and platform
 * endpoints, so the stored coding-plan key is exported as `ZHIPU_API_KEY`
 * -- the env var both lanes declare in models.dev.
 *
 * Cases unit-test `zai-auth-env.js` directly; the subprocess case runs the
 * real `bin/opencode-guardrails` entry point against a stub "opencode"
 * binary (via `OPENCODE_BIN_PATH`) so the wiring is proven end to end
 * without ever spawning the real opencode binary or touching the network,
 * and without reading the developer's real auth.json (HOME is redirected).
 */
import { describe, expect, test } from "bun:test"
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { applyZaiAuthDefaults, extractZaiKey } from "../../bin/zai-auth-env.js"

const binPath = fileURLToPath(new URL("../../bin/opencode-guardrails", import.meta.url))

function withTmpDir<T>(prefix: string, fn: (dir: string) => T): T {
  const dir = mkdtempSync(path.join(tmpdir(), prefix))
  try {
    return fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

function writeAuthFile(dir: string, auth: unknown) {
  const file = path.join(dir, "auth.json")
  writeFileSync(file, JSON.stringify(auth))
  return file
}

describe("zai-auth-env.js: extractZaiKey precedence", () => {
  test("(a) a zai-coding-plan api key is adopted", () => {
    expect(extractZaiKey({ "zai-coding-plan": { type: "api", key: "test-key-123456" } })).toBe("test-key-123456")
  })

  test("(b) a direct zai api key wins over zai-coding-plan", () => {
    const auth = {
      zai: { type: "api", key: "zai-own-key" },
      "zai-coding-plan": { type: "api", key: "coding-plan-key" },
    }
    expect(extractZaiKey(auth)).toBe("zai-own-key")
  })

  test("(d) oauth entries are ignored", () => {
    expect(
      extractZaiKey({ "zai-coding-plan": { type: "oauth", access: "x", refresh: "y", expires: 1 } }),
    ).toBeUndefined()
  })

  test("(e) a key outside the conservative charset is ignored", () => {
    expect(extractZaiKey({ "zai-coding-plan": { type: "api", key: 'bad"quote' } })).toBeUndefined()
    expect(extractZaiKey({ "zai-coding-plan": { type: "api", key: "" } })).toBeUndefined()
    expect(extractZaiKey(undefined)).toBeUndefined()
  })
})

describe("zai-auth-env.js: applyZaiAuthDefaults", () => {
  test("(a) coding-plan key in the auth file is exported as ZHIPU_API_KEY", () => {
    withTmpDir("zai-auth-apply-", (dir) => {
      const authFile = writeAuthFile(dir, { "zai-coding-plan": { type: "api", key: "test-key-123456" } })
      const env: Record<string, string> = { HOME: dir }
      applyZaiAuthDefaults(env, { authFile, warn: () => {} })
      expect(env.ZHIPU_API_KEY).toBe("test-key-123456")
    })
  })

  test("(c) a caller-supplied ZHIPU_API_KEY is never overridden", () => {
    withTmpDir("zai-auth-noverride-", (dir) => {
      const authFile = writeAuthFile(dir, { "zai-coding-plan": { type: "api", key: "from-file" } })
      const env: Record<string, string> = { HOME: dir, ZHIPU_API_KEY: "caller-value" }
      applyZaiAuthDefaults(env, { authFile, warn: () => {} })
      expect(env.ZHIPU_API_KEY).toBe("caller-value")
    })
  })

  test("(f) OPENCODE_AUTH_CONTENT replaces the auth file, as upstream Auth.all does", () => {
    withTmpDir("zai-auth-content-", (dir) => {
      const authFile = writeAuthFile(dir, { "zai-coding-plan": { type: "api", key: "from-file" } })
      const env: Record<string, string> = {
        HOME: dir,
        OPENCODE_AUTH_CONTENT: JSON.stringify({ "zai-coding-plan": { type: "api", key: "from-content" } }),
      }
      applyZaiAuthDefaults(env, { authFile, warn: () => {} })
      expect(env.ZHIPU_API_KEY).toBe("from-content")
    })
  })

  test("(g) missing auth file: ZHIPU_API_KEY stays unset", () => {
    withTmpDir("zai-auth-missing-", (dir) => {
      const env: Record<string, string> = { HOME: dir }
      applyZaiAuthDefaults(env, { authFile: path.join(dir, "does-not-exist.json"), warn: () => {} })
      expect(env.ZHIPU_API_KEY).toBeUndefined()
    })
  })

  test("(h) invalid JSON: warning without the file contents, ZHIPU_API_KEY stays unset", () => {
    withTmpDir("zai-auth-badjson-", (dir) => {
      const authFile = path.join(dir, "auth.json")
      writeFileSync(authFile, "{not json")
      const warnings: string[] = []
      const env: Record<string, string> = { HOME: dir }
      applyZaiAuthDefaults(env, { authFile, warn: (msg) => warnings.push(msg) })
      expect(env.ZHIPU_API_KEY).toBeUndefined()
      expect(warnings).toHaveLength(1)
      expect(warnings[0]).toBe("zai-auth: auth store ignored (invalid JSON)")
      expect(warnings[0]).not.toContain("not json")
    })
  })

  test("default auth file resolves under XDG_DATA_HOME, then ~/.local/share", () => {
    withTmpDir("zai-auth-xdg-", (dir) => {
      const xdgData = path.join(dir, "xdg-data")
      mkdirSync(path.join(xdgData, "opencode"), { recursive: true })
      writeFileSync(
        path.join(xdgData, "opencode", "auth.json"),
        JSON.stringify({ zai: { type: "api", key: "via-xdg" } }),
      )
      const env: Record<string, string> = { HOME: path.join(dir, "home"), XDG_DATA_HOME: xdgData }
      applyZaiAuthDefaults(env, { warn: () => {} })
      expect(env.ZHIPU_API_KEY).toBe("via-xdg")
    })
  })
})

describe("bin/opencode-guardrails: zai auth bridge (subprocess, offline)", () => {
  /**
   * Runs the real bin/opencode-guardrails with a stub "opencode" binary
   * (OPENCODE_BIN_PATH) that prints the ZHIPU_API_KEY it received and exits.
   * HOME points at a temp dir so the developer's real auth.json is never
   * read; the stub never touches the network.
   */
  function runEntryPoint(opts: { projectDir: string; homeDir: string; env?: Record<string, string> }) {
    const stubPath = path.join(opts.projectDir, "stub-opencode.mjs")
    writeFileSync(
      stubPath,
      [
        "#!/usr/bin/env node",
        'process.stdout.write(`ZHIPU_API_KEY=${process.env.ZHIPU_API_KEY ?? "<unset>"}\\n`)',
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

  test("a coding-plan key in HOME's auth.json is bridged into ZHIPU_API_KEY", () => {
    withTmpDir("zai-entry-keyed-", (projectDir) => {
      withTmpDir("zai-entry-home-", (homeDir) => {
        mkdirSync(path.join(homeDir, ".local", "share", "opencode"), { recursive: true })
        writeFileSync(
          path.join(homeDir, ".local", "share", "opencode", "auth.json"),
          JSON.stringify({ "zai-coding-plan": { type: "api", key: "bridged-key-1" } }),
        )
        const out = runEntryPoint({ projectDir, homeDir })
        expect(out).toContain("ZHIPU_API_KEY=bridged-key-1")
      })
    })
  })

  test("no auth.json: ZHIPU_API_KEY stays unset through the real entry point", () => {
    withTmpDir("zai-entry-bare-", (projectDir) => {
      withTmpDir("zai-entry-home2-", (homeDir) => {
        const out = runEntryPoint({ projectDir, homeDir })
        expect(out).toContain("ZHIPU_API_KEY=<unset>")
      })
    })
  })

  test("a project .env's ZHIPU_API_KEY wins over the bridge (loaded before it)", () => {
    withTmpDir("zai-entry-dotenv-", (projectDir) => {
      withTmpDir("zai-entry-home3-", (homeDir) => {
        writeFileSync(path.join(projectDir, ".env"), "ZHIPU_API_KEY=from-dot-env\n")
        mkdirSync(path.join(homeDir, ".local", "share", "opencode"), { recursive: true })
        writeFileSync(
          path.join(homeDir, ".local", "share", "opencode", "auth.json"),
          JSON.stringify({ "zai-coding-plan": { type: "api", key: "from-auth-json" } }),
        )
        const out = runEntryPoint({ projectDir, homeDir })
        expect(out).toContain("ZHIPU_API_KEY=from-dot-env")
      })
    })
  })
})
