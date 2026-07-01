import { ciChecksGreen, flag, git, num, stash, str } from "./guardrail-patterns"
import type { GuardrailContext } from "./guardrail-context"
import path from "path"

type MergeReviewTier = "DOCS_ONLY" | "LIGHT" | "FULL"

type Review = {
  checklist(data: Record<string, unknown>): {
    score: number
    total: number
    blocking: string[]
    summary: string
  }
  reviewGate(data: Record<string, unknown>): {
    done: boolean
    pending: string[]
    message: string
  }
  syncReviewState(): Promise<void>
  hydrateReviewEvidence?(expectedHead?: string): Promise<boolean | void>
}

export function createGitHandlers(ctx: GuardrailContext, review: Review) {
  const protectedBranchNames = ["main", "master", "develop", "dev"]
  const opencodeForkRepo = "Cor-Incorporated/opencode"
  const opencodeForkOwner = "Cor-Incorporated"
  const opencodeUpstreamRepo = "anomalyco/opencode"
  const opencodeBaseBranch = "dev"
  let opencodeWorktree: boolean | undefined

  function teamWorker() {
    return /(?:^|[\\/])\.opencode[\\/]team[\\/]/.test(ctx.input.worktree)
  }

  function shellWord() {
    return `(?:"[^"]+"|'[^']+'|\\S+)`
  }

  function gitSubcommand(cmd: string, name: string) {
    return new RegExp(
      `\\bgit(?:\\s+-C\\s+${shellWord()}|\\s+-c\\s+${shellWord()}|\\s+--(?:git-dir|work-tree|namespace)=${shellWord()}|\\s+--(?:git-dir|work-tree|namespace)\\s+${shellWord()})*\\s+${name}\\b`,
      "i",
    ).test(cmd)
  }

  function ghPrCommand(cmd: string, name: string) {
    return new RegExp(`\\bgh(?:\\s+(?:--repo|-R)\\s+\\S+|\\s+--repo=\\S+|\\s+-R\\S+)*\\s+pr\\s+${name}\\b`, "i").test(
      cmd,
    )
  }

  function spawnGh(args: string[]) {
    return Bun.spawn(["gh", ...args], {
      cwd: ctx.input.worktree,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env },
    })
  }

  function ghPrMergeNumber(cmd: string) {
    return (
      cmd.match(/\bgh(?:\s+(?:--repo|-R)\s+\S+|\s+--repo=\S+|\s+-R\S+)*\s+pr\s+merge\s+(\d+)/i)?.[1] ??
      cmd.match(/\bgh\s+api\b(?=[\s\S]*(?:^|\s)-X(?:=|\s*)PUT\b)[\s\S]*\brepos\/\S+\/pulls\/(\d+)\/merge\b/i)?.[1] ??
      cmd.match(
        /\bgh\s+api\b(?=[\s\S]*(?:^|\s)--method(?:=|\s+)PUT\b)[\s\S]*\brepos\/\S+\/pulls\/(\d+)\/merge\b/i,
      )?.[1] ??
      ""
    )
  }

  function ghApiPrMerge(cmd: string) {
    return Boolean(ghPrMergeNumber(cmd)) && /\bgh\s+api\b/i.test(cmd)
  }

  function splitShell(cmd: string) {
    const tokens: string[] = []
    let current = ""
    let quote = ""
    let escaped = false

    for (let index = 0; index < cmd.length; index++) {
      const char = cmd[index]
      if (escaped) {
        current += char
        escaped = false
        continue
      }
      if (char === "\\") {
        escaped = true
        continue
      }
      if (quote) {
        if (char === quote) {
          quote = ""
        } else {
          current += char
        }
        continue
      }
      if (char === "'" || char === '"') {
        quote = char
        continue
      }
      if (/\s/.test(char)) {
        if (current) {
          tokens.push(current)
          current = ""
        }
        continue
      }
      if (char === ";") {
        if (current) {
          tokens.push(current)
          current = ""
        }
        tokens.push(";")
        continue
      }
      if ((char === "&" || char === "|") && cmd[index + 1] === char) {
        if (current) {
          tokens.push(current)
          current = ""
        }
        tokens.push(`${char}${char}`)
        index += 1
        continue
      }
      if (char === "&" || char === "|") {
        if (current) {
          tokens.push(current)
          current = ""
        }
        tokens.push(char)
        continue
      }
      current += char
    }

    if (current) tokens.push(current)
    return tokens
  }

  function ghCommandTokens(cmd: string) {
    const tokens = splitShell(cmd)
    return tokens.flatMap((token, index) => {
      if (token !== "gh") return []
      const end = tokens.findIndex(
        (item, itemIndex) =>
          itemIndex > index && (item === ";" || item === "&&" || item === "||" || item === "&" || item === "|"),
      )
      return [tokens.slice(index, end === -1 ? undefined : end)]
    })
  }

  function optionValue(tokens: string[], long: string, short: string) {
    for (let index = 0; index < tokens.length; index++) {
      const token = tokens[index]
      if (token === long || token === short) return tokens[index + 1] ?? ""
      if (token.startsWith(`${long}=`)) return token.slice(long.length + 1)
      if (short && token.startsWith(short) && token.length > short.length) {
        return token.slice(short.length).replace(/^=/, "")
      }
    }
    return ""
  }

  function ghApiMethod(tokens: string[]) {
    return optionValue(tokens, "--method", "-X").toUpperCase()
  }

  function ghApiField(tokens: string[], name: string) {
    return ghApiFields(tokens).find((field) => field.name === name)?.value ?? ""
  }

  function ghApiFields(tokens: string[]) {
    return tokens.flatMap((token, index) => {
      const entry =
        token === "-f" || token === "--raw-field"
          ? { value: tokens[index + 1] ?? "", magic: false }
          : token === "-F" || token === "--field"
            ? { value: tokens[index + 1] ?? "", magic: true }
            : token.startsWith("--raw-field=")
              ? { value: token.slice("--raw-field=".length), magic: false }
              : token.startsWith("--field=")
                ? { value: token.slice("--field=".length), magic: true }
                : token.startsWith("-f") && token.length > 2
                  ? { value: token.slice(2), magic: false }
                  : token.startsWith("-F") && token.length > 2
                    ? { value: token.slice(2), magic: true }
                    : undefined
      if (!entry) return []
      const split = entry.value.indexOf("=")
      if (split === -1) return []
      return [
        {
          name: entry.value.slice(0, split),
          value: entry.value.slice(split + 1),
          file: entry.magic && entry.value.slice(split + 1).startsWith("@"),
        },
      ]
    })
  }

  function ghApiHasBodyField(tokens: string[]) {
    return tokens.some(
      (token) =>
        token === "-f" ||
        token === "-F" ||
        token === "--field" ||
        token === "--raw-field" ||
        token === "--input" ||
        token.startsWith("-f") ||
        token.startsWith("-F") ||
        token.startsWith("--field=") ||
        token.startsWith("--raw-field=") ||
        token.startsWith("--input="),
    )
  }

  function ghApiPrCreate(tokens: string[]) {
    const apiIndex = tokens.findIndex((token) => token === "api")
    if (apiIndex === -1) return
    const endpoint = tokens
      .slice(apiIndex + 1)
      .map((token) =>
        token
          .replace(/^https:\/\/api\.github\.com\//i, "")
          .replace(/^\/+/, "")
          .replace(/\?.*$/, "")
          .replace(/\/+$/, ""),
      )
      .find((token) => /^repos\/[^/]+\/[^/]+\/pulls$/i.test(token))
    if (!endpoint) return
    const method = ghApiMethod(tokens)
    if (method === "GET") return
    if (method && method !== "POST") return
    if (!method && !ghApiHasBodyField(tokens)) return
    const [, owner, repo] = endpoint.match(/^repos\/([^/]+)\/([^/]+)\/pulls$/i) ?? []
    return {
      repo: owner && repo ? `${owner}/${repo}` : "",
      base: ghApiField(tokens, "base"),
      head: ghApiField(tokens, "head"),
    }
  }

  function ghApiGraphql(tokens: string[]) {
    const apiIndex = tokens.findIndex((token) => token === "api")
    if (apiIndex === -1) return false
    return tokens
      .slice(apiIndex + 1)
      .map((token) =>
        token
          .replace(/^https:\/\/api\.github\.com\//i, "")
          .replace(/^\/+/, "")
          .replace(/\?.*$/, "")
          .replace(/\/+$/, ""),
      )
      .some((token) => token === "graphql")
  }

  function containsCreatePullRequest(value: string) {
    return /\bcreatePullRequest\b/.test(value)
  }

  function dynamicShellValue(value: string) {
    const trimmed = value.trim()
    return trimmed.startsWith("$") || trimmed.includes("$(") || trimmed.includes("${") || trimmed.includes("`")
  }

  async function readCommandFile(value: string) {
    const file = value.startsWith("@") ? value.slice(1) : value
    if (!file || file === "-") return
    const target = path.resolve(ctx.input.worktree, file)
    try {
      return await Bun.file(target).text()
    } catch {
      return undefined
    }
  }

  async function ghApiGraphqlCreatePullRequest(tokens: string[]) {
    if (!ghApiGraphql(tokens)) return false
    for (const field of ghApiFields(tokens).filter((item) => item.name === "query")) {
      if (!field.file && containsCreatePullRequest(field.value)) return true
      if (!field.file && dynamicShellValue(field.value)) return true
      if (!field.file) continue
      const text = await readCommandFile(field.value)
      if (text === undefined || containsCreatePullRequest(text)) return true
    }
    const input = optionValue(tokens, "--input", "")
    if (!input) return false
    const text = await readCommandFile(input)
    if (text === undefined) return true
    return containsCreatePullRequest(text)
  }

  function ghPrCreate(tokens: string[]) {
    const prIndex = tokens.findIndex((token) => token === "pr")
    if (prIndex === -1 || tokens[prIndex + 1] !== "create") return
    return {
      repo: optionValue(tokens, "--repo", "-R"),
      base: optionValue(tokens, "--base", "-B"),
      head: optionValue(tokens, "--head", "-H"),
    }
  }

  async function isOpencodeWorktree() {
    if (opencodeWorktree !== undefined) return opencodeWorktree
    const result = await git(ctx.input.worktree, ["remote", "-v"])
    opencodeWorktree =
      result.code === 0 && /github\.com[:/](Cor-Incorporated|anomalyco)\/opencode(?:\.git)?/i.test(result.stdout)
    return opencodeWorktree
  }

  async function blockWrongOpencodePrTarget(cmd: string) {
    if (!/\bgh\b[\s\S]*\b(?:pr\s+create|api)\b/i.test(cmd)) return
    if (!(await isOpencodeWorktree())) return

    for (const tokens of ghCommandTokens(cmd)) {
      if (await ghApiGraphqlCreatePullRequest(tokens)) {
        const reason = "opencode GraphQL createPullRequest mutation blocked"
        await ctx.mark({ last_block: "bash", last_command: cmd, last_reason: reason })
        throw new Error(
          `Guardrail policy blocked this action: opencode GraphQL createPullRequest mutation blocked. Use gh pr create --repo ${opencodeForkRepo} --base ${opencodeBaseBranch} instead.`,
        )
      }

      if (ghApiPrCreate(tokens)) {
        const reason = "opencode REST pull request creation blocked"
        await ctx.mark({ last_block: "bash", last_command: cmd, last_reason: reason })
        throw new Error(
          `Guardrail policy blocked this action: opencode REST pull request creation blocked. Use gh pr create --repo ${opencodeForkRepo} --base ${opencodeBaseBranch} instead.`,
        )
      }

      const target = ghPrCreate(tokens)
      if (!target) continue

      const reason =
        target.repo !== opencodeForkRepo
          ? `opencode PR target repo must be ${opencodeForkRepo}`
          : target.base !== opencodeBaseBranch
            ? `opencode PR base must be ${opencodeBaseBranch}`
            : target.head.includes(":") && !target.head.toLowerCase().startsWith(`${opencodeForkOwner.toLowerCase()}:`)
              ? `opencode PR head owner must be ${opencodeForkOwner}`
              : ""
      if (!reason) continue

      await ctx.mark({ last_block: "bash", last_command: cmd, last_reason: reason })
      throw new Error(
        `Guardrail policy blocked this action: opencode PR creation blocked: use --repo ${opencodeForkRepo} --base ${opencodeBaseBranch}, and do not use ${opencodeUpstreamRepo}:* as head.`,
      )
    }
  }

  function ghPrApproveNumber(cmd: string) {
    if (/\bgh\s+pr\s+review\b[\s\S]*\s--approve\b/i.test(cmd)) {
      return cmd.match(/\bgh\s+pr\s+review\s+(\d+)/i)?.[1] ?? ""
    }
    if (/\bgh\s+api\b/i.test(cmd) && /\bpulls\/(\d+)\/reviews\b/i.test(cmd) && /\bAPPROVE\b/i.test(cmd)) {
      return cmd.match(/\bpulls\/(\d+)\/reviews\b/i)?.[1] ?? ""
    }
    return ""
  }

  function codexExecWorktree(cmd: string) {
    return (
      cmd
        .match(/\bcodex\s+exec\b[\s\S]*(?:\s-C|\s--cd|\s--cwd)\s+(?:"([^"]+)"|'([^']+)'|(\S+))/i)
        ?.slice(1)
        .find(Boolean) ?? ""
    )
  }

  function sameWorktree(left: string, right: string) {
    const paths = [path.resolve(left), path.resolve(right)]
    if (process.platform === "darwin") return paths[0].toLowerCase() === paths[1].toLowerCase()
    return paths[0] === paths[1]
  }

  async function blockOwnApproval(cmd: string) {
    const approvePr = ghPrApproveNumber(cmd)
    if (!approvePr && !/\bgh\s+pr\s+review\b[\s\S]*\s--approve\b/i.test(cmd)) return
    const prProc = spawnGh(["pr", "view", ...(approvePr ? [approvePr] : []), "--json", "number,author"])
    const userProc = spawnGh(["api", "user", "--jq", ".login"])
    const [prOut, prCode, userOut, userCode] = await Promise.all([
      new Response(prProc.stdout).text(),
      prProc.exited,
      new Response(userProc.stdout).text(),
      userProc.exited,
    ])
    if (prCode !== 0 || userCode !== 0) return
    const pr = JSON.parse(prOut) as { author?: { login?: string } }
    if (!pr.author?.login || pr.author.login !== userOut.trim()) return
    await ctx.mark({
      last_block: "bash",
      last_command: cmd,
      last_reason: "GitHub forbids approving your own PR",
    })
    throw new Error(
      "Guardrail policy blocked this action: GitHub review API cannot approve your own PR. Record the review as a comment or external review result instead; merge gates use guardrail review state plus CI, not self-approval.",
    )
  }

  function ghIssueCloseCommand(cmd: string) {
    if (/\bgh\s+issue\s+close\b/i.test(cmd)) return true
    if (/\bgh\s+issue\s+edit\b/i.test(cmd) && /\s--state(?:=|\s+)closed\b/i.test(cmd)) return true
    return ghApiIssueCloseMutation(cmd)
  }

  function ghApiIssueCloseMutation(cmd: string) {
    return ghCommandTokens(cmd).some((tokens) => {
      const apiIndex = tokens.findIndex((token) => token === "api")
      if (apiIndex === -1) return false
      const endpoint = tokens
        .slice(apiIndex + 1)
        .map((token) =>
          token
            .replace(/^https:\/\/api\.github\.com\//i, "")
            .replace(/^\/+/, "")
            .replace(/\?.*$/, "")
            .replace(/\/+$/, ""),
        )
        .find((token) => /^repos\/[^/]+\/[^/]+\/issues\/\d+$/i.test(token))
      if (!endpoint) return false
      const method = ghApiMethod(tokens)
      if (method === "GET") return false
      if (method && !["PATCH", "PUT"].includes(method)) return false
      return (
        ghApiField(tokens, "state").toLowerCase() === "closed" ||
        /\bstate=(?:closed|completed)\b|["']state["']\s*:\s*["']closed["']/i.test(cmd)
      )
    })
  }

  function uatLifecycleCommand(cmd: string) {
    return ghIssueCloseCommand(cmd) || ghPrCommand(cmd, "merge") || ghPrCommand(cmd, "ready") || ghApiPrMerge(cmd)
  }

  function uatStatusCommand(cmd: string) {
    return (
      /\bgh\s+issue\s+(?:create|comment|edit)\b/i.test(cmd) ||
      /\bgh\s+pr\s+(?:create|comment|review)\b/i.test(cmd) ||
      ghApiIssueMutation(cmd)
    )
  }

  function uatCompletionDeclaration(cmd: string) {
    return (
      /\b(?:close|closing|closed|merge|merged|ready\s+for\s+review|pr\s+ready|mark(?:ed)?\s+ready|ready\s+to\s+(?:close|merge|ship))\b/i.test(
        cmd,
      ) ||
      /\b(?:UAT|UX|E2E|end-to-end|browser[- ]tested|browser[- ]verified|browser verification|browser test(?:ed|ing)?|live verification|live smoke|user journey|manual QA)\b[\s\S]{0,120}\b(?:complete|completed|done|pass(?:ed)?|verified|confirmed|resolved|fixed|ready)\b/i.test(
        cmd,
      ) ||
      /\b(?:complete|completed|done|pass(?:ed)?|verified|confirmed|resolved|fixed|ready)\b[\s\S]{0,120}\b(?:UAT|UX|E2E|end-to-end|browser[- ]tested|browser[- ]verified|browser verification|browser test(?:ed|ing)?|live verification|live smoke|user journey|manual QA)\b/i.test(
        cmd,
      ) ||
      /(?:操作テスト|ブラウザ|受入|検証)[\s\S]{0,120}(?:完了|確認済|検証済|テスト済|解決|修正済)|(?:完了|確認済|検証済|テスト済|解決|修正済)[\s\S]{0,120}(?:操作テスト|ブラウザ|受入|検証)/i.test(
        cmd,
      )
    )
  }

  function uatEvidenceCommand(cmd: string) {
    return uatLifecycleCommand(cmd) || (uatStatusCommand(cmd) && uatCompletionDeclaration(cmd))
  }

  function ghApiIssueMutation(cmd: string) {
    return ghCommandTokens(cmd).some((tokens) => {
      const apiIndex = tokens.findIndex((token) => token === "api")
      if (apiIndex === -1) return false
      const endpoint = tokens
        .slice(apiIndex + 1)
        .map((token) =>
          token
            .replace(/^https:\/\/api\.github\.com\//i, "")
            .replace(/^\/+/, "")
            .replace(/\?.*$/, "")
            .replace(/\/+$/, ""),
        )
        .find((token) => /^repos\/[^/]+\/[^/]+\/issues(?:\/\d+)?(?:\/comments)?$/i.test(token))
      if (!endpoint) return false
      const method = ghApiMethod(tokens)
      if (method === "GET") return false
      if (["POST", "PATCH", "PUT", "DELETE"].includes(method)) return true
      return ghApiHasBodyField(tokens)
    })
  }

  function uatScoped(cmd: string, data: Record<string, unknown>) {
    return (
      flag(data.uat_evidence_required) ||
      flag(data.ux_evidence_required) ||
      flag(data.e2e_evidence_required) ||
      flag(data.browser_evidence_required) ||
      /\b(?:UAT|UX|E2E|end-to-end|browser[- ]tested|browser[- ]verified|browser verification|browser test(?:ed|ing)?|live verification|live smoke|user journey|acceptance criteria|manual QA)\b|操作テスト|ブラウザ/i.test(
        cmd,
      )
    )
  }

  function nonFinalUatStatusCommand(cmd: string) {
    if (uatLifecycleCommand(cmd)) return false
    if (!uatStatusCommand(cmd)) return false
    return /\b(?:blocker|blocked|unverified|not\s+verified|unverified-restart-condition|restart condition|unable to verify|cannot verify|verification blocked|blocked by|investigat(?:e|ion)|research|plan(?:ning)?|read-only|triage|status update|draft|proposal|follow-up|followup)\b|未検証|未確認|未取得|調査|計画|ブロッカー|保留/i.test(
      cmd,
    )
  }

  function hasUatEvidence(cmd: string, data: Record<string, unknown>) {
    if (
      /\b(?:no|without|missing)\s+(?:browser\s+|live\s+|uat\s+|ux\s+|e2e\s+)?evidence\b|\bevidence\s+pending\b|証跡なし|証跡不足|未取得|未確認|未検証/i.test(
        cmd,
      )
    ) {
      return false
    }
    const stateHasEvidence =
      flag(data.uat_evidence_done) ||
      flag(data.ux_evidence_done) ||
      flag(data.e2e_evidence_done) ||
      flag(data.browser_evidence_done) ||
      flag(data.live_evidence_done) ||
      flag(data.browser_live_evidence_done) ||
      flag(data.live_evidence_captured) ||
      [
        "uat_evidence_path",
        "ux_evidence_path",
        "e2e_evidence_path",
        "browser_evidence_path",
        "live_evidence_path",
        "playwright_report_path",
        "browser_screenshot_path",
        "browser_video_path",
        "live_url",
        "verified_live_url",
      ].some((key) => str(data[key]))
    if (stateHasEvidence) return true
    return /docs\/v2\/live-evidence\/|\b(?:browser|live|uat|ux|e2e|playwright)\s+(?:evidence|proof|verified|verification|report|artifact|trace|screenshot|video|url)\b|(?:evidence|artifact|report|trace|screenshot|video)\s+(?:path|url):|playwright-report|test-results|\.webm\b|\.png\b|\.zip\b/i.test(
      cmd,
    )
  }

  async function blockMissingUatEvidence(cmd: string, data: Record<string, unknown>) {
    if (!uatEvidenceCommand(cmd)) return
    if (!uatScoped(cmd, data)) return
    if (nonFinalUatStatusCommand(cmd)) {
      await ctx.seen("uat_evidence.non_final_status_allowed", { command: cmd.slice(0, 500) })
      return
    }
    if (hasUatEvidence(cmd, data)) {
      await ctx.mark({ uat_evidence_done: true, uat_evidence_at: new Date().toISOString() })
      await ctx.seen("uat_evidence.present", { command: cmd.slice(0, 500) })
      return
    }

    await ctx.mark({ last_block: "bash", last_command: cmd, last_reason: "UAT/browser evidence missing" })
    await ctx.seen("uat_evidence.missing", { command: cmd.slice(0, 500) })
    throw new Error(
      "Guardrail policy blocked this action: UAT/UX/E2E/browser-tested issue or PR completion requires browser/live evidence markers. Include Browser evidence:, Live evidence:, Playwright report:, screenshot/video/trace/evidence path, or mark the issue as blocker/unverified-restart-condition.",
    )
  }

  function reviewDone(data: Record<string, unknown>) {
    return str(data.review_glm_state) === "done" && str(data.review_codex_state) === "done"
  }

  function hasUsableReviewEvidence(data: Record<string, unknown>) {
    return /^(restored|saved)$/i.test(str(data.review_evidence_state)) && Boolean(reviewedHeadSha(data))
  }

  function reviewedHeadSha(data: Record<string, unknown>) {
    return (
      [
        "review_head_sha",
        "reviewed_head_sha",
        "reviewed_head",
        "review_evidence_head",
        "review_head_oid",
        "reviewed_head_oid",
        "review_head_ref_oid",
        "reviewed_head_ref_oid",
        "review_pr_head_sha",
      ]
        .map((key) => str(data[key]))
        .find(Boolean) ?? ""
    )
  }

  async function ghPrHeadRefOid(prNumber: string) {
    const proc = spawnGh(["pr", "view", ...(prNumber ? [prNumber] : []), "--json", "headRefOid", "--jq", ".headRefOid"])
    const [headOut, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
    return code === 0 ? headOut.trim() : ""
  }

  async function hydrateMergeReviewState(
    cmd: string,
    data: Record<string, unknown>,
    isPrMerge: boolean,
    prNumber: string,
  ) {
    const prHead = isPrMerge ? await ghPrHeadRefOid(prNumber) : ""
    if (isPrMerge && !prHead) {
      await ctx.mark({
        last_block: "bash",
        last_command: cmd,
        last_reason: "PR headRefOid verification failed",
      })
      throw new Error(
        "Guardrail policy blocked this action: merge blocked (FULL tier): could not verify PR headRefOid before accepting restored review evidence.",
      )
    }

    function assignHydrationDiagnostics(fresh: Record<string, unknown>) {
      for (const key of [
        "review_evidence_state",
        "review_evidence_reason",
        "reviewed_head",
        "current_head",
        "expected_head",
        "review_dirty_count",
        "dirty_count",
      ]) {
        if (fresh[key] !== undefined) data[key] = fresh[key]
      }
    }

    if ((!reviewDone(data) || !reviewedHeadSha(data) || num(data.edits_since_review) > 0) && review.hydrateReviewEvidence) {
      await review.hydrateReviewEvidence(prHead || undefined)
      const fresh = await stash(ctx.state)
      const next = { ...data, ...fresh }
      if (hasUsableReviewEvidence(next)) {
        Object.assign(data, fresh)
        await ctx.seen("pre_merge.review_hydrated", { pr: prNumber || undefined })
      }
      assignHydrationDiagnostics(fresh)
    }

    if (isPrMerge && reviewDone(data)) {
      const reviewedHead = reviewedHeadSha(data)
      if (!reviewedHead) {
        await ctx.mark({
          last_block: "bash",
          last_command: cmd,
          last_reason: "review evidence missing reviewed HEAD SHA",
        })
        throw new Error(
          "Guardrail policy blocked this action: merge blocked (FULL tier): restored review evidence is missing the reviewed HEAD SHA.",
        )
      }

      if (prHead.toLowerCase() !== reviewedHead.toLowerCase()) {
        await ctx.mark({
          last_block: "bash",
          last_command: cmd,
          last_reason: "review evidence HEAD mismatch",
          review_evidence_head: reviewedHead,
          pr_head_ref_oid: prHead,
        })
        throw new Error(
          "Guardrail policy blocked this action: merge blocked (FULL tier): restored review evidence was captured for a different PR HEAD.",
        )
      }
    }
  }

  function reviewFindingCounts(data: Record<string, unknown>) {
    const criticalCount = num(data.review_critical_count)
    const highCount = num(data.review_high_count)
    const severeCount = Math.max(num(data.review_severe_count), criticalCount + highCount)
    return { criticalCount, highCount, severeCount }
  }

  async function blockSevereReviewFindings(cmd: string, data: Record<string, unknown>) {
    const counts = reviewFindingCounts(data)
    if (counts.criticalCount === 0 && counts.highCount === 0 && counts.severeCount === 0) return
    const prNum = str(data.review_pr_number)
    await ctx.mark({
      last_block: "bash",
      last_command: cmd,
      last_reason: `unresolved CRITICAL=${counts.criticalCount} HIGH=${counts.highCount} SEVERE=${counts.severeCount}`,
    })
    throw new Error(
      `Guardrail policy blocked this action: merge blocked: PR #${prNum} has unresolved CRITICAL=${counts.criticalCount} HIGH=${counts.highCount} SEVERE=${counts.severeCount} review findings`,
    )
  }

  async function bashBeforeGit(cmd: string, out: { output?: string }, data: Record<string, unknown>) {
    const isMerge = gitSubcommand(cmd, "merge") || ghPrCommand(cmd, "merge") || ghApiPrMerge(cmd)
    const isPrMerge = ghPrCommand(cmd, "merge") || ghApiPrMerge(cmd)
    const prMergeNumber = ghPrMergeNumber(cmd)
    let prChecksGreen: boolean | undefined

    async function ensurePrChecksGreen() {
      if (prChecksGreen !== undefined) return prChecksGreen
      if (!isPrMerge) return flag(data.ci_green)
      const proc = spawnGh([
        "pr",
        "checks",
        ...(prMergeNumber ? [prMergeNumber] : []),
        "--json",
        "bucket,name,state,workflow,link",
      ])
      const [ciOut, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
      prChecksGreen = ciChecksGreen(ciOut, code)
      await ctx.mark({ ci_green: prChecksGreen })
      return prChecksGreen
    }

    await blockOwnApproval(cmd)
    await blockWrongOpencodePrTarget(cmd)
    await blockMissingUatEvidence(cmd, data)

    if (/\bcodex\s+exec\b/i.test(cmd)) {
      const worktree = codexExecWorktree(cmd)
      if (!worktree) {
        await ctx.mark({ last_block: "bash", last_command: cmd, last_reason: "codex exec missing explicit worktree" })
        throw new Error(
          "Guardrail policy blocked this action: codex exec review must set an explicit worktree with `-C`, `--cd`, or `--cwd`",
        )
      }
      if (!sameWorktree(worktree, ctx.input.worktree)) {
        await ctx.mark({ last_block: "bash", last_command: cmd, last_reason: "codex exec wrong worktree" })
        throw new Error(
          "Guardrail policy blocked this action: codex exec review worktree must match the active repository worktree",
        )
      }
    }

    if (isMerge) {
      if (isPrMerge) {
        const reviewAt = str(data.review_at)
        const lastPushAt = str(data.last_push_at)
        if (reviewAt && lastPushAt && new Date(reviewAt) < new Date(lastPushAt)) {
          await ctx.mark({
            review_reading_warning: true,
            last_block: "bash",
            last_reason: "stale review: push after review",
          })
          await ctx.seen("review_reading.stale", { review_at: reviewAt, last_push_at: lastPushAt })
          throw new Error(
            "Guardrail policy blocked this action: merge blocked: code was pushed after the last review. Re-request review before merging.",
          )
        }
        try {
          if (!(await ensurePrChecksGreen())) {
            await ctx.mark({ last_block: "bash", last_command: cmd, last_reason: "CI checks not all green" })
            throw new Error(
              "Guardrail policy blocked this action: merge blocked: CI checks not all green — run `gh pr checks` to verify",
            )
          }
        } catch (err) {
          if (String(err).includes("blocked")) throw err
          await ctx.mark({
            last_block: "bash:ci-warn",
            last_command: cmd,
            last_reason: "CI check verification failed",
          })
          await ctx.seen("ci.check_verification_failed", { error: String(err) })
          throw new Error(
            "Guardrail policy blocked this action: merge blocked: CI check verification failed — run `gh pr checks` successfully before merging",
          )
        }
      }
      try {
        const branchResult = await git(ctx.input.worktree, ["branch", "--show-current"])
        if (branchResult.code !== 0) throw new Error("git branch failed")
        const branch = branchResult.stdout.trim()
        const changes = await changedFiles(prMergeNumber)
        if (changes.unavailable) {
          await ctx.mark({
            last_block: "bash",
            last_command: cmd,
            last_reason: "merge classification unavailable",
          })
          throw new Error(
            "Guardrail policy blocked this action: merge blocked: changed file classification unavailable. Run `gh pr diff --name-only` or sync the base branch before merging.",
          )
        }
        const files = changes.files
        const tier = mergeReviewTier(branch, files)
        await ctx.mark({ merge_review_tier: tier, merge_review_files: files })
        if (tier === "DOCS_ONLY") {
          const ciGreen = await ensurePrChecksGreen()
          if (isPrMerge && !ciGreen) {
            await ctx.mark({ last_block: "bash", last_command: cmd, last_reason: "DOCS_ONLY tier: CI not green" })
            throw new Error(
              "Guardrail policy blocked this action: merge blocked (DOCS_ONLY tier): CI must be green before merging without code review.",
            )
          }
          await ctx.seen("pre_merge.tier", { branch, tier, files, result: "pass" })
        } else if (tier === "LIGHT") {
          await blockSevereReviewFindings(cmd, data)
          const anyReviewDone = str(data.review_glm_state) === "done" || str(data.review_codex_state) === "done"
          const ciGreen = await ensurePrChecksGreen()
          const checksRan = Boolean(str(data.review_checks_at))
          const noSevere = checksRan && reviewFindingCounts(data).severeCount === 0
          if (!ciGreen && !anyReviewDone && !noSevere) {
            await ctx.mark({
              last_block: "bash",
              last_command: cmd,
              last_reason: "LIGHT tier: CI green, review, or C/H=0 required",
            })
            throw new Error(
              "Guardrail policy blocked this action: merge blocked (LIGHT tier): CI green, code-reviewer/Codex review, or CRITICAL=0 HIGH=0 review checks required.",
            )
          }
          await ctx.seen("pre_merge.tier", { branch, tier, files, result: "pass" })
        } else {
          await hydrateMergeReviewState(cmd, data, isPrMerge, prMergeNumber)
          await blockSevereReviewFindings(cmd, data)
          const gate = review.reviewGate(data)
          if (!gate.done) {
            const evidenceReason = str(data.review_evidence_reason)
            const reason = evidenceReason ? `${gate.message}; review evidence not accepted: ${evidenceReason}` : gate.message
            await ctx.mark({ last_block: "bash", last_command: cmd, last_reason: `FULL tier: ${reason}` })
            throw new Error(
              `Guardrail policy blocked this action: merge blocked (FULL tier): ${reason}. Run both code-reviewer agent and Codex review before merging in the PR worktree.`,
            )
          }
          if (num(data.edits_since_review) > 0) {
            await ctx.mark({
              last_block: "bash",
              last_command: cmd,
              last_reason: `FULL tier: reviews stale after ${num(data.edits_since_review)} edit(s)`,
            })
            throw new Error(
              "Guardrail policy blocked this action: merge blocked (FULL tier): reviews are stale after new edits. Re-run code-reviewer and Codex review before merging.",
            )
          }
        }
      } catch (err) {
        if (String(err).includes("blocked")) throw err
        const gate = review.reviewGate(data)
        if (!gate.done) {
          await ctx.mark({ last_block: "bash", last_command: cmd, last_reason: `merge blocked: ${gate.message}` })
          throw new Error(
            `Guardrail policy blocked this action: merge blocked: ${gate.message}. Run /review and Codex review before merging.`,
          )
        }
      }
    }

    if (isMerge) {
      const checks = review.checklist(data)
      if (checks.score < 3) {
        out.output =
          (out.output || "") +
          `\n\nCompletion checklist (${checks.score}/${checks.total}): ${checks.summary}\nBlocking: ${checks.blocking.join(", ")}`
      }
    }

    if (isPrMerge) {
      try {
        const repoRes = await git(ctx.input.worktree, ["remote", "get-url", "origin"])
        const repo =
          repoRes.code === 0
            ? repoRes.stdout
                .trim()
                .replace(/.*github\.com[:/]/, "")
                .replace(/\.git$/, "")
            : ""
        const prNum = prMergeNumber
        if (repo && prNum) {
          const proc = spawnGh([
            "api",
            `repos/${repo}/pulls/${prNum}/reviews`,
            "--jq",
            '[sort_by(.submitted_at) | group_by(.user.login)[] | last | select(.state=="CHANGES_REQUESTED")] | length',
          ])
          const [revOut, revCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
          if (revCode !== 0) {
            await ctx.mark({
              last_block: "bash",
              last_command: cmd,
              last_reason: "review state verification failed",
            })
            throw new Error(
              "Guardrail policy blocked this action: merge blocked: could not verify GitHub review state.",
            )
          }
          if (parseInt(revOut.trim()) > 0) {
            await ctx.mark({
              last_block: "bash",
              last_command: cmd,
              last_reason: "unresolved CHANGES_REQUESTED reviews",
            })
            throw new Error(
              "Guardrail policy blocked this action: merge blocked: unresolved CHANGES_REQUESTED reviews — address reviewer feedback first",
            )
          }
          const authorProc = spawnGh(["api", `repos/${repo}/pulls/${prNum}`, "--jq", ".user.login"])
          const [authorOut, authorCode] = await Promise.all([new Response(authorProc.stdout).text(), authorProc.exited])
          if (authorCode !== 0) {
            await ctx.mark({
              last_block: "bash",
              last_command: cmd,
              last_reason: "PR author verification failed",
            })
            throw new Error("Guardrail policy blocked this action: merge blocked: could not verify PR author.")
          }
          const author = authorOut.trim()
          if (author) {
            const approvalProc = spawnGh([
              "api",
              `repos/${repo}/pulls/${prNum}/reviews`,
              "--jq",
              '[.[] | select(.state=="APPROVED") | .user.login] | unique | @tsv',
            ])
            const [approvalOut, approvalCode] = await Promise.all([
              new Response(approvalProc.stdout).text(),
              approvalProc.exited,
            ])
            if (approvalCode !== 0) {
              await ctx.mark({
                last_block: "bash",
                last_command: cmd,
                last_reason: "PR approval verification failed",
              })
              throw new Error("Guardrail policy blocked this action: merge blocked: could not verify PR approvals.")
            }
            const approvals = approvalOut.trim().split(/\s+/).filter(Boolean)
            if (approvals.length > 0 && approvals.every((item) => item === author)) {
              await ctx.mark({
                last_block: "bash",
                last_command: cmd,
                last_reason: "only PR author approvals present",
              })
              throw new Error(
                "Guardrail policy blocked this action: merge blocked: PR approval cannot come only from the PR author",
              )
            }
          }
        }
      } catch (err) {
        if (String(err).includes("blocked")) throw err
      }
    }

    if (isPrMerge) {
      try {
        const curBranchRes = await git(ctx.input.worktree, ["branch", "--show-current"])
        const branch = curBranchRes.code === 0 ? curBranchRes.stdout.trim() : ""
        if (branch) {
          const proc = Bun.spawn(
            ["gh", "pr", "list", "--base", branch, "--json", "number,headRefName", "--jq", ".[].number"],
            {
              cwd: ctx.input.worktree,
              stdout: "pipe",
              stderr: "pipe",
            },
          )
          const [childOut] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
          const childPRs = childOut.trim().split("\n").filter(Boolean)
          if (childPRs.length > 0) {
            out.output =
              (out.output || "") +
              `\n⚠️ Stacked PR detected: ${childPRs.length} child PR(s) depend on this branch. Rebase child PRs after merging.`
            await ctx.seen("stacked_pr.children_detected", { count: childPRs.length, children: childPRs })
          }
        }
      } catch {}
    }

    const protectedBranch = new RegExp(`^(${protectedBranchNames.join("|")})$`)
    if (gitSubcommand(cmd, "stash") && /\bstash\s+pop\b/i.test(cmd)) {
      await ctx.mark({ last_block: "bash", last_command: cmd, last_reason: "stash pop blocked: use apply then drop" })
      throw new Error(
        "Guardrail policy blocked this action: stash pop blocked: use `git stash apply`, inspect conflicts, then `git stash drop` after verification",
      )
    }

    if (gitSubcommand(cmd, "push")) {
      const explicitMatch = cmd.match(/\bgit\s+push\s+(?:(?:-\w+|--[\w-]+)\s+)*\S+\s+(?:HEAD:)?(\S+)/i)
      if (explicitMatch && protectedBranch.test(explicitMatch[1])) {
        throw new Error(
          "Guardrail policy blocked this action: direct push to protected branch blocked — use a PR workflow",
        )
      }
      const refspecMatch = cmd.match(new RegExp(`HEAD:(${protectedBranchNames.join("|")})(?:\\s|$)`, "i"))
      if (refspecMatch) {
        throw new Error(
          "Guardrail policy blocked this action: direct push to protected branch blocked — use a PR workflow",
        )
      }
      if (!/\bgit\s+push\s+(?:(?:-\w+|--[\w-]+)\s+)*\S+\s+\S+/i.test(cmd)) {
        try {
          const result = await git(ctx.input.worktree, ["branch", "--show-current"])
          if (result.code === 0 && result.stdout && protectedBranch.test(result.stdout.trim())) {
            throw new Error(
              "Guardrail policy blocked this action: direct push to protected branch blocked — use a PR workflow",
            )
          }
        } catch (err) {
          if (String(err).includes("blocked")) throw err
        }
      }
    }

    if (
      (gitSubcommand(cmd, "checkout") && /\bcheckout\s+-b\b/i.test(cmd)) ||
      (gitSubcommand(cmd, "switch") && /\bswitch\s+-c\b/i.test(cmd))
    ) {
      try {
        const status = await git(ctx.input.worktree, ["status", "--porcelain"])
        if (status.code === 0 && status.stdout.trim()) {
          await ctx.mark({
            last_block: "bash",
            last_command: cmd,
            last_reason: "branch creation with dirty worktree blocked",
          })
          throw new Error(
            "Guardrail policy blocked this action: branch creation blocked because the worktree has uncommitted changes. Commit or use `git stash push --include-untracked` before creating the branch.",
          )
        }
        const base = await mergeBaseRef()
        const devCheck = base
          ? await git(ctx.input.worktree, ["rev-parse", "--verify", base])
          : { stdout: "", stderr: "", code: 1 }
        if (devCheck.code === 0 && devCheck.stdout.trim()) {
          const branchCheck = await git(ctx.input.worktree, ["branch", "--show-current"])
          const branch = branchCheck.code === 0 ? branchCheck.stdout.trim() : ""
          if (/^(main|master)$/.test(branch)) {
            await ctx.mark({ last_block: "bash", last_command: cmd, last_reason: "branch creation from main blocked" })
            throw new Error(
              `Guardrail policy blocked this action: branch creation from main blocked: checkout ${base.replace(/^origin\//, "")} first, then create branch`,
            )
          }
        }
      } catch (err) {
        if (String(err).includes("blocked")) throw err
      }
    }

    if (gitSubcommand(cmd, "cherry-pick") && !/--abort\b/i.test(cmd)) {
      if (teamWorker()) return
      await ctx.mark({
        last_block: "bash",
        last_command: cmd,
        last_reason: "cherry-pick blocked: delegate to Codex CLI",
      })
      throw new Error(
        "Guardrail policy blocked this action: cherry-pick blocked: delegate to Codex CLI for context-heavy merge operations",
      )
    }

    if (gitSubcommand(cmd, "rebase") && !/--abort\b/i.test(cmd)) {
      if (new RegExp(`\\brebase\\s+(origin\\/)?(${protectedBranchNames.join("|")})\\b`, "i").test(cmd)) {
        await ctx.mark({ rebase_session_active: true, rebase_session_at: new Date().toISOString() })
      } else if (/\brebase\s+--(continue|skip)\b/i.test(cmd)) {
        const data = await stash(ctx.state)
        const at = str(data.rebase_session_at)
        if (!at || Date.now() - new Date(at).getTime() > 3600_000) {
          await ctx.mark({
            last_block: "bash",
            last_command: cmd,
            last_reason: "rebase --continue/--skip: no active session",
          })
          throw new Error(
            "Guardrail policy blocked this action: rebase --continue/--skip blocked: no active permitted rebase session (1h expiry)",
          )
        }
      } else {
        await ctx.mark({ last_block: "bash", last_command: cmd, last_reason: "arbitrary rebase blocked" })
        throw new Error(
          "Guardrail policy blocked this action: arbitrary rebase blocked: only sync from main/master/develop/dev is permitted",
        )
      }
    }

    if (
      /\bgit\s+reset\b(?=[\s\S]*\s--(?:soft|mixed)\b)(?=[\s\S]*(?:origin\/)?(?:main|master|develop|dev)\b)/i.test(cmd)
    ) {
      if (teamWorker()) return
      await ctx.mark({ last_block: "bash", last_command: cmd, last_reason: "branch reset sync blocked" })
      throw new Error(
        "Guardrail policy blocked this action: reset-to-base sync blocked: use the permitted rebase/merge workflow so review and conflict gates stay visible",
      )
    }

    if (gitSubcommand(cmd, "branch") && /\bbranch\s+(-[mMfF]\b|--move\b|--force\b)/i.test(cmd)) {
      await ctx.mark({ last_block: "bash", last_command: cmd, last_reason: "branch rename/force-move blocked" })
      throw new Error(
        "Guardrail policy blocked this action: branch rename/force-move blocked: prevents commit guard bypass",
      )
    }

    if (isMerge) {
      const lastMerge = str(data.last_merge_at)
      if (lastMerge) {
        const elapsed = Date.now() - new Date(lastMerge).getTime()
        const halfDay = 12 * 60 * 60 * 1000
        if (elapsed < halfDay) {
          const hours = Math.round((elapsed / (60 * 60 * 1000)) * 10) / 10
          await ctx.mark({ soak_time_warning: true, soak_time_elapsed_h: hours })
          await ctx.seen("soak_time.advisory", { elapsed_ms: elapsed, required_ms: halfDay })
        }
      }
    }

    if (/\bgh\s+pr\s+create\b/i.test(cmd) && num(data.consecutive_fix_prs) >= 2) {
      await ctx.seen("follow_up.limit_reached", { consecutive: num(data.consecutive_fix_prs) })
    }

    if (/\bgh\s+issue\s+close\b/i.test(cmd) && !flag(data.issue_verification_done)) {
      await ctx.seen("issue_close.unverified", { command: cmd })
    }

    if (/\bgh\s+pr\s+create\b/i.test(cmd)) {
      try {
        const base = await developmentBaseRef()
        if (!base) throw new Error("development base not found")
        const diffRes = await git(ctx.input.worktree, ["diff", "--name-only", `${base}...HEAD`])
        if (diffRes.code !== 0) throw new Error("git diff failed")
        const changedFiles = diffRes.stdout.trim()
        const hasInfra = /^(hooks\/|scripts\/)[^/]+\.sh$/m.test(changedFiles)
        if (hasInfra && !flag(data.deploy_verified)) {
          await ctx.seen("deploy_verify.missing", {
            files: changedFiles.split("\n").filter((item: string) => /^(hooks|scripts)\//.test(item)),
          })
          await ctx.mark({ deploy_verify_warning: true })
        }
      } catch {}
    }

    if (/\bgh\s+pr\s+create\b/i.test(cmd)) {
      if (/--base\s+main(\s|$)/i.test(cmd)) {
        try {
          const devBase = await developmentBaseRef()
          const devCheck = devBase
            ? await git(ctx.input.worktree, ["rev-parse", "--verify", devBase])
            : { stdout: "", code: 1 }
          if (devCheck.code === 0 && devCheck.stdout.trim()) {
            const branchRes = await git(ctx.input.worktree, ["branch", "--show-current"])
            const branch = branchRes.code === 0 ? branchRes.stdout.trim() : ""
            const base = devBase.replace(/^origin\//, "")
            if (branch !== base && !new RegExp(`--head\\s+${base}\\b`, "i").test(cmd)) {
              await ctx.mark({
                last_block: "bash",
                last_command: cmd,
                last_reason: `PR targeting main when ${base} exists`,
              })
              throw new Error(
                `Guardrail policy blocked this action: PR targeting main blocked: use --base ${base}. Release PRs must be from ${base} branch.`,
              )
            }
          }
        } catch (err) {
          if (String(err).includes("blocked")) throw err
        }
      }
      if (!/\b(closes?|fixes?|resolves?)\s*#\d+/i.test(cmd) && !/#\d+/i.test(cmd)) {
        await ctx.mark({ pr_guard_issue_ref_warning: true })
        await ctx.seen("pr_guard.missing_issue_ref", { command: cmd.slice(0, 200) })
      }
      const testRan = flag(data.tests_executed)
      const typeChecked = flag(data.type_checked)
      if (!testRan || !typeChecked) {
        await ctx.mark({ pr_guard_warning: true, pr_guard_tests: testRan, pr_guard_types: typeChecked })
        await ctx.seen("pr_guard.preflight_incomplete", { tests: testRan, types: typeChecked })
      }
    }

    if (gitSubcommand(cmd, "push") || ghPrCommand(cmd, "merge") || ghApiPrMerge(cmd)) {
      if (!flag(data.tests_executed) && num(data.edit_count) >= 3) {
        await ctx.mark({ stop_test_warning: true })
        await ctx.seen("stop_test_gate.untested", { edit_count: num(data.edit_count) })
      }
    }
  }

  async function changedFiles(prNumber: string): Promise<{ files: string[]; unavailable: boolean }> {
    if (prNumber) {
      const prFiles = await githubPrFiles(prNumber)
      if (prFiles.files.length > 0) return { files: prFiles.files, unavailable: false }
      if (prFiles.unavailable) return { files: [], unavailable: true }
    }
    const base = await mergeBaseRef()
    if (!base) return { files: [], unavailable: false }
    const diff = await git(ctx.input.worktree, ["diff", "--name-only", `${base}...HEAD`])
    if (diff.code !== 0) return { files: [], unavailable: false }
    return { files: diff.stdout.split(/\r?\n/).filter(Boolean), unavailable: false }
  }

  async function githubPrFiles(prNumber: string) {
    const repoRes = await git(ctx.input.worktree, ["remote", "get-url", "origin"])
    const repo =
      repoRes.code === 0
        ? repoRes.stdout
            .trim()
            .replace(/.*github\.com[:/]/, "")
            .replace(/\.git$/, "")
        : ""
    const commands = [
      ...(repo ? [["api", `repos/${repo}/pulls/${prNumber}/files`, "--paginate", "--jq", ".[].filename"]] : []),
      ["pr", "view", prNumber, "--json", "files", "--jq", ".files[].path"],
      ["pr", "diff", prNumber, "--name-only"],
    ]
    for (const args of commands) {
      const proc = spawnGh(args)
      const [filesOut, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
      const files = filesOut.split(/\r?\n/).filter(Boolean)
      if (code === 0 && files.length > 0) return { files, unavailable: false }
    }
    return { files: [], unavailable: true }
  }

  async function mergeBaseRef() {
    const upstream = await git(ctx.input.worktree, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"])
    const originHead = await git(ctx.input.worktree, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"])
    for (const ref of [
      upstream.code === 0 ? upstream.stdout.trim() : "",
      originHead.code === 0 ? originHead.stdout.trim() : "",
      "origin/dev",
      "origin/develop",
      "origin/main",
      "origin/master",
      "dev",
      "develop",
      "main",
      "master",
    ].filter(Boolean)) {
      const result = await git(ctx.input.worktree, ["rev-parse", "--verify", ref])
      if (result.code === 0 && result.stdout.trim()) return ref
    }
    return ""
  }

  async function developmentBaseRef() {
    for (const ref of ["origin/dev", "origin/develop", "dev", "develop"]) {
      const result = await git(ctx.input.worktree, ["rev-parse", "--verify", ref])
      if (result.code === 0 && result.stdout.trim()) return ref
    }
    return ""
  }

  function mergeReviewTier(branch: string, files: string[]): MergeReviewTier {
    if (files.length > 0) {
      if (files.some(highRisk)) return "FULL"
      if (files.every(docsOnly)) return "DOCS_ONLY"
      if (files.every(lowRisk)) return "LIGHT"
      return "FULL"
    }
    if (/^docs\//.test(branch)) return "LIGHT"
    if (/^(ci|chore|fix)\//.test(branch)) return "LIGHT"
    return "FULL"
  }

  function docsOnly(file: string) {
    const item = file.replaceAll("\\", "/")
    if (/^(docs|packages\/docs|specs)\//.test(item)) return true
    if (/^\.github\/(ISSUE_TEMPLATE|PULL_REQUEST_TEMPLATE)(\/|$)/.test(item)) return true
    return /(^|\/)(README|CHANGELOG|CONTRIBUTING|SECURITY|LICENSE|NOTICE|CODE_OF_CONDUCT)(\.(md|mdx|txt|rst|adoc))?$/i.test(
      item,
    )
  }

  function lowRisk(file: string) {
    const item = file.replaceAll("\\", "/")
    if (highRisk(item)) return false
    if (docsOnly(item)) return true
    if (/(^|\/)(gen|generated|dist|out)\//i.test(item) || /(^|\/).*\.gen\.(ts|tsx|js|jsx)$/i.test(item)) return true
    if (/(^|\/)sst-env\.d\.ts$/i.test(item)) return true
    if (/(^|\/)(LICENSE|NOTICE|\.gitignore|\.editorconfig)$/i.test(item)) return true
    return /(^|\/)(test|tests|__tests__|fixtures|examples)\/|(^|\/)[^/]+\.(test|spec|stories)\.[cm]?(ts|tsx|js|jsx)$/i.test(
      item,
    )
  }

  function highRisk(file: string) {
    const item = file.replaceAll("\\", "/")
    if (/^\.github\/workflows\//.test(item)) return true
    if (/^packages\/guardrails\/profile\//.test(item)) return true
    if (/(^|\/)(AGENTS|package|opencode|tsconfig)(\.[^/]*)?$/i.test(item)) return true
    return /(^|\/)(bun\.lock|package-lock\.json|pnpm-lock\.yaml|yarn\.lock)$/i.test(item)
  }

  async function bashAfterGit(
    item: { tool: string; args?: Record<string, unknown> },
    out: { output: string; metadata: Record<string, unknown> },
    data: Record<string, unknown>,
  ) {
    const cmd = str(item.args?.command)
    if (item.tool !== "bash" || !cmd) return

    const afterPrMergeNumber = ghPrMergeNumber(cmd)
    const afterIsMerge = gitSubcommand(cmd, "merge") || ghPrCommand(cmd, "merge") || ghApiPrMerge(cmd)
    const afterIsPrMerge = ghPrCommand(cmd, "merge") || ghApiPrMerge(cmd)
    const afterIsPrCreate = /\bgh\s+pr\s+create\b/i.test(cmd)
    const afterIsPush = gitSubcommand(cmd, "push")

    if (afterIsPush || afterIsPrCreate) {
      out.output = (out.output || "") + "\n⚠️ Remember to verify CI status: `gh pr checks`"
      try {
        const proc = Bun.spawn(["gh", "pr", "view", "--json", "mergeable", "--jq", ".mergeable"], {
          cwd: ctx.input.worktree,
          stdout: "pipe",
          stderr: "pipe",
        })
        const [mergeOut] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
        if (mergeOut.trim() === "CONFLICTING") {
          out.output += "\n⚠️ PR has merge conflicts. Rebase or merge the base branch before proceeding."
          await ctx.seen("pr.merge_conflict_detected", {})
        }
      } catch {}
    }

    if (afterIsPrMerge) {
      out.output =
        (out.output || "") + "\n🚀 Post-merge: verify deployment status and run smoke tests on the target environment."
      try {
        if (afterPrMergeNumber) {
          const repoRes = await git(ctx.input.worktree, ["remote", "get-url", "origin"])
          const repo =
            repoRes.code === 0
              ? repoRes.stdout
                  .trim()
                  .replace(/.*github\.com[:/]/, "")
                  .replace(/\.git$/, "")
              : ""
          if (repo) {
            const proc = Bun.spawn(
              ["gh", "api", `repos/${repo}/pulls/${afterPrMergeNumber}/files`, "--jq", ".[].filename"],
              {
                cwd: ctx.input.worktree,
                stdout: "pipe",
                stderr: "pipe",
              },
            )
            const [filesOut] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
            const files = filesOut.trim()
            const risks: string[] = []
            if (/^terraform\/|\.tf$/m.test(files)) risks.push("Terraform")
            if (/migration|migrate|\.sql$/im.test(files)) risks.push("Migration/DDL")
            if (/^\.github\/workflows\//m.test(files)) risks.push("GitHub Actions")
            if (/Dockerfile|docker-compose|cloudbuild/im.test(files)) risks.push("Docker/Cloud Build")
            if (/deploy|release/im.test(files)) risks.push("Deploy/Release")
            if (risks.length > 0) {
              out.output +=
                "\n\n⚠️ [POST-MERGE VALIDATION] High-risk changes detected: " +
                risks.join(", ") +
                ".\nChecklist: HTTP 200, HTTPS, no errors in logs, migration rollback plan, Terraform plan attached, Docker --platform linux/amd64."
              await ctx.seen("post_merge.validation_required", { pr: afterPrMergeNumber, risks })
            }
          }
        }
      } catch {}
    }

    if (afterIsPrMerge) {
      await ctx.mark({ last_merge_at: new Date().toISOString() })
      if (/\b(fix(es)?|close[sd]?|resolve[sd]?)\s+#\d+/i.test(out.output)) {
        out.output =
          (out.output || "") + "\n📋 Detected issue reference in merge output. Verify referenced issues are closed."
      }
    }

    if (afterIsMerge) {
      const fresh = await stash(ctx.state)
      if (flag(fresh.soak_time_warning)) {
        out.output =
          (out.output || "") +
          "\n⏳ Soak time advisory: only " +
          num(fresh.soak_time_elapsed_h) +
          "h since last merge (12h recommended). Consider waiting before merging to main."
        await ctx.mark({ soak_time_warning: false })
      }
    }

    if (afterIsPush) {
      try {
        const branchRes = await git(ctx.input.worktree, ["branch", "--show-current"])
        const branch = branchRes.code === 0 ? branchRes.stdout.trim() : ""
        const base = await mergeBaseRef()
        if (branch && base && !protectedBranchNames.includes(branch)) {
          const diffRes = await git(ctx.input.worktree, [
            "diff",
            "--name-only",
            `${base}..HEAD`,
            "--",
            ".github/workflows/",
          ])
          const files = diffRes.code === 0 ? diffRes.stdout.trim() : ""
          if (files) {
            out.output +=
              "\n\n⚠️ [WORKFLOW SYNC] .github/workflows/ files differ from main:\n" +
              files
                .split("\n")
                .map((item: string) => "  - " + item)
                .join("\n") +
              "\nOIDC validation requires workflow files to match the default branch. Create a chore PR to sync."
            await ctx.seen("workflow_sync.diverged", { branch, files: files.split("\n") })
          }
        }
      } catch {}
    }

    if (/\bgit\s+commit\b/i.test(cmd) && num(data.edit_count) >= 5) {
      out.output =
        (out.output || "") +
        "\n🧠 Significant changes committed (" +
        num(data.edit_count) +
        " edits). Consider updating memory with key decisions or learnings."
    }

    if (afterIsPrCreate) {
      const prNum = (out.output || "").match(/github\.com\/[^/]+\/[^/]+\/pull\/(\d+)/)?.[1]
      if (prNum) {
        await ctx.mark({ review_pending: true, review_pending_pr: prNum })
        out.output +=
          "\n\n📋 [AUTO-REVIEW REQUIRED] PR #" +
          prNum +
          " created. Run code-reviewer agent and address all CRITICAL/HIGH findings before merging."
        await ctx.seen("post_pr_create.review_trigger", { pr: prNum })
      }
    }

    if (afterIsPrCreate) {
      if (/--title\s+["']?fix/i.test(cmd) || /\bfix\//i.test(cmd)) {
        const fixes = num(data.consecutive_fix_prs) + 1
        await ctx.mark({ consecutive_fix_prs: fixes })
        if (fixes >= 2) {
          out.output =
            (out.output || "") +
            "\n⚠️ Feature freeze warning: " +
            fixes +
            " consecutive fix PRs on the same feature. Consider stabilizing before adding more changes."
        }
      } else {
        await ctx.mark({ consecutive_fix_prs: 0 })
      }
    }

    if (afterIsPrCreate) {
      const fresh = await stash(ctx.state)
      if (flag(fresh.pr_guard_warning)) {
        const tests = flag(fresh.pr_guard_tests)
        const types = flag(fresh.pr_guard_types)
        const missing = [!tests && "tests", !types && "typecheck"].filter(Boolean).join(", ")
        out.output =
          (out.output || "") +
          "\n🛡️ PR guard: " +
          missing +
          " not yet run this session. Run `bun turbo test:ci && bun turbo typecheck` before creating PR."
        await ctx.mark({ pr_guard_warning: false })
      }
      if (flag(fresh.deploy_verify_warning)) {
        out.output =
          (out.output || "") +
          "\n🚀 Deploy verification: changed hooks/scripts detected but not yet deployed. Run setup.sh and verify firing before merging."
        await ctx.mark({ deploy_verify_warning: false })
      }
    }

    if (afterIsPrMerge) {
      const fresh = await stash(ctx.state)
      if (flag(fresh.review_reading_warning)) {
        out.output =
          (out.output || "") +
          "\n📖 Stale review: code was pushed after the last review. Re-request review before merging."
        await ctx.mark({ review_reading_warning: false })
      }
    }

    if (afterIsPush || afterIsPrMerge) {
      const fresh = await stash(ctx.state)
      if (flag(fresh.stop_test_warning)) {
        out.output =
          (out.output || "") +
          "\n🚫 Test gate: " +
          num(fresh.edit_count) +
          " edits without running tests. Run tests before pushing/merging."
        await ctx.mark({ stop_test_warning: false })
      }
    }
  }

  return { bashBeforeGit, bashAfterGit }
}
