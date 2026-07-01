import path from "path"
import { flag, git, list, num, save, stash, str } from "./guardrail-patterns"
import type { GuardrailContext } from "./guardrail-context"

const REVIEW_POLL_GAP = 750
const REVIEW_TIMEOUT_MS = 120_000
const REVIEW_EVIDENCE_FILE = "review-evidence.json"

export function createReviewPipeline(ctx: GuardrailContext) {
  function evidencePath() {
    return path.join(path.dirname(ctx.state), REVIEW_EVIDENCE_FILE)
  }

  function record(data: unknown) {
    if (data && typeof data === "object" && !Array.isArray(data)) return data as Record<string, unknown>
    return {}
  }

  function dirtyPath(line: string) {
    return line.slice(3).trim()
  }

  async function currentGitSnapshot() {
    const head = await git(ctx.input.worktree, ["rev-parse", "HEAD"])
    if (head.code !== 0 || !head.stdout.trim()) return
    const branch = await git(ctx.input.worktree, ["branch", "--show-current"])
    const status = await git(ctx.input.worktree, ["status", "--porcelain=v1", "--untracked-files=all"])
    const dirtyPaths =
      status.code === 0
        ? status.stdout
            .split(/\r?\n/)
            .map(dirtyPath)
            .filter((item) => item && !item.startsWith(".opencode/guardrails/"))
        : ["<git status failed>"]
    return {
      head: head.stdout.trim(),
      branch: branch.code === 0 ? branch.stdout.trim() : "",
      dirtyPaths,
      clean: dirtyPaths.length === 0,
    }
  }

  function reviewCounts(data: Record<string, unknown>, kind: "glm" | "codex", findings: ReturnType<typeof parseFindings>) {
    const glmCritical =
      kind === "glm"
        ? findings.critical
        : str(data.review_glm_state) === "done"
          ? num(data.review_glm_critical_count) || num(data.review_critical_count)
          : 0
    const glmHigh =
      kind === "glm"
        ? findings.high
        : str(data.review_glm_state) === "done"
          ? num(data.review_glm_high_count) || num(data.review_high_count)
          : 0
    const codexCritical =
      kind === "codex"
        ? findings.critical
        : str(data.review_codex_state) === "done"
          ? num(data.review_codex_critical_count) || num(data.review_critical_count)
          : 0
    const codexHigh =
      kind === "codex"
        ? findings.high
        : str(data.review_codex_state) === "done"
          ? num(data.review_codex_high_count) || num(data.review_high_count)
          : 0
    return {
      ...(kind === "glm"
        ? { review_glm_critical_count: findings.critical, review_glm_high_count: findings.high }
        : { review_codex_critical_count: findings.critical, review_codex_high_count: findings.high }),
      review_critical_count: Math.max(glmCritical, codexCritical),
      review_high_count: Math.max(glmHigh, codexHigh),
    }
  }

  async function saveReviewEvidence(data?: Record<string, unknown>) {
    const snapshot = await currentGitSnapshot()
    if (!snapshot) {
      await ctx.seen("review_evidence.not_saved", { reason: "git_head_unavailable" })
      return false
    }
    const current = data ?? (await stash(ctx.state))
    await save(evidencePath(), {
      version: 1,
      saved_at: new Date().toISOString(),
      reviewed: flag(current.reviewed),
      review_glm_state: str(current.review_glm_state),
      review_codex_state: str(current.review_codex_state),
      review_state: str(current.review_state),
      review_at: str(current.review_at),
      review_agent: str(current.review_agent),
      review_glm_at: str(current.review_glm_at),
      review_codex_at: str(current.review_codex_at),
      review_critical_count: num(current.review_critical_count),
      review_high_count: num(current.review_high_count),
      review_severe_count: num(current.review_critical_count) + num(current.review_high_count),
      review_glm_critical_count: num(current.review_glm_critical_count),
      review_glm_high_count: num(current.review_glm_high_count),
      review_codex_critical_count: num(current.review_codex_critical_count),
      review_codex_high_count: num(current.review_codex_high_count),
      head: snapshot.head,
      head_sha: snapshot.head,
      reviewed_head: snapshot.head,
      reviewed_head_sha: snapshot.head,
      review_branch: snapshot.branch,
      reviewed_branch: snapshot.branch,
      review_worktree_clean: snapshot.clean,
      review_dirty_count: snapshot.dirtyPaths.length,
      review_dirty_paths: snapshot.dirtyPaths,
    })
    await ctx.seen("review_evidence.saved", {
      head: snapshot.head,
      branch: snapshot.branch,
      clean: snapshot.clean,
      dirty_count: snapshot.dirtyPaths.length,
    })
    return true
  }

  async function restoreReviewEvidence(expectedHead?: string) {
    const snapshot = await currentGitSnapshot()
    if (!snapshot) {
      await ctx.seen("review_evidence.not_restored", { reason: "git_head_unavailable" })
      return false
    }
    if (!snapshot.clean) {
      await ctx.seen("review_evidence.not_restored", {
        reason: "dirty_worktree",
        dirty_count: snapshot.dirtyPaths.length,
      })
      return false
    }
    const evidence = record(
      await Bun.file(evidencePath())
        .json()
        .catch(() => ({})),
    )
    const reviewedHead =
      str(evidence.reviewed_head_sha) || str(evidence.reviewed_head) || str(evidence.head_sha) || str(evidence.head)
    if (!reviewedHead) {
      await ctx.seen("review_evidence.not_restored", { reason: "missing" })
      return false
    }
    if (reviewedHead !== snapshot.head) {
      await ctx.seen("review_evidence.not_restored", {
        reason: "head_mismatch",
        reviewed_head: reviewedHead,
        current_head: snapshot.head,
      })
      return false
    }
    if (expectedHead && reviewedHead !== expectedHead) {
      await ctx.seen("review_evidence.not_restored", {
        reason: "pr_head_mismatch",
        reviewed_head: reviewedHead,
        expected_head: expectedHead,
      })
      return false
    }
    if (evidence.review_worktree_clean === false || evidence.clean === false) {
      await ctx.seen("review_evidence.not_restored", { reason: "evidence_dirty_worktree" })
      return false
    }
    const current = await stash(ctx.state)
    const reviewGlm = str(evidence.review_glm_state) === "done" || str(current.review_glm_state) === "done"
    const reviewCodex = str(evidence.review_codex_state) === "done" || str(current.review_codex_state) === "done"
    const restored = {
      reviewed: flag(evidence.reviewed) || reviewGlm || reviewCodex,
      review_glm_state: reviewGlm ? "done" : "",
      review_codex_state: reviewCodex ? "done" : "",
      review_state: str(evidence.review_state),
      review_at: str(evidence.review_at),
      review_agent: str(evidence.review_agent),
      review_glm_at: str(evidence.review_glm_at) || str(current.review_glm_at),
      review_codex_at: str(evidence.review_codex_at) || str(current.review_codex_at),
      review_critical_count: num(evidence.review_critical_count),
      review_high_count: num(evidence.review_high_count),
      review_severe_count: num(evidence.review_severe_count),
      review_glm_critical_count: num(evidence.review_glm_critical_count),
      review_glm_high_count: num(evidence.review_glm_high_count),
      review_codex_critical_count: num(evidence.review_codex_critical_count),
      review_codex_high_count: num(evidence.review_codex_high_count),
      reviewed_head: reviewedHead,
      reviewed_head_sha: reviewedHead,
      review_evidence_head: reviewedHead,
      review_branch: str(evidence.review_branch) || str(evidence.reviewed_branch),
      reviewed_branch: str(evidence.reviewed_branch) || str(evidence.review_branch),
      review_worktree_clean: true,
      review_dirty_count: 0,
      review_dirty_paths: [],
      review_evidence_state: "restored",
      review_evidence_at: str(evidence.saved_at),
      edits_since_review: 0,
    }
    await ctx.mark(restored)
    await syncReviewState()
    await ctx.seen("review_evidence.restored", { head: reviewedHead, branch: restored.review_branch })
    return true
  }

  async function hydrateReviewEvidence(expectedHead?: string) {
    return restoreReviewEvidence(expectedHead)
  }

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
    const text = msg.parts
      .filter((item) => item.type === "text")
      .map((item) => item.text ?? "")
      .join("\n")
    const error = msg.info.error?.data?.message ?? ""
    return { text: text.slice(0, 4000), error }
  }

  function parseFindings(raw: string) {
    const lines = raw.split("\n")
    let critical = 0,
      high = 0,
      medium = 0,
      low = 0
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
        parts: [
          {
            type: "text",
            text: `Review the current working directory changes for quality, correctness, and security.\nEdited files: ${list(data.edited_files).join(", ") || "unknown"}\nEdit count: ${num(data.edit_count)}\nReport findings as CRITICAL, HIGH, MEDIUM, or LOW.`,
          },
        ],
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
      ...reviewCounts(data, "glm", findings),
    })
    await syncReviewState()
    await saveReviewEvidence()
    await ctx.seen("auto_review.completed", {
      findings: findings.total,
      critical: findings.critical,
      high: findings.high,
    })
    if (findings.critical > 0 || findings.high > 0) {
      await ctx.input.client.session.prompt({
        path: { id: parentSession },
        query: { directory: ctx.input.directory },
        body: {
          noReply: true,
          parts: [
            {
              type: "text",
              text: `[Auto-review] CRITICAL=${findings.critical} HIGH=${findings.high}. Fix findings before merging.\n\n${result.text.slice(0, 2000)}`,
            },
          ],
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
      {
        name: "review_fresh",
        pass:
          (str(data.review_glm_state) === "done" || str(data.review_codex_state) === "done") &&
          num(data.edits_since_review) === 0,
      },
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

  async function handleCodexDetection(item: { tool: string; args?: Record<string, unknown> }, out: { output: string }) {
    if (item.tool !== "mcp__codex__codex") return
    const prompt = str(item.args?.prompt || item.args?.command || "")
    if (!/\b(review|code[._-]review|diff[._-]review)\b/i.test(prompt)) return
    const output = str(out.output).trim()
    if (!output || output.length < 20) {
      await ctx.seen("codex_review.empty_or_short", { length: output.length })
      return
    }
    const findings = parseFindings(output)
    const data = await stash(ctx.state)
    const now = new Date().toISOString()
    await ctx.mark({
      reviewed: true,
      review_at: now,
      review_agent: "codex:mcp",
      review_codex_state: "done",
      review_codex_at: now,
      ...reviewCounts(data, "codex", findings),
    })
    await syncReviewState()
    await saveReviewEvidence()
    await ctx.seen("codex_review.completed", { critical: findings.critical, high: findings.high })
  }

  async function handleExternalReviewDetection(
    item: { tool: string; args?: Record<string, unknown> },
    out: { output: string; metadata?: Record<string, unknown> },
  ) {
    if (item.tool !== "bash") return
    const cmd = str(item.args?.command)
    const gstack = parseGstackReviewLog(cmd)
    if (gstack) {
      if (typeof out.metadata?.exitCode === "number" && out.metadata.exitCode !== 0) {
        await ctx.seen("gstack_review.failed", { command: cmd, exit_code: out.metadata.exitCode })
        return
      }
      if (gstack.failed) {
        await ctx.seen("gstack_review.not_passed", { skill: gstack.skill, status: gstack.status })
        return
      }
      const findings = parseFindings([cmd, str(out.output)].join("\n"))
      const now = new Date().toISOString()
      const data = await stash(ctx.state)
      await ctx.mark({
        reviewed: true,
        review_at: now,
        review_agent: `gstack:${gstack.skill}`,
        ...(gstack.kind === "codex"
          ? { review_codex_state: "done", review_codex_at: now, ...reviewCounts(data, "codex", findings) }
          : {
              review_glm_state: "done",
              review_glm_at: now,
              edits_since_review: 0,
              ...reviewCounts(data, "glm", findings),
            }),
      })
      await syncReviewState()
      await saveReviewEvidence()
      await ctx.seen("gstack_review.completed", {
        skill: gstack.skill,
        kind: gstack.kind,
        critical: findings.critical,
        high: findings.high,
      })
      return
    }
    const isOpenCodeReview = /\bopencode\s+run\b[\s\S]*\b(\/review|review|code-review|code-reviewer)\b/i.test(cmd)
    const isClaudeReviewer = /\bclaude\b[\s\S]*(--agent(?:=|\s+)code-reviewer|--agent(?:=|\s+)review)\b/i.test(cmd)
    const isSkillScriptReviewer = /\b(pr_analyzer|code_quality_checker)\.py\b/i.test(cmd)
    if (!isOpenCodeReview && !isClaudeReviewer && !isSkillScriptReviewer) return
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
    const now = new Date().toISOString()
    await ctx.mark({
      reviewed: true,
      review_at: now,
      review_agent: isClaudeReviewer
        ? "claude:code-reviewer"
        : isSkillScriptReviewer
          ? "code-reviewer:scripts"
          : "opencode:review",
      review_glm_state: "done",
      review_glm_at: now,
      edits_since_review: 0,
      ...reviewCounts(await stash(ctx.state), "glm", findings),
    })
    await syncReviewState()
    await saveReviewEvidence()
    await ctx.seen("external_review.completed", {
      agent: isClaudeReviewer
        ? "claude:code-reviewer"
        : isSkillScriptReviewer
          ? "code-reviewer:scripts"
          : "opencode:review",
      critical: findings.critical,
      high: findings.high,
    })
  }

  function parseGstackReviewLog(cmd: string) {
    if (!/\bgstack-review-log\b/.test(cmd)) return
    const skill = cmd.match(/["']skill["']\s*:\s*["']([^"']+)["']/i)?.[1] ?? ""
    if (!skill) return
    const status = cmd.match(/["']status["']\s*:\s*["']([^"']+)["']/i)?.[1] ?? ""
    const failed = /^(fail|failed|error|blocked|changes_requested|rejected)$/i.test(status)
    if (/^codex-review$/i.test(skill)) return { skill, kind: "codex" as const, status, failed }
    if (/^(code-reviewer|glm-review|review)$/i.test(skill)) return { skill, kind: "glm" as const, status, failed }
    return
  }

  return {
    autoReview,
    checklist,
    parseFindings,
    reviewGate,
    saveReviewEvidence,
    restoreReviewEvidence,
    hydrateReviewEvidence,
    syncReviewState,
    handleAutoReviewTrigger,
    handleCodexDetection,
    handleExternalReviewDetection,
  }
}
