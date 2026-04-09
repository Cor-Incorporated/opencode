import path from "path"
import { MUTATING_TOOLS, bash, cfg, has, json, list, num, pick, rel, sec, stash, str, text } from "./guardrail-patterns"
import type { GuardrailContext } from "./guardrail-context"

export function createAccessHandlers(ctx: GuardrailContext) {
  async function toolBeforeAccess(
    item: { tool: string; args?: unknown; callID?: unknown },
    out: { args: Record<string, unknown> },
    data?: Record<string, unknown>,
  ) {
    const file = pick(out.args ?? item.args)
    if (file && (item.tool === "read" || MUTATING_TOOLS.has(item.tool))) {
      const err = ctx.deny(file, item.tool === "read" ? "read" : "edit")
      if (err) {
        await ctx.mark({ last_block: item.tool, last_file: rel(ctx.input.worktree, file), last_reason: err })
        throw new Error(text(err))
      }
    }

    if (MUTATING_TOOLS.has(item.tool)) {
      const err = await ctx.version(out.args ?? {})
      if (err) {
        await ctx.mark({ last_block: item.tool, last_file: file ? rel(ctx.input.worktree, file) : "", last_reason: err })
        throw new Error(text(err))
      }
    }

    if (MUTATING_TOOLS.has(item.tool) && file && ctx.code(file)) {
      const count = await ctx.budget()
      if (count >= 4) {
        const budgetData = await stash(ctx.state)
        const readFiles = list(budgetData.read_files).slice(-5).join(", ")
        const err = `context budget exceeded after ${count} source reads (recent: ${readFiles || "unknown"}). Recovery options:\n(1) call \`team\` tool to delegate edit to isolated worker\n(2) use \`background\` tool for side work\n(3) narrow edit scope to a specific function/section rather than whole file\n(4) start a new session and continue from where you left off`
        await ctx.mark({ last_block: item.tool, last_file: rel(ctx.input.worktree, file), last_reason: err })
        throw new Error(text(err))
      }
    }

    if (item.tool === "bash") {
      const cmd = typeof out.args?.command === "string" ? out.args.command : ""
      const file = cmd.replaceAll("\\", "/")
      if (!cmd) return
      if (has(file, sec) || file.includes(".opencode/guardrails/")) {
        await ctx.mark({ last_block: "bash", last_command: cmd, last_reason: "shell access to protected files" })
        throw new Error(text("shell access to protected files"))
      }
      if (/\bdocker\s+build\b/i.test(cmd)) {
        const secretPatterns = [
          /^(AKIA[A-Z0-9]{16})/,
          /^(sk-[a-zA-Z0-9]{20,})/,
          /^(ghp_[a-zA-Z0-9]{36})/,
          /^(gho_[a-zA-Z0-9]{36})/,
          /^(ghs_[a-zA-Z0-9]{36})/,
          /^(glpat-[a-zA-Z0-9-]{20,})/,
          /^(xox[bprs]-[a-zA-Z0-9-]+)/,
          /^(npm_[a-zA-Z0-9]{36})/,
          /BEGIN\s+(RSA|EC|PRIVATE)/,
        ]
        const buildArgMatches = cmd.matchAll(/--build-arg\s+(\w+)=(\S+)/gi)
        for (const item of buildArgMatches) {
          const argName = item[1].toUpperCase()
          const argValue = item[2]
          const nameHit = /(SECRET|TOKEN|KEY|PASSWORD|CREDENTIAL|API_KEY|PRIVATE|AUTH)/i.test(argName)
          const valueHit = secretPatterns.some((pattern) => pattern.test(argValue))
          if (nameHit || valueHit) {
            await ctx.mark({ docker_secret_warning: true, docker_secret_arg: item[1], last_block: "bash", last_reason: "docker secret in build-arg" })
            await ctx.seen("docker.secret_in_build_arg", { arg_name: item[1], pattern: "redacted" })
            throw new Error(text("docker build --build-arg contains secrets: use Docker build secrets (--secret) or multi-stage builds instead"))
          }
        }
      }
      if (!bash(cmd)) return
      if (!cfg.some((rule) => rule.test(file)) && !file.includes(".opencode/guardrails/")) return
      await ctx.mark({ last_block: "bash", last_command: cmd, last_reason: "protected runtime or config mutation" })
      throw new Error(text("protected runtime or config mutation"))
    }

    if (item.tool === "write" && file) {
      const relFile = rel(ctx.input.worktree, file)
      const content = typeof out.args?.content === "string" ? out.args.content : ""
      if (/seed_knowledge|knowledge\.(yaml|yml|json)$/i.test(relFile)) {
        if (content && /(電話|phone|営業時間|hours|休[館日]|holiday|料金|price|住所|address)/i.test(content)) {
          if (!/(verified|検証済|参照元|source:|ref:)/i.test(content)) {
            await ctx.mark({ last_block: "write", last_file: relFile, last_reason: "seed data without verification source" })
            throw new Error(text("knowledge/seed data write blocked: content contains factual claims without verification source. Add 'verified' or 'source:' comment."))
          }
        }
      }
    }

    if (item.tool === "task") {
      const taskData = data ?? await stash(ctx.state)
      const activeTasks = json(taskData.active_tasks)
      const staleThreshold = 5 * 60 * 1000
      for (const [id, ts] of Object.entries(activeTasks)) {
        if (typeof ts === "number" && Date.now() - ts > staleThreshold) {
          await ctx.seen("delegation.stale_reset", { task_id: id, age_ms: Date.now() - ts })
          delete activeTasks[id]
        }
      }
      const activeCount = Object.keys(activeTasks).length
      if (activeCount >= ctx.maxParallelTasks) {
        const err = `parallel task limit reached (${activeCount}/${ctx.maxParallelTasks}); wait for a running task to complete before delegating more`
        await ctx.mark({ last_block: "task", last_reason: err, active_tasks: activeTasks })
        throw new Error(text(err))
      }
      const callID = str(item.callID) || str((item.args as Record<string, unknown>)?.callID) || `task_${Date.now()}`
      activeTasks[callID] = Date.now()
      await ctx.mark({ active_tasks: activeTasks, active_task_count: Object.keys(activeTasks).length })
    }

    if (item.tool === "write" && file) {
      const relFile = rel(ctx.input.worktree, file)
      const fileName = path.basename(relFile)
      for (const [dir, pattern] of Object.entries(ctx.domainDirs)) {
        if (relFile.startsWith(dir) && !pattern.test(fileName)) {
          await ctx.mark({ domain_naming_warning: relFile, domain_naming_expected: pattern.source, domain_naming_dir: dir })
          await ctx.seen("domain_naming.mismatch", { file: relFile, expected_pattern: pattern.source, dir })
        }
      }
    }
  }

  async function toolAfterAccess(
    item: { tool: string; args?: Record<string, unknown>; callID?: unknown },
    out: { title: string; output: string; metadata: Record<string, unknown> },
    data: Record<string, unknown>,
  ) {
    const now = new Date().toISOString()
    const file = pick(item.args)

    if (item.tool === "read" && file) {
      if (ctx.code(file)) {
        const seenFiles = list(data.read_files)
        const relFile = rel(ctx.input.worktree, file)
        const next = seenFiles.includes(relFile) ? seenFiles : [...seenFiles, relFile]
        await ctx.mark({
          read_files: next,
          read_count: next.length,
          last_read: relFile,
        })
      }
      if (ctx.fact(file)) {
        await ctx.mark({
          factchecked: true,
          factcheck_source: "DocRead",
          factcheck_at: now,
          edit_count_since_check: 0,
        })
      }
    }

    if (item.tool === "webfetch" || item.tool.startsWith("mcp__context7__")) {
      await ctx.mark({
        factchecked: true,
        factcheck_source: item.tool === "webfetch" ? "WebFetch" : "Context7",
        factcheck_at: now,
        edit_count_since_check: 0,
      })
    }

    if (item.tool === "bash") {
      const cmd = str(item.args?.command)
      if (/(^|&&|\|\||;)\s*(gcloud|kubectl|aws)\s+/i.test(cmd)) {
        await ctx.mark({
          factchecked: true,
          factcheck_source: "CLI",
          factcheck_at: now,
          edit_count_since_check: 0,
        })
      }
      if (bash(cmd)) {
        await ctx.mark({
          edits_since_review: num(data.edits_since_review) + 1,
          review_glm_state: "",
          review_codex_state: ctx.hasCodexMcp ? "" : "done",
          review_state: "",
        })
      }
    }

    if (MUTATING_TOOLS.has(item.tool) && file) {
      const editedFiles = list(data.edited_files)
      const relFile = rel(ctx.input.worktree, file)
      const next = editedFiles.includes(relFile) ? editedFiles : [...editedFiles, relFile]
      const nextEditCount = num(data.edit_count) + 1
      await ctx.mark({
        edited_files: next,
        edit_count: nextEditCount,
        edit_count_since_check: num(data.edit_count_since_check) + 1,
        edits_since_review: num(data.edits_since_review) + 1,
        last_edit: relFile,
        review_glm_state: "",
        review_codex_state: ctx.hasCodexMcp ? "" : "done",
        review_state: "",
      })

      if (/\.(test|spec)\.(ts|tsx|js|jsx)$|(^|\/)test_.*\.py$|_test\.go$/.test(relFile)) {
        out.output += "\n\n🧪 Test file modified. Verify this test actually FAILS without the fix (test falsifiability)."
      }
      if (ctx.code(file) && nextEditCount > 0 && nextEditCount % 3 === 0) {
        out.output += "\n\n📝 Source code edited (3+ operations). Check if related documentation (README, AGENTS.md, ADRs) needs updating."
      }
      if (ctx.code(file) && nextEditCount >= 3 && nextEditCount % 3 === 0) {
        out.output = (out.output || "") + "\n🎨 " + nextEditCount + " source edits — consider running formatter (`prettier --write`, `biome format`, `go fmt`)."
      }
    }

    if (MUTATING_TOOLS.has(item.tool) && file && ctx.code(file)) {
      const relFile = rel(ctx.input.worktree, file)
      const content = typeof item.args?.content === "string" ? item.args.content :
        typeof item.args?.newString === "string" ? item.args.newString : ""
      if (content) {
        const isUI = /^(src\/(ui|components|tui)\/)/i.test(relFile)
        const isAPI = /^(src\/(api|routes)\/)/i.test(relFile)
        const importsDB = /from\s+['"].*\/(db|database|model|sql)\//i.test(content)
        const importsUI = /from\s+['"].*\/(ui|components|tui)\//i.test(content)
        if (isUI && importsDB) {
          out.output += "\n⚠️ Architecture: UI layer importing from DB layer directly. Consider using a service/repository layer."
        }
        if (isAPI && importsUI) {
          out.output += "\n⚠️ Architecture: API layer importing from UI layer. This creates a circular dependency risk."
        }
      }
    }

    if (item.tool === "write" && file) {
      const fresh = await stash(ctx.state)
      const warningFile = str(fresh.domain_naming_warning)
      if (warningFile && warningFile === rel(ctx.input.worktree, file)) {
        out.output = (out.output || "") + "\n📛 Domain naming mismatch: " + warningFile + " does not match expected pattern /" + str(fresh.domain_naming_expected) + "/ for " + str(fresh.domain_naming_dir)
        await ctx.mark({ domain_naming_warning: "" })
      }
    }

    if (MUTATING_TOOLS.has(item.tool) && file && ctx.code(file)) {
      const relFile = rel(ctx.input.worktree, file)
      const content = typeof item.args?.content === "string" ? item.args.content :
        typeof item.args?.newString === "string" ? item.args.newString : ""
      if (content && /\b(router\.(get|post|put|patch|delete)|app\.(get|post|put|patch|delete)|fetch\(|axios\.|\.handler)\b/i.test(content)) {
        out.output = (out.output || "") + "\n🔄 Endpoint modification detected in " + relFile + ". Verify 4-point dataflow: client → API route → backend action → response format."
        await ctx.seen("endpoint_dataflow.modified", { file: relFile })
      }
    }

    if (MUTATING_TOOLS.has(item.tool) && file && ctx.code(file)) {
      const editsSinceDocCheck = num(data.edits_since_doc_reminder)
      if (editsSinceDocCheck >= 5) {
        out.output = (out.output || "") + "\n📄 " + (editsSinceDocCheck + 1) + " source edits since last doc check. Grep for references to modified files in docs/ and README."
        await ctx.mark({ edits_since_doc_reminder: 0 })
      } else {
        await ctx.mark({ edits_since_doc_reminder: editsSinceDocCheck + 1 })
      }
    }

    if (item.tool === "bash" && /\b(gh\s+issue\s+close)\b/i.test(str(item.args?.command))) {
      const reviewed = data.reviewed === true
      const factchecked = data.factchecked === true
      if (!reviewed || !factchecked) {
        out.output = (out.output || "") + "\n⚠️ Issue close without full verification: reviewed=" + reviewed + ", factchecked=" + factchecked + ". Ensure acceptance criteria have code-level evidence."
        await ctx.seen("task_completion.incomplete", { reviewed, factchecked })
      }
      if (reviewed && factchecked) {
        await ctx.mark({ issue_verification_done: true })
      }
    }

    if (item.tool === "bash" && /\bdocker\s+build\b/i.test(str(item.args?.command))) {
      const fresh = await stash(ctx.state)
      if (fresh.docker_secret_warning === true) {
        out.output = (out.output || "") + "\n🔐 Security: --build-arg '" + str(fresh.docker_secret_arg) + "' may contain secrets. Use Docker build secrets (--secret) or multi-stage builds instead."
        await ctx.mark({ docker_secret_warning: false })
      }
    }

    const exitCode = typeof out.metadata?.exitCode === "number" ? out.metadata.exitCode : undefined
    const isBashFail = item.tool === "bash" && exitCode !== undefined && exitCode !== 0
    const isToolError = out.title === "Error" || (typeof out.metadata?.error === "string" && out.metadata.error !== "")
    if (isBashFail || isToolError) {
      const failures = num(data.consecutive_failures) + 1
      await ctx.mark({ consecutive_failures: failures, last_failure_tool: item.tool })
      if (failures >= 3) {
        out.output = (out.output || "") + "\n⚠️ " + failures + " consecutive tool failures detected. Consider: (1) checking error root cause, (2) trying alternate approach, (3) delegating to a specialist agent."
      }
    } else if (item.tool !== "read" && num(data.consecutive_failures) > 0) {
      await ctx.mark({ consecutive_failures: 0 })
    }
  }

  return { toolBeforeAccess, toolAfterAccess }
}

export default {
  id: "guardrail-access",
  server: async () => ({}),
}
