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
import { spawnSync } from "node:child_process"
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { applyCorLocalDefaults, loadCorLocalKeyFromFile, privateWindowsKeyAcl } from "../../bin/cor-local-env.js"

const binPath = fileURLToPath(new URL("../../bin/opencode-guardrails", import.meta.url))

function withTmpDir<T>(prefix: string, fn: (dir: string) => T): T {
  const dir = mkdtempSync(path.join(tmpdir(), prefix))
  try {
    return fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// Windows chmod does not set a private DACL: create the actual ACL used by the production probe.
function keyPermissions(filePath: string, mode: number) {
  if (process.platform !== "win32") return chmodSync(filePath, mode)
  const script = `
$ErrorActionPreference = 'Stop'
$user = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$acl = New-Object System.Security.AccessControl.FileSecurity
$acl.SetOwner($user)
$acl.SetAccessRuleProtection($true, $false)
$acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($user, [System.Security.AccessControl.FileSystemRights]::FullControl, [System.Security.AccessControl.AccessControlType]::Allow))
if ($env:OPENCODE_COR_LOCAL_TEST_PUBLIC -eq '1') {
  $everyone = [System.Security.Principal.SecurityIdentifier]::new('S-1-1-0')
  $acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($everyone, [System.Security.AccessControl.FileSystemRights]::Read, [System.Security.AccessControl.AccessControlType]::Allow))
}
Set-Acl -LiteralPath $env:OPENCODE_COR_LOCAL_TEST_PATH -AclObject $acl
`
  const result = spawnSync(
    path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
    {
      env: {
        ...process.env,
        OPENCODE_COR_LOCAL_TEST_PATH: filePath,
        OPENCODE_COR_LOCAL_TEST_PUBLIC: mode === 0o600 ? "0" : "1",
      },
      encoding: "utf8",
      timeout: 5_000,
      windowsHide: true,
      shell: false,
    },
  )
  expect(result.status, result.stderr).toBe(0)
}

describe("cor-local-env.js: Windows key-file ACL policy", () => {
  const user = "S-1-5-21-1001"
  const probe = (allow = [user], owner = user) => ({ status: 0, stdout: JSON.stringify({ user, owner, allow }) })

  test("accepts current-user access with optional SYSTEM and Administrators", () => {
    expect(privateWindowsKeyAcl(probe())).toBe(true)
    expect(privateWindowsKeyAcl(probe([user, "S-1-5-18", "S-1-5-32-544"]))).toBe(true)
  })

  test.each([
    ["Everyone access", probe([user, "S-1-1-0"])],
    ["another user", probe([user, "S-1-5-21-2002"])],
    ["foreign owner", probe([user], "S-1-5-21-2002")],
    ["empty/null DACL", probe([])],
    ["missing SID", { status: 0, stdout: JSON.stringify({ owner: user, allow: [user] }) }],
    ["invalid SID", { status: 0, stdout: JSON.stringify({ user: "not-a-sid", owner: user, allow: [user] }) }],
    ["malformed JSON", { status: 0, stdout: "not-json" }],
    ["failed probe", { ...probe(), status: 1 }],
    ["timed-out probe", { ...probe(), error: new Error("ETIMEDOUT") }],
    ["interrupted probe", { ...probe(), status: null, signal: "SIGTERM" }],
  ])("rejects %s", (_name, result) => {
    expect(privateWindowsKeyAcl(result)).toBe(false)
  })
})

describe("cor-local-env.js: COR_LOCAL_BASE_URL defaulting", () => {
  test("(a) unset -> defaults to the Mac Studio router", () => {
    const env: Record<string, string> = { COR_LOCAL_API_KEY: "test-key-no-file-read" }
    applyCorLocalDefaults(env, { warn: () => {} })
    expect(env.COR_LOCAL_BASE_URL).toBe("http://127.0.0.1:18082/v1")
  })

  test("(b) already set -> caller's value is never overridden", () => {
    const env: Record<string, string> = {
      COR_LOCAL_BASE_URL: "http://mac-studio.tailb30e58.ts.net:18082/v1",
      COR_LOCAL_API_KEY: "test-key-no-file-read",
    }
    applyCorLocalDefaults(env, { warn: () => {} })
    expect(env.COR_LOCAL_BASE_URL).toBe("http://mac-studio.tailb30e58.ts.net:18082/v1")
  })
})

describe("cor-local-env.js: key file validation", () => {
  test("(d) group/other-readable key file is ignored, with a warning that never echoes the value", () => {
    withTmpDir("cor-local-key-perm-", (dir) => {
      const keyFile = path.join(dir, "cor-local.key")
      writeFileSync(keyFile, "top-secret-value\n")
      keyPermissions(keyFile, 0o644)

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
      keyPermissions(keyFile, 0o600)

      const key = loadCorLocalKeyFromFile(keyFile, { warn: () => {} })
      expect(key).toBeUndefined()
    })
  })

  test("(e) a key with a second line is ignored", () => {
    withTmpDir("cor-local-key-2line-", (dir) => {
      const keyFile = path.join(dir, "cor-local.key")
      writeFileSync(keyFile, "sk-good\nextra-line\n")
      keyPermissions(keyFile, 0o600)

      const key = loadCorLocalKeyFromFile(keyFile, { warn: () => {} })
      expect(key).toBeUndefined()
    })
  })

  test("(f) a normal owner-only key with a trailing newline is adopted without the newline", () => {
    withTmpDir("cor-local-key-ok-", (dir) => {
      const keyFile = path.join(dir, "cor-local [key]'s.key")
      writeFileSync(keyFile, "sk-good-value123\n")
      keyPermissions(keyFile, 0o600)

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
      keyPermissions(keyFile, 0o600)

      const env: Record<string, string> = { COR_LOCAL_KEY_FILE: keyFile }
      applyCorLocalDefaults(env, { warn: () => {} })
      expect(env.COR_LOCAL_API_KEY).toBe("sk-applied-value")
    })
  })

  test("applyCorLocalDefaults never overrides a caller-supplied COR_LOCAL_API_KEY", () => {
    withTmpDir("cor-local-key-noverride-", (dir) => {
      const keyFile = path.join(dir, "cor-local.key")
      writeFileSync(keyFile, "should-not-be-read\n")
      keyPermissions(keyFile, 0o600)

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
        USERPROFILE: opts.homeDir,
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
        keyPermissions(keyFile, 0o600)

        const out = runEntryPoint({ projectDir, homeDir })
        expect(out).toContain("API_KEY=sk-from-home")
      })
    })
  })
})
