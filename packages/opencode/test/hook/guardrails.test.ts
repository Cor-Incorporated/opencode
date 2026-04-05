import { describe, expect, test } from "bun:test"
import path from "node:path"
import { runHook, type HookEnv } from "../../src/hook"
import type { HookEntry } from "../../src/hook"

const REPO_ROOT = path.resolve(__dirname, "../../../..")
const SCRIPT = path.join(REPO_ROOT, ".opencode/hooks/guardrails.sh")

function makeEnv(toolName: string, toolInput: string): HookEnv {
  return {
    OPENCODE_HOOK_EVENT: "PreToolUse",
    OPENCODE_TOOL_NAME: toolName,
    OPENCODE_TOOL_INPUT: toolInput,
    OPENCODE_PROJECT_DIR: REPO_ROOT,
    OPENCODE_SESSION_ID: "test-guardrails",
  }
}

function entry(): HookEntry {
  return { command: SCRIPT, timeout: 5000 }
}

describe("guardrails hook", () => {
  describe("non-bash tools pass without message", () => {
    test("read tool passes", async () => {
      const result = await runHook(entry(), makeEnv("read", '{"path":"/tmp/file"}'))
      expect(result.action).toBe("pass")
      expect(result.message).toBeUndefined()
    })

    test("edit tool passes", async () => {
      const result = await runHook(entry(), makeEnv("edit", '{"file":"test.ts"}'))
      expect(result.action).toBe("pass")
      expect(result.message).toBeUndefined()
    })

    test("glob tool passes", async () => {
      const result = await runHook(entry(), makeEnv("glob", '{"pattern":"*.ts"}'))
      expect(result.action).toBe("pass")
      expect(result.message).toBeUndefined()
    })
  })

  describe("blocks destructive operations (exit 2)", () => {
    test("rm -rf / is blocked", async () => {
      const result = await runHook(entry(), makeEnv("bash", '{"command":"rm -rf /"}'))
      expect(result.action).toBe("block")
      expect(result.message).toContain("GUARDRAIL BLOCKED")
      expect(result.message).toContain("rm -rf")
    })

    test("rm -rf /* is blocked", async () => {
      const result = await runHook(entry(), makeEnv("bash", '{"command":"rm -rf /*"}'))
      expect(result.action).toBe("block")
      expect(result.message).toContain("GUARDRAIL BLOCKED")
    })

    test("mkfs.ext4 is blocked", async () => {
      const result = await runHook(entry(), makeEnv("bash", '{"command":"mkfs.ext4 /dev/sda1"}'))
      expect(result.action).toBe("block")
      expect(result.message).toContain("GUARDRAIL BLOCKED")
      expect(result.message).toContain("Disk formatting")
    })

    test("dd if= is blocked", async () => {
      const result = await runHook(entry(), makeEnv("bash", '{"command":"dd if=/dev/zero of=/dev/sda"}'))
      expect(result.action).toBe("block")
      expect(result.message).toContain("GUARDRAIL BLOCKED")
      expect(result.message).toContain("Disk formatting")
    })

    test("fork bomb is blocked", async () => {
      const result = await runHook(entry(), makeEnv("bash", '{"command":":(){ :|:& };:"}'))
      expect(result.action).toBe("block")
      expect(result.message).toContain("GUARDRAIL BLOCKED")
      expect(result.message).toContain("Fork bomb")
    })

    test("DROP TABLE is blocked", async () => {
      const result = await runHook(entry(), makeEnv("bash", '{"command":"psql -c \\"DROP TABLE users\\""}'))
      expect(result.action).toBe("block")
      expect(result.message).toContain("GUARDRAIL BLOCKED")
      expect(result.message).toContain("Database destruction")
    })

    test("DROP DATABASE is blocked", async () => {
      const result = await runHook(entry(), makeEnv("bash", '{"command":"mysql -e \\"DROP DATABASE production \\""}'))
      expect(result.action).toBe("block")
      expect(result.message).toContain("GUARDRAIL BLOCKED")
      expect(result.message).toContain("Database destruction")
    })
  })

  describe("warns on force operations (exit 0 with stderr)", () => {
    test("git push --force passes with warning", async () => {
      const result = await runHook(entry(), makeEnv("bash", '{"command":"git push --force origin main"}'))
      expect(result.action).toBe("pass")
      expect(result.message).toContain("GUARDRAIL WARNING")
      expect(result.message).toContain("Force operation")
    })

    test("git reset --hard passes with warning", async () => {
      const result = await runHook(entry(), makeEnv("bash", '{"command":"git reset --hard HEAD~1"}'))
      expect(result.action).toBe("pass")
      expect(result.message).toContain("GUARDRAIL WARNING")
      expect(result.message).toContain("Force operation")
    })
  })

  describe("normal commands pass clean", () => {
    test("ls passes", async () => {
      const result = await runHook(entry(), makeEnv("bash", '{"command":"ls -la"}'))
      expect(result.action).toBe("pass")
      expect(result.message).toBeUndefined()
    })

    test("git status passes", async () => {
      const result = await runHook(entry(), makeEnv("bash", '{"command":"git status"}'))
      expect(result.action).toBe("pass")
      expect(result.message).toBeUndefined()
    })

    test("npm install passes", async () => {
      const result = await runHook(entry(), makeEnv("bash", '{"command":"npm install express"}'))
      expect(result.action).toBe("pass")
      expect(result.message).toBeUndefined()
    })

    test("rm on specific file passes (not rm -rf /)", async () => {
      const result = await runHook(entry(), makeEnv("bash", '{"command":"rm -rf ./node_modules"}'))
      expect(result.action).toBe("pass")
      expect(result.message).toBeUndefined()
    })
  })
})
