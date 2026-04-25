import { flag, list, num, stash, str } from "./guardrail-patterns"
import type { GuardrailContext } from "./guardrail-context"

const REVIEW_POLL_GAP = 750
const REVIEW_TIMEOUT_MS = 120_000

export function createReviewPipeline(ctx: GuardrailContext) {
  function reviewGate(data: Record<string, unknown>) {
    const glm = str(data.review_glm_state) === "done"
    const codex = str(data.review_codex_state) === "done"
    const pending: string[] = []
    if (!glm) pending.push("GLM code-reviewer")
    if (!codex) pending.push("Codex review")
    return {
      done: glm && codex,
      pending,
      message: pending.length === 0 ? "all reviews complete" : `pending: ${pending.join(" and ")}`,
    }
  }

  async function syncReviewState() {
    const data = await stash(ctx.state)
    const gate = reviewGate(data)
    await ctx.mark({
      review_state: gate.done ? "done" : "",
      ...(gate.done ? { edits_since_review: 0 } : {}),
    })
  }

  async function pollIdle(sessionID: string) {
    const start = Date.now()
    for (;;) {
      if (Date.now() - start > REVIEW_TIMEOUT_MS) {
        throw new Error(`Auto-review timed out after ${REVIEW_TIMEOUT_MS}ms`)
      }
      const stat = await ctx.input.client.session.status({ query: { directory: ctx.input.directory } })
      const item = stat.data?.[sessionID]
      if (!item || item.type === "idle") return
      await Bun.sleep(REVIEW_POLL_GAP)
    }
  }

  async function readResult(sessionID: string) {
    const msgs = await ctx.input.client.session.messages({
      path: { id: sessionID },
      query: { directory: ctx.input.directory },
    })
    const msg = [...(msgs.data ?? [])].reverse().find((item) => item.info.role === "assistant")
    if (!msg) return { text: "", error: "" }
    const text = msg.parts.filter((item) => item.type === "text").map((item) => item.text ?? "").join("\n")
    const error = msg.info.error?.data?.message ?? ""
    return { text: text.slice(0, 4000), error }
  }

  function parseFindings(raw: string) {
    const lines = raw.split("\n")
    let critical = 0, high = 0, medium = 0, low = 0
    for (const line of lines) {
      const item = line.trim()
      if (/\b(no|zero|0|none|without|aren't|isn't|not)\b/i.test(item)) continue
      if (/CRITICAL=\d|HIGH=\d|checklist|Guardrail mode/i.test(item)) continue
      if (/^[\s\-*]*\[?CRITICAL\]?[\s:*]/i.test(item) || /^\*\*CRITICAL\*\*/i.test(item)) critical++
      if (/^[\s\-*]*\[?HIGH\]?[\s:*]/i.test(item) || /^\*\*HIGH\*\*/i.test(item)) high++
      if (/^[\s\-*]*\[?MEDIUM\]?[\s:*]/i.test(item) || /^\*\*MEDIUM\*\*/i.test(item)) medium++
      if (/^[\s\-*]*\[?LOW\]?[\s:*]/i.test(item) || /^\*\*LOW\*\*/i.test(item)) low++
    }
    return { critical, high, medium, low, total: critical + high + medium + low }
  }

  async function autoReview(parentSession: string, data: Record<string, unknown>) {
    const made = await ctx.input.client.session.create({
      body: { parentID: parentSession, title: "Auto-review" },
      query: { directory: ctx.input.directory },
    })
    await ctx.input.client.session.promptAsync({
      path: { id: made.data.id },
      query: { directory: ctx.input.directory },
      body: {
        agent: "code-reviewer",
        tools: { edit: false, write: false, apply_patch: false, multiedit: false },
        parts: [{
          type: "text",
          text: `Review the current working directory changes for quality, correctness, and security.\nEdited files: ${list(data.edited_files).join(", ") || "unknown"}\nEdit count: ${num(data.edit_count)}\nReport findings as CRITICAL, HIGH, MEDIUM, or LOW.`,
        }],
      },
    })
    await pollIdle(made.data.id)
    const result = await readResult(made.data.id)
    if (result.error || !result.text.trim()) {
      await ctx.mark({ auto_review_in_progress: false })
      await ctx.seen("auto_review.errored", { error: result.error || "empty response" })
      return
    }
    const findings = parseFindings(result.text)
    const attempts = num(data.workflow_review_attempts) + 1
    if (attempts >= 3) {
      await ctx.mark({ auto_review_in_progress: false, workflow_phase: "blocked", workflow_review_attempts: attempts })
      await ctx.seen("auto_review.max_attempts", { attempts })
      return
    }
    await ctx.mark({
      auto_review_in_progress: false,
      auto_review_session: made.data.id,
      review_glm_state: "done",
      review_glm_at: new Date().toISOString(),
      reviewed: true,
      workflow_review_attempts: attempts,
      review_at: new Date().toISOString(),
      edits_since_review: 0,
      review_critical_count: findings.critical,
      review_high_count: findings.high,
    })
    await syncReviewState()
    await ctx.seen("auto_review.completed", { findings: findings.total, critical: findings.critical, high: findings.high })
    if (findings.critical > 0 || findings.high > 0) {
      await ctx.input.client.session.prompt({
        path: { id: parentSession },
        query: { directory: ctx.input.directory },
        body: {
          noReply: true,
          parts: [{
            type: "text",
            text: `[Auto-review] CRITICAL=${findings.critical} HIGH=${findings.high}. Fix findings before merging.\n\n${result.text.slice(0, 2000)}`,
          }],
        },
      })
      await ctx.mark({ workflow_phase: "fixing" })
    }
  }

  function checklist(data: Record<string, unknown>) {
    const items = [
      { name: "tests_pass", pass: flag(data.tests_executed) },
      { name: "review_glm", pass: str(data.review_glm_state) === "done" },
      { name: "review_codex", pass: str(data.review_codex_state) === "done" },
      { name: "review_fresh", pass: (str(data.review_glm_state) === "done" || str(data.review_codex_state) === "done") && num(data.edits_since_review) === 0 },
      { name: "ci_green", pass: flag(data.ci_green) },
      { name: "no_critical", pass: num(data.review_critical_count) === 0 && num(data.review_high_count) === 0 },
    ]
    return {
      score: items.filter((item) => item.pass).length,
      total: items.length,
      blocking: items.filter((item) => !item.pass).map((item) => item.name),
      summary: items.map((item) => `[${item.pass ? "x" : " "}] ${item.name}`).join(", "),
    }
  }

  async function handleAutoReviewTrigger(sessionID: string) {
    const data = await stash(ctx.state)
    const edits = num(data.edit_count)
    const pending = str(data.review_glm_state) !== "done"
    const inProgress = flag(data.auto_review_in_progress)
    if (edits < 3 || !pending || inProgress || !sessionID) return
    await ctx.mark({ auto_review_in_progress: true })
    await ctx.seen("auto_review.triggered", { edit_count: edits, sessionID })
    void autoReview(sessionID, data).catch(async (err) => {
      await ctx.mark({ auto_review_in_progress: false })
      await ctx.seen("auto_review.failed", { error: String(err) })
    })
  }

  async function handleCodexDetection(
    item: { tool: string; args?: Record<string, unknown> },
    out: { output: string },
  ) {
    if (item.tool !== "mcp__codex__codex") return
    const prompt = str(item.args?.prompt || item.args?.command || "")
    if (!/\b(review|code[\.\-_]review|diff[\.\-_]review)\b/i.test(prompt)) return
    const output = str(out.output).trim()
    if (!output || output.length < 20) {
      await ctx.seen("codex_review.empty_or_short", { length: output.length })
      return
    }
    const findings = parseFindings(output)
    await ctx.mark({
      reviewed: true,
      review_codex_state: "done",
      review_codex_at: new Date().toISOString(),
    })
    await syncReviewState()
    await ctx.seen("codex_review.completed", { critical: findings.critical, high: findings.high })
  }

  async function handleExternalReviewDetection(
    item: { tool: string; args?: Record<string, unknown> },
    out: { output: string; metadata?: Record<string, unknown> },
  ) {
    if (item.tool !== "bash") return
    const cmd = str(item.args?.command)
    const isOpenCodeReview = /\bopencode\s+run\b[\s\S]*\b(\/review|review|code-review|code-reviewer)\b/i.test(cmd)
    const isClaudeReviewer = /\bclaude\b[\s\S]*(--agent(?:=|\s+)code-reviewer|--agent(?:=|\s+)review)\b/i.test(cmd)
    if (!isOpenCodeReview && !isClaudeReviewer) return
    if (typeof out.metadata?.exitCode === "number" && out.metadata.exitCode !== 0) {
      await ctx.seen("external_review.failed", { command: cmd, exit_code: out.metadata.exitCode })
      return
    }
    const output = str(out.output).trim()
    if (!output || output.length < 20 || /Tool execution aborted/i.test(output)) {
      await ctx.seen("external_review.empty_or_aborted", { command: cmd, length: output.length })
      return
    }
    const findings = parseFindings(output)
    await ctx.mark({
      reviewed: true,
      review_at: new Date().toISOString(),
      review_agent: isClaudeReviewer ? "claude:code-reviewer" : "opencode:review",
      review_glm_state: "done",
      review_glm_at: new Date().toISOString(),
      edits_since_review: 0,
      review_critical_count: findings.critical,
      review_high_count: findings.high,
    })
    await syncReviewState()
    await ctx.seen("external_review.completed", {
      agent: isClaudeReviewer ? "claude:code-reviewer" : "opencode:review",
      critical: findings.critical,
      high: findings.high,
    })
  }

  return {
    autoReview,
    checklist,
    parseFindings,
    reviewGate,
    syncReviewState,
    handleAutoReviewTrigger,
    handleCodexDetection,
    handleExternalReviewDetection,
  }
}
