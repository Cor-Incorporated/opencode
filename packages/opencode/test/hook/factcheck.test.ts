import path from "node:path"
import { describe, expect, test } from "bun:test"
import { runHook, type HookEnv } from "../../src/hook"

const SCRIPT_PATH = path.resolve(
  import.meta.dir,
  "../../../../.opencode/hooks/enforce-factcheck-before-edit.sh",
)

function makeEnv(toolName: string, toolInput: string): HookEnv {
  return {
    OPENCODE_HOOK_EVENT: "PreToolUse",
    OPENCODE_TOOL_NAME: toolName,
    OPENCODE_TOOL_INPUT: toolInput,
    OPENCODE_PROJECT_DIR: "/tmp/test",
    OPENCODE_SESSION_ID: "test-session",
  }
}

describe("enforce-factcheck-before-edit", () => {
  test("passes non-edit tools without message", async () => {
    const result = await runHook({ command: SCRIPT_PATH }, makeEnv("bash", "{}"))
    expect(result.action).toBe("pass")
    expect(result.message).toBeUndefined()
  })

  test("passes non-edit tool 'read'", async () => {
    const result = await runHook({ command: SCRIPT_PATH }, makeEnv("read", '{"file":"/tmp/x"}'))
    expect(result.action).toBe("pass")
    expect(result.message).toBeUndefined()
  })

  test("warns on Write without evidence", async () => {
    const result = await runHook(
      { command: SCRIPT_PATH },
      makeEnv("Write", '{"file_path":"/tmp/test.ts","content":"hello"}'),
    )
    expect(result.action).toBe("pass")
    expect(result.message).toContain("FACT-CHECK WARNING")
  })

  test("warns on edit without evidence", async () => {
    const result = await runHook(
      { command: SCRIPT_PATH },
      makeEnv("edit", '{"old_string":"foo","new_string":"bar"}'),
    )
    expect(result.action).toBe("pass")
    expect(result.message).toContain("FACT-CHECK WARNING")
  })

  test("passes Edit with evidence phrase 'based on reading'", async () => {
    const result = await runHook(
      { command: SCRIPT_PATH },
      makeEnv("Edit", '{"old_string":"based on reading the config"}'),
    )
    expect(result.action).toBe("pass")
    expect(result.message).toContain("Evidence of prior research detected")
  })

  test("passes Write with evidence phrase 'line 42'", async () => {
    const result = await runHook(
      { command: SCRIPT_PATH },
      makeEnv("Write", '{"content":"fix at line 42"}'),
    )
    expect(result.action).toBe("pass")
    expect(result.message).toContain("Evidence of prior research detected")
  })

  test("passes write with evidence phrase 'grep result'", async () => {
    const result = await runHook(
      { command: SCRIPT_PATH },
      makeEnv("write", '{"content":"grep result shows usage"}'),
    )
    expect(result.action).toBe("pass")
    expect(result.message).toContain("Evidence of prior research detected")
  })

  test("passes Edit with evidence phrase 'read tool output'", async () => {
    const result = await runHook(
      { command: SCRIPT_PATH },
      makeEnv("Edit", '{"old_string":"per read tool output"}'),
    )
    expect(result.action).toBe("pass")
    expect(result.message).toContain("Evidence of prior research detected")
  })

  test("never blocks (advisory only)", async () => {
    const result = await runHook(
      { command: SCRIPT_PATH },
      makeEnv("Write", '{"file_path":"/tmp/x","content":"no evidence here"}'),
    )
    expect(result.action).toBe("pass")
  })
})
