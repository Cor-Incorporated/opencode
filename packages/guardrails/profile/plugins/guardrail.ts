import path from "path"
import { createAccessHandlers } from "./guardrail-access"
import { createContext, type GuardrailInput } from "./guardrail-context"
import { createGitHandlers } from "./guardrail-git"
import { createInstrumentationHandlers } from "./guardrail-instrumentation"
import { createReviewPipeline } from "./guardrail-review"
import { flag, git, json, list, num, save, stash, str } from "./guardrail-patterns"

const OPENCODE_IGNORE = ".opencode/"

export function partID() {
  return `prt_${crypto.randomUUID()}`
}

export function teamWorkerWorktree(worktree: string) {
  return /(?:^|[\\/])\.opencode[\\/]team[\\/]/.test(worktree)
}

export async function ensureLocalOpencodeIgnored(worktree: string) {
  if (teamWorkerWorktree(worktree)) return false
  const projectIgnore = await Bun.file(path.join(worktree, ".gitignore"))
    .text()
    .catch(() => "")
  if (projectIgnore.includes(".opencode")) return false

  const target = await git(worktree, ["rev-parse", "--git-path", "info/exclude"]).catch(() => ({
    stdout: "",
    stderr: "",
    code: 1,
  }))
  if (target.code !== 0) return false

  const exclude = path.isAbsolute(target.stdout.trim())
    ? target.stdout.trim()
    : path.join(worktree, target.stdout.trim())
  const current = await Bun.file(exclude)
    .text()
    .catch(() => "")
  if (current.split(/\r?\n/).some((line) => line.trim() === OPENCODE_IGNORE || line.trim() === ".opencode")) {
    return false
  }

  await Bun.write(
    exclude,
    `${current}${current && !current.endsWith("\n") ? "\n" : ""}# OpenCode local state\n${OPENCODE_IGNORE}\n`,
  )
  return true
}

export default async function guardrail(input: GuardrailInput, opts?: Record<string, unknown>) {
  const ctx = await createContext(input, opts)
  const access = createAccessHandlers(ctx)
  const instrumentation = createInstrumentationHandlers(ctx)
  const review = createReviewPipeline(ctx)
  const gitHandlers = createGitHandlers(ctx, review)

  return {
    config: async (cfg: { provider?: Record<string, { whitelist?: string[] }> }) => {
      for (const key of Object.keys(ctx.allow)) delete ctx.allow[key]
      for (const [key, val] of Object.entries(cfg.provider ?? {})) {
        const ids = list(val.whitelist)
        if (!ids.length) continue
        ctx.allow[key] = new Set(ids)
      }
    },
    event: async ({ event }: { event: { type?: string; properties?: Record<string, unknown> } }) => {
      if (!event.type) return
      if (!["session.created", "permission.asked", "session.idle", "session.compacted"].includes(event.type)) return
      await ctx.seen(event.type, ctx.note(event.properties))
      if (event.type === "session.created") {
        const stacks: string[] = []
        try {
          const { existsSync } = await import("fs")
          if (existsSync(path.join(ctx.input.worktree, "package.json"))) stacks.push("node")
          if (
            existsSync(path.join(ctx.input.worktree, "pyproject.toml")) ||
            existsSync(path.join(ctx.input.worktree, "requirements.txt"))
          )
            stacks.push("python")
          if (existsSync(path.join(ctx.input.worktree, "go.mod"))) stacks.push("go")
          if (
            existsSync(path.join(ctx.input.worktree, "Dockerfile")) ||
            existsSync(path.join(ctx.input.worktree, "terraform"))
          )
            stacks.push("infra")
        } catch {}

        let branchWarning = ""
        try {
          const branchRes = await git(ctx.input.worktree, ["branch", "--show-current"])
          if (branchRes.code !== 0) throw new Error("git branch failed")
          const currentBranch = branchRes.stdout.trim()
          if (/^(main|master)$/.test(currentBranch)) {
            branchWarning = `WARNING: on ${currentBranch} branch. Create a feature branch: git checkout -b feat/<description> develop`
          } else if (currentBranch === "develop") {
            branchWarning =
              "On develop branch. Use feature branch for implementation: git checkout -b feat/<description>"
          }
        } catch {}

        await ctx.mark({
          last_session: event.properties?.sessionID,
          last_event: event.type,
          read_files: [],
          read_count: 0,
          edited_files: [],
          edit_count: 0,
          factchecked: false,
          factcheck_source: "",
          factcheck_at: "",
          edit_count_since_check: 0,
          reviewed: false,
          review_at: "",
          edits_since_review: 0,
          last_block: "",
          last_reason: "",
          git_freshness_checked: false,
          review_state: "",
          review_glm_state: "",
          review_codex_state: "",
          review_glm_at: "",
          review_codex_at: "",
          active_tasks: {},
          active_task_count: 0,
          llm_call_count: 0,
          llm_calls_by_provider: {},
          session_providers: [],
          consecutive_failures: 0,
          consecutive_fix_prs: 0,
          last_merge_at: "",
          issue_verification_done: false,
          edits_since_doc_reminder: 0,
          workflow_phase: "idle",
          workflow_review_attempts: 0,
          workflow_pr_url: "",
          workflow_issues_created: [],
          auto_review_in_progress: false,
          auto_review_session: "",
          review_critical_count: 0,
          review_high_count: 0,
          ci_green: false,
          detected_stacks: stacks,
          branch_warning: branchWarning,
          gitignore_missing_opencode: false,
          instrumentation_changes: false,
          instrumentation_files: [],
          instrumentation_quality_state: "",
          instrumentation_quality_blockers: [],
        })
        if (stacks.length > 0) {
          await ctx.seen("auto_init.stacks_detected", { stacks })
        }
        try {
          if (await ensureLocalOpencodeIgnored(ctx.input.worktree)) {
            await ctx.seen("ignore_hygiene.local_exclude_added", { pattern: OPENCODE_IGNORE })
          }
        } catch {}
        if (branchWarning) {
          await ctx.seen("branch_workflow.warning", { warning: branchWarning })
        }
        try {
          const settingsPath = path.join(process.env.HOME || "~", ".claude", "settings.json")
          const settings = JSON.parse(
            await Bun.file(settingsPath)
              .text()
              .catch(() => "{}"),
          )
          const mcpServers = settings.mcpServers ?? settings.mcp_servers ?? {}
          ctx.hasCodexMcp = Object.keys(mcpServers).some(
            (item) => /^codex$/i.test(item) || /^mcp[_-]codex$/i.test(item),
          )
          if (!ctx.hasCodexMcp) {
            await ctx.mark({ review_codex_state: "done", review_codex_at: "auto:no-codex-mcp" })
            await ctx.seen("codex_mcp.not_configured", { auto_satisfied: true })
          }
        } catch {}
      }
      if (event.type === "permission.asked") {
        await ctx.mark({
          last_permission: event.properties?.permission,
          last_patterns: event.properties?.patterns,
          last_event: event.type,
        })
      }
      if (event.type === "session.idle") {
        await review.handleAutoReviewTrigger(str(event.properties?.sessionID))
      }
      if (event.type === "session.compacted") {
        await ctx.mark({
          last_compacted: event.properties?.sessionID,
          last_event: event.type,
        })
      }
    },
    "chat.message": async (
      _item: { sessionID: string },
      out: {
        message: {
          id: string
          sessionID: string
          role: string
        }
        parts: {
          id: string
          sessionID: string
          messageID?: string
          type: string
          text: string
        }[]
      },
    ) => {
      if (out.message.role !== "user") return
      const data = await stash(ctx.state)
      const pendingFreshness = str(data.git_freshness_advisory)
      if (pendingFreshness) {
        out.parts.push({
          id: partID(),
          sessionID: out.message.sessionID,
          messageID: out.message.id,
          type: "text",
          text: pendingFreshness,
        })
        await ctx.mark({ git_freshness_advisory: "" })
      }
      if (!flag(data.git_freshness_checked)) {
        await ctx.mark({ git_freshness_checked: true })
        void (async () => {
          try {
            const proc = Bun.spawn(["git", "-C", ctx.input.worktree, "fetch", "--dry-run"], {
              stdout: "pipe",
              stderr: "pipe",
            })
            const fetchResult = await Promise.race([
              Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]).then(
                ([stdout, stderr, code]) => ({ stdout, stderr, code }),
              ),
              Bun.sleep(5000).then(() => {
                proc.kill()
                return null
              }),
            ])
            if (
              fetchResult &&
              fetchResult.code === 0 &&
              (fetchResult.stdout.trim() || fetchResult.stderr.includes("From"))
            ) {
              await ctx.mark({
                git_freshness_advisory:
                  "⚠️ Your branch may be behind origin. Consider running `git pull` before making changes.",
              })
            }
          } catch {}
        })()
      }
      const branchWarn = str(data.branch_warning)
      if (branchWarn) {
        const statusCheck = await git(ctx.input.worktree, ["status", "--porcelain"]).catch(() => ({
          stdout: "",
          stderr: "",
          code: 1,
        }))
        const dirty = statusCheck.stdout.trim().length > 0 && !statusCheck.stderr.trim()
        out.parts.push({
          id: partID(),
          sessionID: out.message.sessionID,
          messageID: out.message.id,
          type: "text",
          text: dirty
            ? `${branchWarn} Uncommitted changes detected — stash or commit before switching branches.`
            : branchWarn,
        })
        await ctx.mark({ branch_warning: "" })
      }
    },
    "tool.execute.before": async (
      item: { tool: string; args?: unknown; callID?: unknown },
      out: { args: Record<string, unknown>; output?: string },
    ) => {
      if (item.tool === "bash") {
        const bashData = await stash(ctx.state)
        await access.toolBeforeAccess(item, out, bashData)
        const cmd = typeof out.args?.command === "string" ? out.args.command : ""
        if (cmd) {
          await instrumentation.bashBeforeInstrumentation(cmd, bashData)
          await gitHandlers.bashBeforeGit(cmd, out, bashData)
        }
        return
      }
      await instrumentation.toolBeforeInstrumentation(item, out)
      await access.toolBeforeAccess(item, out)
    },
    "tool.execute.after": async (
      item: { tool: string; args?: Record<string, unknown>; callID?: unknown },
      out: { title: string; output: string; metadata: Record<string, unknown> },
    ) => {
      const now = new Date().toISOString()
      const data = await stash(ctx.state)

      try {
        const prevSha = str(data.state_sha256)
        if (prevSha) {
          const { state_sha256: _s, updated_at: _u, ...rest } = data
          const hasher = new Bun.CryptoHasher("sha256")
          hasher.update(JSON.stringify(rest))
          const actualSha = hasher.digest("hex")
          if (prevSha !== actualSha) {
            await ctx.seen("state_integrity.toctou_detected", { expected: prevSha, actual: actualSha })
          }
        }
      } catch {}

      if (item.tool === "plan_exit") {
        try {
          const currentPhase = str(data.workflow_phase)
          if (!currentPhase || currentPhase === "idle") {
            await ctx.mark({ workflow_phase: "implementing", workflow_review_attempts: 0 })
            await ctx.seen("workflow.plan_approved", { sessionID: "plan_exit" })
          }
          const taskCount = num(data.active_task_count)
          const hasDelegation =
            taskCount > 0 ||
            Object.keys(data)
              .filter((k) => k.startsWith("delegation_"))
              .some((k) => num(data[k]) > 0)
          if (!hasDelegation) {
            out.output =
              (out.output || "") +
              "\n\n⚠️ [DELEGATION ADVISORY] Plan approved without delegation assignments.\n" +
              "ADR-004 rules: 2+ independent tasks → Agent Team (TeamCreate), " +
              "1 large autonomous task → Codex CLI (route C), " +
              "review → code-reviewer + Codex CLI (route A). " +
              "Limits: sub-agents 5-7, Bash 3-4, Codex CLI 1. " +
              "Consider assigning delegation before implementing."
            await ctx.seen("delegation.plan_no_assignment", { task_count: taskCount })
          }
        } catch {}
      }

      await access.toolAfterAccess(item, out, data)
      await instrumentation.toolAfterInstrumentation(item, out, data)

      if (item.tool === "bash" && /\bgh\s+pr\s+checks\b/i.test(str(item.args?.command))) {
        const criticalMatches = out.output.match(/CRITICAL[=:]?\s*(\d+)/i)
        const highMatches = out.output.match(/HIGH[=:]?\s*(\d+)/i)
        const prNumMatch = str(item.args?.command).match(/\bgh\s+pr\s+checks\s+(\d+)/i)
        if (criticalMatches || highMatches || prNumMatch) {
          await ctx.mark({
            review_critical_count: criticalMatches ? parseInt(criticalMatches[1]) : 0,
            review_high_count: highMatches ? parseInt(highMatches[1]) : 0,
            review_pr_number: prNumMatch ? prNumMatch[1] : "",
            review_checks_at: now,
          })
        }
      }

      if (item.tool === "task") {
        const cmd = typeof item.args?.command === "string" ? item.args.command : ""
        const agent = typeof item.args?.subagent_type === "string" ? item.args.subagent_type : ""
        const rawOutput = str(out.output)
        const taskResultMatch = rawOutput.match(/<task_result>([\s\S]*?)<\/task_result>/)
        const payload = taskResultMatch ? taskResultMatch[1].trim() : rawOutput.trim()
        const reviewFailed =
          out.title === "Error" ||
          (typeof out.metadata?.exitCode === "number" && out.metadata.exitCode !== 0) ||
          payload.length < 20 ||
          /Tool execution aborted|review failed|^error\b/i.test(payload)
        if ((cmd === "review" || agent.includes("review")) && !reviewFailed) {
          const isCodexReview = /codex/i.test(agent) || /codex/i.test(cmd)
          if (isCodexReview) {
            await ctx.mark({
              reviewed: true,
              review_at: now,
              review_agent: agent,
              review_codex_state: "done",
              review_codex_at: now,
            })
          } else {
            await ctx.mark({
              reviewed: true,
              review_at: now,
              review_agent: agent,
              review_glm_state: "done",
              review_glm_at: now,
            })
          }
          await review.syncReviewState()
        } else if (cmd === "review" || agent.includes("review")) {
          await ctx.seen("task_review.not_completed", { agent, payload_length: payload.length })
        }
        const activeTasks = json(data.active_tasks)
        const callID = str(item.callID) || str(item.args?.callID) || ""
        if (callID && activeTasks[callID]) {
          delete activeTasks[callID]
          await ctx.mark({ active_tasks: activeTasks, active_task_count: Object.keys(activeTasks).length })
        } else if (Object.keys(activeTasks).length > 0) {
          const oldest = Object.entries(activeTasks).sort((a, b) => a[1] - b[1])[0]
          if (oldest) delete activeTasks[oldest[0]]
          await ctx.mark({ active_tasks: activeTasks, active_task_count: Object.keys(activeTasks).length })
        }
        const agentDelegations = num(data[`delegation_${agent}`])
        await ctx.mark({ [`delegation_${agent}`]: agentDelegations + 1 })
        if (agent && payload.length < 20) {
          out.output =
            (out.output || "") +
            "\n⚠️ Agent output appears empty or trivially short (" +
            payload.length +
            " chars). Verify the agent completed its task."
          await ctx.seen("verify_agent.short_output", { agent, payload_length: payload.length })
        }
      }

      await review.handleCodexDetection(item, out)
      await review.handleExternalReviewDetection(item, out)

      if (item.tool === "bash") {
        const secretPatterns: [RegExp, string][] = [
          [/AIzaSy[A-Za-z0-9_-]{33}/g, "google-api-key"],
          [/AKIA[A-Z0-9]{16}/g, "aws-access-key"],
          [/sk-[a-zA-Z0-9]{20,}/g, "openai-key"],
          [/ghp_[a-zA-Z0-9]{36}/g, "github-token"],
          [/gho_[a-zA-Z0-9]{36}/g, "github-oauth"],
          [/ghs_[a-zA-Z0-9]{36}/g, "github-app"],
          [/glpat-[a-zA-Z0-9-]{20,}/g, "gitlab-token"],
          [/xox[bprs]-[a-zA-Z0-9-]+/g, "slack-token"],
          [/npm_[a-zA-Z0-9]{36}/g, "npm-token"],
          [/-----BEGIN (RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/g, "private-key"],
          [
            /\b[A-Z_]*(?:KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL|PRIVATE)[A-Z_]*\s*=\s*["']?[A-Za-z0-9_\-+/=]{10,}["']?/gi,
            "env-secret",
          ],
        ]
        let output = str(out.output)
        let maskedCount = 0
        for (const [pattern, label] of secretPatterns) {
          const matches = output.match(pattern)
          if (matches && matches.length > 0) {
            output = output.replace(pattern, `[REDACTED:${label}]`)
            maskedCount += matches.length
          }
        }
        if (maskedCount > 0) {
          out.output = output
          await ctx.seen("secret_masked", { count: maskedCount })
        }
      }

      await gitHandlers.bashAfterGit(item, out, data)

      if (item.tool === "bash") {
        const cmd = str(item.args?.command)
        if (/\b(bun\s+test|bun\s+turbo\s+test|jest|vitest|pytest|go\s+test|cargo\s+test)\b/i.test(cmd)) {
          const exitCode = typeof out.metadata?.exitCode === "number" ? out.metadata.exitCode : undefined
          await ctx.mark({ tests_executed: true, last_test_at: now, last_test_exit: exitCode ?? "unknown" })
        }
        if (/\b(bun\s+turbo\s+typecheck|tsc|tsgo)\b/i.test(cmd)) {
          await ctx.mark({ type_checked: true, last_typecheck_at: now })
        }
        if (/\bgit\s+push\b/i.test(cmd)) {
          await ctx.mark({ last_push_at: now })
        }

        const output = str(out.output)
        const currentPhase = str(data.workflow_phase)
        const pipelineActive =
          currentPhase && currentPhase !== "idle" && currentPhase !== "done" && currentPhase !== "blocked"
        if (
          pipelineActive &&
          currentPhase === "implementing" &&
          /\bgh\s+pr\s+create\b/.test(cmd) &&
          output.includes("github.com")
        ) {
          const prUrl = output.trim().match(/https:\/\/github\.com\/[^\s]+/)
          if (prUrl) {
            await ctx.mark({ workflow_phase: "testing", workflow_pr_url: prUrl[0] })
            await ctx.seen("workflow.pr_created", { url: prUrl[0] })
            out.output += "\n\n[WORKFLOW] PR created. Next: run tests, then /review, then /ship."
          }
        }
        if (
          pipelineActive &&
          currentPhase === "testing" &&
          /\b(bun\s+test|pytest|go\s+test|npm\s+test|vitest|jest)\b/.test(cmd)
        ) {
          const testExit = out.metadata?.exitCode ?? (output.includes("FAIL") ? 1 : 0)
          if (testExit === 0 && !output.includes("FAIL")) {
            await ctx.mark({ workflow_phase: "reviewing", tests_executed: true })
            await ctx.seen("workflow.tests_passed", {})
            out.output += "\n\n[WORKFLOW] Tests passed. Next: run /review."
          }
        }
        if (
          pipelineActive &&
          currentPhase === "shipping" &&
          /\bgh\s+pr\s+merge\b/.test(cmd) &&
          !output.includes("error") &&
          !output.includes("failed")
        ) {
          await ctx.mark({ workflow_phase: "done" })
          await ctx.seen("workflow.merged", {})
          out.output += "\n\n[WORKFLOW] Merge complete. Create follow-up issues for any discovered problems."
        }
        if (pipelineActive && /\bgh\s+pr\s+checks\b/.test(cmd)) {
          const allPass =
            !/\b(fail(?:ed|ing)?|pending|queued|in[_ -]?progress|neutral|skipped|cancel(?:led|ed)|timed[_ -]?out|action[_ -]?required|startup[_ -]?failure|stale)\b/i.test(
              output,
            )
          await ctx.mark({ ci_green: allPass })
        }
        if (/\bgh\s+issue\s+create\b/.test(cmd) && output.includes("github.com")) {
          const issueUrl = output.trim().match(/https:\/\/github\.com\/[^\s]+/)
          if (issueUrl) {
            const created = list(data.workflow_issues_created)
            created.push(issueUrl[0])
            await ctx.mark({ workflow_issues_created: created })
            await ctx.seen("workflow.issue_created", { url: issueUrl[0] })
          }
        }
      }

      try {
        const finalData = await stash(ctx.state)
        if (finalData && typeof finalData === "object" && !Array.isArray(finalData)) {
          const { state_sha256: _s, updated_at: _u, ...rest } = finalData
          const hasher = new Bun.CryptoHasher("sha256")
          hasher.update(JSON.stringify(rest))
          await save(ctx.state, { ...finalData, state_sha256: hasher.digest("hex"), updated_at: now })
        } else {
          await ctx.seen("state_integrity.corrupted", { reason: Array.isArray(finalData) ? "array" : "non-object" })
          await save(ctx.state, { mode: ctx.mode, repaired_at: now, repair_reason: "corrupted state repaired" })
        }
      } catch {
        await ctx.seen("state_integrity.parse_error", { file: ctx.state })
        await save(ctx.state, { mode: ctx.mode, repaired_at: now, repair_reason: "JSON parse failure" })
      }
    },
    "command.execute.before": async (
      item: { command: string; sessionID: string; arguments: string },
      out: {
        parts: {
          type?: string
          prompt?: string
        }[]
      },
    ) => {
      if (item.command === "implement" || item.command === "auto") {
        await ctx.mark({ workflow_phase: "implementing", workflow_review_attempts: 0 })
        await ctx.seen("workflow.started", { command: item.command })
        const wfPart = out.parts.find((part) => part.type === "subtask" && typeof part.prompt === "string")
        if (wfPart) {
          wfPart.prompt =
            (wfPart.prompt || "") +
            "\n\nAfter implementation:\n" +
            "1. Run relevant tests (bun test / pytest / go test)\n" +
            "2. Create a PR with proper branch naming\n" +
            "3. Run /review and address CRITICAL/HIGH findings (max 3 cycles)\n" +
            "4. Run /ship to merge\n" +
            "5. Create follow-up issues for out-of-scope problems\n" +
            "Do NOT stop until the pipeline completes or a hard blocker is hit."
        }
      }
      if (
        item.command === "implement" ||
        item.command === "auto" ||
        item.command === "review" ||
        item.command === "ship"
      ) {
        const instrumentationPart = out.parts.find((part) => part.type === "subtask" && typeof part.prompt === "string")
        if (instrumentationPart?.prompt) {
          instrumentationPart.prompt =
            instrumentationPart.prompt +
            "\n\nInstrumentation quality gate:\n" +
            "- AI agent instrumentation must use source-level hooks, not global monkey patches.\n" +
            "- Instrumentation/cross-cutting PRs require an integration or smoke test.\n" +
            "- Include a traceability matrix from acceptance criteria to implementation.\n" +
            "- Document each metric's semantics and source code path.\n" +
            "- Do not claim unmeasurable metrics; return an explicit unavailable reason instead of null.\n" +
            "- Probe optional dependencies before use and clean up resources with finally/cleanup paths."
        }
      }
      if (!["review", "ship", "handoff", "implement", "auto"].includes(item.command)) return
      const data = await stash(ctx.state)
      const part = out.parts.find((item) => item.type === "subtask" && typeof item.prompt === "string")
      if (!part?.prompt) return
      part.prompt = `${part.prompt}\n\n${ctx.compact(data)}`
    },
    "shell.env": async (_item: { cwd: string }, out: { env: Record<string, string> }) => {
      out.env.OPENCODE_GUARDRAIL_MODE = ctx.mode
      out.env.OPENCODE_GUARDRAIL_ROOT = ctx.root
      out.env.OPENCODE_GUARDRAIL_STATE = ctx.state
    },
    "chat.params": async (
      item: {
        sessionID: string
        agent: string
        model: {
          id: string
          providerID: string
          status: "alpha" | "beta" | "deprecated" | "active"
          cost: {
            input: number
            output: number
            cache: { read: number; write: number }
          }
        }
      },
      _out: {
        temperature?: number
        topP?: number
        topK?: number
        maxOutputTokens?: number | undefined
        options: Record<string, unknown>
      },
    ) => {
      const err = ctx.gate(item)
      if (err) {
        await ctx.mark({
          last_block: "chat.params",
          last_provider: item.model.providerID,
          last_model: item.model.id,
          last_agent: item.agent,
          last_reason: err,
        })
        throw new Error(`Guardrail policy blocked this action: ${err}`)
      }

      const provider = str(item.model.providerID)
      const modelId = str(item.model.id)
      const tier = ctx.agentModelTier[item.agent]
      if (tier && modelId) {
        const currentTier = Object.entries(ctx.tierModels).find(([, models]) => models.includes(modelId))?.[0]
        if (currentTier) {
          const tierOrder = { high: 3, standard: 2, low: 1 }
          const expected = tierOrder[tier] ?? 2
          const actual = tierOrder[currentTier as keyof typeof tierOrder] ?? 2
          if (expected > actual) {
            const recommended = ctx.tierModels[tier] ?? []
            await ctx.seen("delegation.model_mismatch", {
              agent: item.agent,
              expected_tier: tier,
              actual_tier: currentTier,
              model: modelId,
              provider,
              recommended: recommended.slice(0, 3),
            })
            await ctx.mark({
              last_model_mismatch: `${item.agent} (${tier}-tier) running on ${modelId} (${currentTier}-tier). Recommended: ${recommended.slice(0, 3).join(", ")}`,
            })
          }
          if (expected < actual && tier === "low" && currentTier === "high") {
            await ctx.seen("delegation.cost_waste", {
              agent: item.agent,
              tier,
              model: modelId,
              provider,
            })
          }
        }
        const providerTiers: Record<string, string[]> = {
          high: ["zai-coding-plan", "openai"],
          standard: ["zai-coding-plan", "openai", "openrouter"],
          low: ["openrouter", "zai-coding-plan"],
        }
        const recommendedProviders = providerTiers[tier] ?? []
        if (recommendedProviders.length > 0 && !recommendedProviders.includes(provider)) {
          await ctx.seen("delegation.provider_suboptimal", {
            agent: item.agent,
            tier,
            current_provider: provider,
            recommended_providers: recommendedProviders,
          })
        }
      }

      const data = await stash(ctx.state)
      const llmCalls = num(data.llm_call_count) + 1
      const providerCalls = json(data.llm_calls_by_provider)
      providerCalls[provider] = (providerCalls[provider] ?? 0) + 1
      const sessionProviders = list(data.session_providers)
      const updatedProviders = sessionProviders.includes(provider) ? sessionProviders : [...sessionProviders, provider]
      await ctx.mark({
        llm_call_count: llmCalls,
        llm_calls_by_provider: providerCalls,
        session_providers: updatedProviders,
        last_provider: provider,
        last_model: modelId,
        last_agent: item.agent,
      })
    },
    "experimental.session.compacting": async (
      _item: { sessionID: string },
      out: { context: string[]; prompt?: string },
    ) => {
      const data = await stash(ctx.state)
      out.context.push(
        [
          `Guardrail mode: ${ctx.mode}.`,
          `Preserve policy state from ${ctx.state.replace(ctx.input.worktree + "/", "")} when handing work to the next agent.`,
          `Last guardrail event: ${str(data.last_event) || "none"}.`,
          `Last guardrail block: ${str(data.last_block) || "none"}.`,
          `Unique source reads: ${num(data.read_count)}.`,
          `Edit/write count: ${num(data.edit_count)}.`,
          `Fact-check state: ${ctx.factLine(data)}.`,
          `Review state: ${ctx.reviewLine(data)}.`,
          `Workflow phase: ${str(data.workflow_phase) || "idle"}.`,
          `Workflow PR: ${str(data.workflow_pr_url) || "none"}.`,
          `Review attempts: ${num(data.workflow_review_attempts)}.`,
          `Auto-review: ${flag(data.auto_review_in_progress) ? "in-progress" : "idle"}.`,
          `Active tasks: ${num(data.active_task_count)} (Map entries: ${Object.keys(json(data.active_tasks)).length}).`,
          `LLM calls: ${num(data.llm_call_count)} (by provider: ${JSON.stringify(json(data.llm_calls_by_provider))}).`,
          `Providers used: ${list(data.session_providers).join(", ") || "none"}.`,
          `Last model mismatch: ${str(data.last_model_mismatch) || "none"}.`,
          `Consecutive failures: ${num(data.consecutive_failures)}.`,
        ].join(" "),
      )
    },
    "experimental.chat.system.transform": async (_item: {}, out: { system: string[] }) => {
      const data = await stash(ctx.state)
      const phase = str(data.workflow_phase)
      if (phase && phase !== "idle" && phase !== "done") {
        out.system.push(
          "[WORKFLOW] Phase: " +
            phase +
            ". Pipeline: implement→test→review→fix→ship. Complete autonomously. Do not stop at PR creation.",
        )
        out.system.push(
          "When you discover problems outside the current scope, create follow-up issues: `gh issue create --title '<desc>' --body '<details>' --label 'tech-debt'`. Do NOT fix out-of-scope problems inline.",
        )
      }
      out.system.push(
        "[DELEGATION] ADR-004 rules: " +
          "2+ independent tasks → Agent Team (TeamCreate, max 5). " +
          "1 large autonomous task → Codex CLI (route C). " +
          "Review → code-reviewer + Codex CLI (route A). " +
          "Limits: sub-agents 5-7, Bash 3-4, Codex CLI 1, total 7. " +
          "Include delegation assignments in plans. Do not self-implement everything.",
      )
    },
  }
}
