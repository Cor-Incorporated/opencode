import path from "path"
import { MUTATING_TOOLS, bash as mutatingBash, git, list, rel, str, text } from "./guardrail-patterns"
import type { GuardrailContext } from "./guardrail-context"

const codeExt = /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|swift|kt|java|rb|php)$/

export function createInstrumentationHandlers(ctx: GuardrailContext) {
  async function toolBeforeInstrumentation(
    item: { tool: string; args?: unknown },
    out: { args: Record<string, unknown> },
  ) {
    if (!MUTATING_TOOLS.has(item.tool)) return
    const file = typeof out.args.filePath === "string" ? out.args.filePath : ""
    const relFile = file ? rel(ctx.input.worktree, file) : ""
    const content = changedContent(out.args)
    if (!content) return
    if (!instrumentationSurface(relFile, content)) return
    const globalPatch = globalMonkeyPatch(content)
    if (globalPatch) {
      await ctx.mark({
        last_block: item.tool,
        last_file: relFile,
        last_reason: "instrumentation global monkey patch",
        instrumentation_policy: "source_hooks_required",
      })
      throw new Error(
        text(
          `AI agent instrumentation must use source-level hooks; global monkey patching is prohibited (${globalPatch})`,
        ),
      )
    }
    const nullReason = nullUnavailableReason(content)
    if (nullReason) {
      await ctx.mark({
        last_block: item.tool,
        last_file: relFile,
        last_reason: "instrumentation unavailable reason cannot be null",
      })
      throw new Error(text(`metric unavailability must use an explicit reason, not null (${nullReason})`))
    }
    const claim = unmeasurableMetricClaim(content)
    if (claim) {
      await ctx.mark({
        last_block: item.tool,
        last_file: relFile,
        last_reason: "unmeasurable metric claim",
      })
      throw new Error(
        text(`do not claim metrics that are not directly measurable; mark unavailable instead (${claim})`),
      )
    }
  }

  async function toolAfterInstrumentation(
    item: { tool: string; args?: Record<string, unknown> },
    _out: { output: string; metadata: Record<string, unknown> },
    data: Record<string, unknown>,
  ) {
    if (!MUTATING_TOOLS.has(item.tool)) return
    const file = typeof item.args?.filePath === "string" ? item.args.filePath : ""
    const relFile = file ? rel(ctx.input.worktree, file) : ""
    const content = changedContent(item.args ?? {})
    if (!instrumentationSurface(relFile, content)) return
    const files = list(data.instrumentation_files)
    await ctx.mark({
      instrumentation_changes: true,
      instrumentation_files: files.includes(relFile) ? files : [...files, relFile],
      instrumentation_quality_state: "",
    })
    await ctx.seen("instrumentation.change_detected", { file: relFile })
  }

  async function bashBeforeInstrumentation(cmd: string, data: Record<string, unknown>) {
    if (mutatingBash(cmd) && instrumentationSurface("", cmd)) {
      const globalPatch = globalMonkeyPatch(cmd)
      if (globalPatch) {
        await ctx.mark({
          last_block: "bash",
          last_command: cmd,
          last_reason: "instrumentation global monkey patch",
          instrumentation_policy: "source_hooks_required",
        })
        throw new Error(
          text(
            `AI agent instrumentation must use source-level hooks; global monkey patching is prohibited (${globalPatch})`,
          ),
        )
      }
      const nullReason = nullUnavailableReason(cmd)
      if (nullReason) {
        await ctx.mark({
          last_block: "bash",
          last_command: cmd,
          last_reason: "instrumentation unavailable reason cannot be null",
        })
        throw new Error(text(`metric unavailability must use an explicit reason, not null (${nullReason})`))
      }
      const claim = unmeasurableMetricClaim(cmd)
      if (claim) {
        await ctx.mark({
          last_block: "bash",
          last_command: cmd,
          last_reason: "unmeasurable metric claim",
        })
        throw new Error(
          text(`do not claim metrics that are not directly measurable; mark unavailable instead (${claim})`),
        )
      }
    }
    if (
      !/\bgh\s+pr\s+create\b|\bgh\s+pr\s+merge\b|\bgh\s+api\b[\s\S]*\bpulls\/\d+\/merge\b|\bgit\s+merge\b/i.test(cmd)
    ) {
      return
    }
    const assessment = await assess(cmd, data)
    if (!assessment.relevant) return
    if (assessment.problems.length === 0) {
      await ctx.mark({
        instrumentation_quality_state: "done",
        instrumentation_quality_at: new Date().toISOString(),
        instrumentation_files: assessment.files,
      })
      await ctx.seen("instrumentation.quality_gate_passed", { files: assessment.files })
      return
    }
    await ctx.mark({
      last_block: "bash",
      last_command: cmd,
      last_reason: `instrumentation quality gate: ${assessment.problems[0]}`,
      instrumentation_quality_state: "blocked",
      instrumentation_quality_blockers: assessment.problems,
      instrumentation_files: assessment.files,
    })
    throw new Error(
      text(
        [
          "AI agent instrumentation quality gate failed.",
          ...assessment.problems.map((item) => `- ${item}`),
          "Required evidence: source-level hooks, traceability matrix, integration test, metric semantics/code path, dependency availability probe, lifecycle cleanup/finally, and explicit unavailable reasons.",
        ].join("\n"),
      ),
    )
  }

  async function assess(cmd: string, data: Record<string, unknown>) {
    const files = [...new Set([...list(data.instrumentation_files), ...(await changedFiles())])]
    const sourceFiles = files.filter((file) => codeExt.test(file))
    const contents = await Promise.all(
      files.map(async (file) => ({
        file,
        text: await Bun.file(path.join(ctx.input.worktree, file))
          .text()
          .catch(() => ""),
      })),
    )
    const instrumentationFiles = contents
      .filter((item) => instrumentationSurface(item.file, item.text))
      .map((item) => item.file)
    const crossCuttingInstrumentation =
      instrumentationFiles.length === 0 &&
      sourceFiles.length >= 3 &&
      new Set(sourceFiles.map((file) => file.split("/").slice(0, 3).join("/"))).size >= 3 &&
      contents.some((item) => instrumentationText(item.text))
    const relevant =
      instrumentationFiles.length > 0 || crossCuttingInstrumentation || data.instrumentation_changes === true
    const evidence = `${cmd}\n${contents
      .filter((item) => /\.(md|mdx|txt|ts|tsx|js|jsx)$/.test(item.file))
      .map((item) => item.text)
      .join("\n")}`
    const problems: string[] = []
    const targetContents = contents.filter((item) => instrumentationFiles.includes(item.file))

    for (const item of targetContents) {
      const globalPatch = globalMonkeyPatch(item.text)
      if (globalPatch) problems.push(`${item.file}: global monkey patching is prohibited (${globalPatch})`)
      const nullReason = nullUnavailableReason(item.text)
      if (nullReason) problems.push(`${item.file}: unavailable metric state uses null instead of an explicit reason`)
      const claim = unmeasurableMetricClaim(item.text)
      if (claim) problems.push(`${item.file}: claims an unmeasurable metric instead of marking it unavailable`)
      const itemEvidence = `${item.text}\n${evidence}`
      if (/\bmetrics?\b/i.test(item.text) && !metricSemanticsEvidence(itemEvidence)) {
        problems.push(`${item.file}: metric semantics and source code path are not documented`)
      }
      if (
        /\b(import|from|require|spawn|fetch|exec|client|sdk|mcp|otel|opentelemetry)\b/i.test(item.text) &&
        !dependencyProbeEvidence(itemEvidence)
      ) {
        problems.push(`${item.file}: dependency availability probe and unavailable reason are missing`)
      }
      if (resourceLifecycleRequired(item.text) && !resourceLifecycleEvidence(item.text)) {
        problems.push(`${item.file}: resource lifecycle needs cleanup/finally evidence`)
      }
      if (/\bunavailable\b/i.test(item.text) && !/(unavailable_reason|unavailableReason|reason)\b/i.test(item.text)) {
        problems.push(`${item.file}: unavailable metric state must include an explicit reason field`)
      }
    }
    if (relevant && !traceabilityEvidence(evidence)) {
      problems.push("missing acceptance-criteria-to-implementation traceability matrix")
    }
    if (relevant && !integrationTestEvidence(contents, instrumentationFiles)) {
      problems.push("instrumentation or cross-cutting change requires a meaningful integration/smoke test")
    }
    return { relevant, files: instrumentationFiles.length > 0 ? instrumentationFiles : files, problems }
  }

  async function changedFiles() {
    const base = await mergeBaseRef()
    const diff = base
      ? await git(ctx.input.worktree, ["diff", "--name-only", `${base}...HEAD`])
      : await git(ctx.input.worktree, ["diff", "--name-only", "HEAD"])
    if (diff.code !== 0) return []
    return diff.stdout.split(/\r?\n/).filter(Boolean)
  }

  async function mergeBaseRef() {
    for (const ref of [
      "dev",
      "develop",
      "main",
      "master",
      "origin/dev",
      "origin/develop",
      "origin/main",
      "origin/master",
    ]) {
      const result = await git(ctx.input.worktree, ["rev-parse", "--verify", ref])
      if (result.code === 0 && result.stdout.trim()) return ref
    }
    return ""
  }

  return { assess, bashBeforeInstrumentation, toolBeforeInstrumentation, toolAfterInstrumentation }
}

function changedContent(args: Record<string, unknown>) {
  return str(args.content) || str(args.newString) || str(args.patch)
}

function instrumentationSurface(file: string, content: string) {
  if (
    /(^|\/)(instrumentation|instrument|metrics?|telemetry|observability|tracing|trace[-_]?spans?|hooks?)\b/i.test(file)
  )
    return true
  if (/\bagent(s)?\b/i.test(file) && instrumentationText(content)) return true
  return instrumentationText(content)
}

function instrumentationText(content: string) {
  return (
    /\b(ai agent|agent instrumentation|instrumentation|telemetry|observability|metrics?|tracing|source-level hooks?)\b/i.test(
      content,
    ) || /\b(?:trace|telemetry|otel)\s+spans?\b/i.test(content)
  )
}

function globalMonkeyPatch(content: string) {
  const patterns = [
    { pattern: /\b(?:globalThis|global|window|process)\s*\[[^\]]+\]\s*=(?!=|>)/, reason: "global assignment" },
    { pattern: /\b(?:globalThis|global|window|process)\.[A-Za-z_$][\w$]*\s*=(?!=|>)/, reason: "global assignment" },
    { pattern: /\b(?:Module\._load|require\.extensions)\s*=(?!=|>)/, reason: "module loader patch" },
    { pattern: /\b(?:http|https|fs|console)\.[A-Za-z_$][\w$]*\s*=(?!=|>)/, reason: "module method patch" },
    {
      pattern: /\b(?:fetch|setTimeout|setInterval|clearTimeout|clearInterval)\s*=(?!=|>)/,
      reason: "runtime function replacement",
    },
  ]
  return patterns.find((item) => item.pattern.test(content))?.reason
}

function nullUnavailableReason(content: string) {
  const patterns = [
    { pattern: /\b(?:unavailable_reason|unavailableReason|reason)\s*[:=]\s*null\b/, reason: "null reason" },
    { pattern: /\bunavailable\s*[:=]\s*null\b/, reason: "null availability" },
    { pattern: /\breturn\s+null\b[\s\S]{0,160}\b(?:metric|metrics?|unavailable)\b/i, reason: "return null" },
  ]
  return patterns.find((item) => item.pattern.test(content))?.reason
}

function unmeasurableMetricClaim(content: string) {
  const patterns = [
    {
      pattern: /\b(?:estimat\w*|approximat\w*|infer\w*|synthetic|proxy)\b[\s\S]{0,80}\bmetrics?\b/i,
      reason: "estimated metric",
    },
    {
      pattern: /\bmetrics?\b[\s\S]{0,80}\b(?:estimat\w*|approximat\w*|infer\w*|synthetic|proxy)\b/i,
      reason: "estimated metric",
    },
  ]
  return patterns.find(
    (item) =>
      item.pattern.test(content) &&
      !/(unavailable_reason|unavailableReason|not_measurable|not measurable|unavailable)/i.test(content),
  )?.reason
}

function traceabilityEvidence(text: string) {
  return (
    /traceability\s+matrix/i.test(text) &&
    /acceptance\s+criteria/i.test(text) &&
    /\b(implementation|code path|source path)\b/i.test(text)
  )
}

function integrationTestEvidence(contents: { file: string; text: string }[], instrumentationFiles: string[]) {
  const targets = instrumentationFiles.map((file) => path.basename(file).replace(/\.[^.]+$/, ""))
  return contents
    .filter((item) =>
      /(^|\/)(test|tests|__tests__)\/.*(?:integration|e2e|smoke|instrument|metric).*\.test\.(ts|tsx|js|jsx)$|(?:integration|e2e|smoke)\.test\.(ts|tsx|js|jsx)$/i.test(
        item.file,
      ),
    )
    .some((item) => {
      if (/\bexpect\s*\(\s*true\s*\)\s*\.\s*toBe\s*\(\s*true\s*\)/.test(item.text)) return false
      if (
        /\b(instrumentation|instrument|metrics?|telemetry|observability|unavailable_reason|dependency)\b/i.test(
          item.text,
        )
      )
        return true
      return targets.some((target) => target && item.text.includes(target))
    })
}

function metricSemanticsEvidence(text: string) {
  return /\bmetrics?\b[\s\S]{0,400}\b(semantics?|meaning|definition)\b[\s\S]{0,400}\b(code path|source path|hook path|implementation path)\b/i.test(
    text,
  )
}

function dependencyProbeEvidence(text: string) {
  return (
    /\b(dependency|provider|sdk|cli|mcp)\b[\s\S]{0,400}\b(availability|available|probe|detect|check)\b/i.test(text) &&
    /\b(unavailable_reason|unavailableReason|reason)\b/i.test(text)
  )
}

function resourceLifecycleRequired(text: string) {
  return /\b(setInterval|setTimeout|addEventListener|subscribe|watch|createServer|connect|open\(|spawn|ReadableStream|AbortController)\b/i.test(
    text,
  )
}

function resourceLifecycleEvidence(text: string) {
  return /\b(finally|cleanup|dispose|unsubscribe|removeEventListener|clearInterval|clearTimeout|abort\(|close\(|end\(|destroy\()\b/i.test(
    text,
  )
}
