import { describe, expect, test } from "bun:test"
import {
  bashTouchesProtectedSecrets,
  pathLikeToken,
} from "../../../guardrails/profile/plugins/guardrail-patterns"

describe("OC-D1 path-aware secret detection", () => {
  test("blocks cat of secret paths", () => {
    expect(bashTouchesProtectedSecrets("cat .env")).toBe(true)
    expect(bashTouchesProtectedSecrets("cat creds/id_rsa")).toBe(true)
  })

  test("allows searching for the word credentials (red→green)", () => {
    expect(bashTouchesProtectedSecrets("grep -rn credentials docs/")).toBe(false)
    expect(bashTouchesProtectedSecrets("rg credentials packages/")).toBe(false)
  })

  test("allows .env.example mention under secEnvExempt", () => {
    expect(bashTouchesProtectedSecrets("echo update .env.example")).toBe(false)
  })

  test("pathLikeToken recognises secret basenames", () => {
    expect(pathLikeToken(".env")).toBe(true)
    expect(pathLikeToken("credentials")).toBe(false)
    expect(pathLikeToken("docs/credentials.json")).toBe(true)
  })
})

describe("OC-D2 interpreter condition (unit of policy expression)", () => {
  function shouldBlockInterpreter(cmd: string) {
    const inline =
      /(?:^|[;&|]\s*|\s)(?:(?:python|python3|ruby|perl)\s+-[A-Za-z]*[ce]|node\s+(?:-[A-Za-z]*e|--eval\b)|bun\s+(?:-[A-Za-z]*e|--eval\b)|deno\s+eval\b|(?:sh|bash|zsh)\s+-c\b)/i.test(
        cmd,
      )
    return inline && cmd.includes(".opencode/guardrails")
  }

  test("plain python one-liner allowed", () => {
    expect(shouldBlockInterpreter('python3 -c "print(1+1)"')).toBe(false)
  })

  test("interpreter targeting guardrail runtime still blocked", () => {
    expect(
      shouldBlockInterpreter(`python3 -c "open('.opencode/guardrails/state.json','w')"`),
    ).toBe(true)
  })
})
