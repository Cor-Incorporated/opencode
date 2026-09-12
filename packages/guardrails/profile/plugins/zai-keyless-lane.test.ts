/**
 * Keyless catalog lanes must not reach the model picker.
 *
 * 2026-09-11 incident: the packaged config declares `zai` (Z.AI pay-as-you-go)
 * with a whitelist-only block. opencode loads config-declared providers even
 * without a credential (provider.ts's "load config - re-apply" merge), so a
 * machine holding only a `zai-coding-plan` key still got `zai/glm-5.3-flash`
 * in the picker — and every call died with z.ai error 1001
 * "Authentication parameter not received in Header, unable to authenticate",
 * because the coding-plan key cannot authenticate the PAYG endpoint and no
 * Authorization header is sent at all without a credential.
 *
 * guardrail.ts's config() hook now drops the lane when the machine has neither
 * the lane's env var (ZHIPU_API_KEY) nor a same-id auth-store entry. These tests
 * pin that gate so a future refactor cannot silently reintroduce the keyless
 * lane (and so it never drops a lane on a machine that DOES have the key).
 *
 * Run: bun test profile/plugins/zai-keyless-lane.test.ts (from packages/guardrails)
 */
import fs from "fs"
import os from "os"
import path from "path"
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { dropKeylessCatalogLanes } from "./guardrail"

const original = {
  xdg: process.env.XDG_DATA_HOME,
  key: process.env.ZHIPU_API_KEY,
}
let temp: string | undefined

beforeEach(() => {
  temp = fs.mkdtempSync(path.join(os.tmpdir(), "zai-keyless-lane-"))
  process.env.XDG_DATA_HOME = temp
  delete process.env.ZHIPU_API_KEY
})

afterEach(() => {
  if (original.xdg === undefined) delete process.env.XDG_DATA_HOME
  else process.env.XDG_DATA_HOME = original.xdg
  if (original.key === undefined) delete process.env.ZHIPU_API_KEY
  else process.env.ZHIPU_API_KEY = original.key
  fs.rmSync(temp!, { recursive: true, force: true })
})

function authStore(content: string) {
  const dir = path.join(process.env.XDG_DATA_HOME!, "opencode")
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, "auth.json"), content)
}

// Mirrors the packaged config's shape: zai (PAYG) next to zai-coding-plan and a
// custom keyless-by-design local lane that must never be touched by this gate.
function packagedConfig() {
  return {
    provider: {
      zai: { whitelist: ["glm-5.3-flash", "glm-5.3"] },
      "zai-coding-plan": { whitelist: ["glm-5.3-flash", "glm-5.3"] },
      "cor-local": { whitelist: ["glm53-flash"] },
    },
  }
}

describe("dropKeylessCatalogLanes", () => {
  test("no credential anywhere: zai dropped, sibling lanes untouched", async () => {
    const cfg = packagedConfig()
    await dropKeylessCatalogLanes(cfg)
    expect(cfg.provider["zai"]).toBeUndefined()
    expect(cfg.provider["zai-coding-plan"]?.whitelist).toContain("glm-5.3-flash")
    expect(cfg.provider["cor-local"]?.whitelist).toContain("glm53-flash")
  })

  test("incident shape: auth store holds only the coding-plan key -> zai dropped", async () => {
    authStore(
      JSON.stringify({ "zai-coding-plan": { type: "api", key: "sk-coding" }, openai: { type: "api", key: "x" } }),
    )
    const cfg = packagedConfig()
    await dropKeylessCatalogLanes(cfg)
    expect(cfg.provider["zai"]).toBeUndefined()
  })

  test("ZHIPU_API_KEY set: lane kept", async () => {
    process.env.ZHIPU_API_KEY = "sk-payg"
    const cfg = packagedConfig()
    await dropKeylessCatalogLanes(cfg)
    expect(cfg.provider["zai"]?.whitelist).toContain("glm-5.3-flash")
  })

  test("auth-store zai entry: lane kept", async () => {
    authStore(JSON.stringify({ zai: { type: "api", key: "sk-payg" } }))
    const cfg = packagedConfig()
    await dropKeylessCatalogLanes(cfg)
    expect(cfg.provider["zai"]?.whitelist).toContain("glm-5.3-flash")
  })

  test("unreadable auth store: lane kept (fail open, never hide a working lane)", async () => {
    authStore("{not json")
    const cfg = packagedConfig()
    await dropKeylessCatalogLanes(cfg)
    expect(cfg.provider["zai"]?.whitelist).toContain("glm-5.3-flash")
  })

  test("config without the lane block: no-op", async () => {
    const cfg = packagedConfig()
    delete cfg.provider["zai"]
    await dropKeylessCatalogLanes(cfg)
    expect(Object.keys(cfg.provider).sort()).toEqual(["cor-local", "zai-coding-plan"])
  })
})
