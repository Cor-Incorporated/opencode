// Temporary, key-free CI diagnosis for Cor-Incorporated/opencode#366. No production settings are changed.
import { spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { privateWindowsKeyAcl } from "./cor-local-env.js"

if (process.platform !== "win32") {
  console.log("windows-acl-diagnostic: Windows runner required")
  process.exit(0)
}

const here = path.dirname(fileURLToPath(import.meta.url))
const fixture = readFileSync(path.join(here, "../profile/src/cor-local-bin-defaults.test.ts"), "utf8").match(
  /const script = `([\s\S]*?)`/,
)?.[1]
const probe = readFileSync(path.join(here, "cor-local-env.js"), "utf8").match(
  /const WINDOWS_KEY_ACL = `([\s\S]*?)`/,
)?.[1]
if (!fixture || !probe) throw new Error("ACL source script not found")
const powershell = path.join(process.env.SystemRoot || "C:\\Windows", "System32/WindowsPowerShell/v1.0/powershell.exe")

function diagnose(label, ignoreStdin) {
  const directory = mkdtempSync(path.join(tmpdir(), "opencode-acl-diagnostic-"))
  const file = path.join(directory, "fixture [key]'s.key")
  writeFileSync(file, "diagnostic-placeholder\n")
  const env = {
    ...process.env,
    OPENCODE_COR_LOCAL_TEST_PATH: file,
    OPENCODE_COR_LOCAL_TEST_PUBLIC: "0",
    OPENCODE_COR_LOCAL_ACL_PATH: file,
  }
  const run = (stage, script) => {
    const started = performance.now()
    const result = spawnSync(powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], {
      env,
      encoding: "utf8",
      timeout: 5_000,
      maxBuffer: 65_536,
      windowsHide: true,
      shell: false,
      ...(ignoreStdin ? { stdio: ["ignore", "pipe", "pipe"] } : {}),
    })
    console.log(
      JSON.stringify({
        label,
        runtime: process.versions.bun ? `Bun ${process.versions.bun}` : `Node ${process.versions.node}`,
        stage,
        status: result.status,
        signal: result.signal,
        error: result.error?.code,
        elapsed: Math.round(performance.now() - started),
        stdout: result.stdout?.slice(0, 512),
        stderr: result.stderr?.slice(0, 512),
        ...(stage === "Get-Acl" ? { privateAcl: privateWindowsKeyAcl(result) } : {}),
      }),
    )
    return result.status === 0 && !result.error
  }
  try {
    run("exit 0", "exit 0")
    if (run("Set-Acl", fixture)) run("Get-Acl", probe)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

if (process.argv[2] === "node") {
  diagnose("Node stdin ignore", true)
  process.exit(0)
}
diagnose("Bun stdin default", false)
diagnose("Bun stdin ignore", true)
const node = spawnSync("node", [fileURLToPath(import.meta.url), "node"], {
  encoding: "utf8",
  stdio: ["ignore", "pipe", "pipe"],
  timeout: 20_000,
})
process.stdout.write(node.stdout || "")
process.stderr.write(node.stderr || "")
if (node.error || node.status !== 0) throw new Error(`Node ACL diagnostic failed: ${node.error?.code || node.status}`)
