import type { GuardrailContext } from "./guardrail-context"

export type SkipSummary = {
  passed: number
  failed: number
  skipped: number
  criticalSkips: string[]
}

/** Structural detection of test runner invocations — not word-match on "test". */
export function isTestCommand(cmd: string) {
  return (
    /\bgo\s+test\b/i.test(cmd) ||
    /\bpytest\b/i.test(cmd) ||
    /\bvitest\b/i.test(cmd) ||
    /\bbun\s+test\b/i.test(cmd) ||
    /\bnpm\s+(?:run\s+)?test\b/i.test(cmd) ||
    /\byarn\s+(?:run\s+)?test\b/i.test(cmd) ||
    /\bpnpm\s+(?:run\s+)?test\b/i.test(cmd) ||
    /\bmise\s+run\s+test\b/i.test(cmd) ||
    /\bturbo\s+test\b/i.test(cmd)
  )
}

const CRITICAL_SKIP_LINE =
  /(?:skip(?:ped)?|t\.skip|SKIP).*?(?:database|postgres|mysql|sqlite|redis|_TEST_DATABASE|TEST_DATABASE|docker|unavailable|not\s+set|missing\s+env)/i
const CRITICAL_ENV_HINT =
  /(?:_TEST_DATABASE|TEST_DATABASE|DATABASE_URL|postgres(?:ql)?\s+unavailable|database.*(?:not set|missing|unset)|docker(?:\s+compose)?\s+(?:not|isn't)\s+running)/i

export function parseSkipSummary(output: string): SkipSummary {
  const text = output ?? ""
  let skipped = 0
  for (const match of text.matchAll(/\b(\d+)\s+skipped\b/gi)) skipped = Math.max(skipped, Number(match[1]) || 0)
  for (const match of text.matchAll(/\bskipped[:\s]+(\d+)\b/gi)) skipped = Math.max(skipped, Number(match[1]) || 0)
  if (skipped === 0) {
    skipped = [...text.matchAll(/---\s*SKIP:/gi)].length + [...text.matchAll(/\bt\.Skip\(/gi)].length
  }

  let passed = 0
  for (const match of text.matchAll(/\b(\d+)\s+passed\b/gi)) passed = Math.max(passed, Number(match[1]) || 0)
  for (const match of text.matchAll(/\bok\s+(\d+)\b/gi)) passed = Math.max(passed, Number(match[1]) || 0)

  let failed = 0
  for (const match of text.matchAll(/\b(\d+)\s+failed\b/gi)) failed = Math.max(failed, Number(match[1]) || 0)

  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  const criticalSkips = lines
    .filter((line) => CRITICAL_SKIP_LINE.test(line) || (skipped > 0 && CRITICAL_ENV_HINT.test(line)))
    .slice(0, 8)

  if (skipped === 0 && criticalSkips.length) skipped = criticalSkips.length

  return { passed, failed, skipped, criticalSkips }
}

export function testHonestyAdvisory(summary: SkipSummary) {
  if (summary.skipped <= 0 && !summary.criticalSkips.length) return
  const critical = summary.criticalSkips.length > 0
  const lines = [
    `⚠️ [TEST HONESTY — pattern L] Verification incomplete: ${summary.passed} passed, ${summary.failed} failed, ${summary.skipped} skipped.`,
    critical
      ? `Critical skips suggest DB/env proofs never ran:\n${summary.criticalSkips.map((line) => `  - ${line}`).join("\n")}`
      : `Skipped tests are not green proofs. Report skip counts explicitly before claiming verification.`,
    `Start the required services / set *_TEST_DATABASE_URL (or equivalent), re-run, and require skipped=0 for critical suites.`,
    `Set OPENCODE_TEST_HONESTY_GUARD=off to silence.`,
  ]
  return lines.join("\n")
}

/** CI wiring helper: required env keys must be present so CI cannot silently skip. */
export function missingCiDbEnv(env: NodeJS.ProcessEnv, required: string[] = ["TEST_DATABASE_URL", "DATABASE_URL"]) {
  return required.filter((key) => {
    const value = env[key]
    return !(typeof value === "string" && value.trim().length > 0)
  })
}

export function testHonestyGuardDisabled(env: NodeJS.ProcessEnv = process.env) {
  return /^(0|false|off|no)$/i.test(env.OPENCODE_TEST_HONESTY_GUARD ?? "")
}

export function createTestHonestyHandlers(ctx: GuardrailContext) {
  async function afterBash(item: { tool: string; args?: Record<string, unknown> }, out: { output?: string }) {
    if (testHonestyGuardDisabled()) return
    if (item.tool !== "bash") return
    const cmd = typeof item.args?.command === "string" ? item.args.command : ""
    if (!isTestCommand(cmd)) return
    const summary = parseSkipSummary(out.output || "")
    const message = testHonestyAdvisory(summary)
    if (!message) return
    out.output = `${out.output || ""}\n\n${message}`
    await ctx.mark({ test_honesty_advisory: message, test_skip_count: summary.skipped })
    await ctx.seen("test_honesty.skips", summary)
  }

  return { afterBash }
}
