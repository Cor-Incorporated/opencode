// Temporary, key-free diagnosis for #366; never used by the production launcher.
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const here = path.dirname(fileURLToPath(import.meta.url))
const sources = {
  "exit 0": "exit 0",
  "Set-Acl": readFileSync(path.join(here, "../profile/src/cor-local-bin-defaults.test.ts"), "utf8").match(
    /const script = `([\s\S]*?)`/,
  )?.[1],
  "Get-Acl": readFileSync(path.join(here, "cor-local-env.js"), "utf8").match(
    /const WINDOWS_KEY_ACL = `([\s\S]*?)`/,
  )?.[1],
}

function presence(env = process.env) {
  const names = new Set(Object.keys(env).map((key) => key.toUpperCase()))
  return {
    ...Object.fromEntries(
      ["SYSTEMROOT", "WINDIR", "PSMODULEPATH", "USERPROFILE", "TEMP", "TMP", "PATH", "LOCALAPPDATA", "COMSPEC"].map(
        (key) => [key, names.has(key)],
      ),
    ),
    SystemRootLookup: Boolean(env.SystemRoot),
    SYSTEMROOTLookup: Boolean(env.SYSTEMROOT),
  }
}

function probe(stage, restore = "none") {
  const script = sources[stage]
  if (!script) throw new Error("Unknown ACL diagnostic stage")
  const choices = {
    none: [],
    PSModulePath: ["PSModulePath"],
    LOCALAPPDATA: ["LOCALAPPDATA"],
    both: ["PSModulePath", "LOCALAPPDATA"],
  }
  if (!Object.hasOwn(choices, restore)) throw new Error("Unknown ACL environment factor")
  const env = { ...process.env }
  if (restore !== "none") {
    const snapshot = JSON.parse(
      readFileSync(path.join(process.env.RUNNER_TEMP, "opencode-acl-environment.json"), "utf8"),
    )
    for (const key of choices[restore]) {
      if (typeof snapshot[key] !== "string" || !snapshot[key]) throw new Error("ACL environment factor unavailable")
      env[key] = snapshot[key]
    }
  }
  const dir = mkdtempSync(path.join(tmpdir(), "opencode-acl-transport-"))
  const file = path.join(dir, "fixture [key]'s.key")
  writeFileSync(file, "diagnostic-placeholder\n")
  const started = performance.now()
  try {
    const result = spawnSync(
      path.join(process.env.SystemRoot || "C:\\\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
      {
        env: {
          ...env,
          OPENCODE_COR_LOCAL_TEST_PATH: file,
          OPENCODE_COR_LOCAL_TEST_PUBLIC: "0",
          OPENCODE_COR_LOCAL_ACL_PATH: file,
        },
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 5_000,
        maxBuffer: 65_536,
        windowsHide: true,
        shell: false,
      },
    )
    return {
      stage,
      runtime: process.versions.bun ? `Bun ${process.versions.bun}` : `Node ${process.versions.node}`,
      restore,
      envPresence: presence(env),
      scriptSha256: createHash("sha256").update(script).digest("hex"),
      status: result.status,
      signal: result.signal,
      errorCode: result.error?.code,
      elapsed: Math.round(performance.now() - started),
      stdoutBytes: result.stdout?.length || 0,
      stderrBytes: result.stderr?.length || 0,
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

export function diagnose(stage, transport, restore = "none") {
  if (transport === "bun") return probe(stage, restore)
  const result = spawnSync("node", [fileURLToPath(import.meta.url), stage, restore], {
    env: process.env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 5_000,
    maxBuffer: 65_536,
    windowsHide: true,
    shell: false,
  })
  if (result.status === 0 && !result.error) return JSON.parse(result.stdout)
  return {
    stage,
    runtime: "Node child did not report",
    restore,
    envPresence: presence(),
    status: result.status,
    signal: result.signal,
    errorCode: result.error?.code,
    stdoutBytes: result.stdout?.length || 0,
    stderrBytes: result.stderr?.length || 0,
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.platform !== "win32" || process.versions.node.split(".")[0] !== "24")
    throw new Error("ACL diagnostic child requires Windows Node 24")
  console.log(JSON.stringify(probe(process.argv[2], process.argv[3])))
}
