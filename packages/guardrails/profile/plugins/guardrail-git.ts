import { git } from "./guardrail-patterns"
import type { GuardrailContext } from "./guardrail-context"
import path from "path"

export function createGitHandlers(ctx: GuardrailContext) {
  const protectedBranchNames = ["main", "master", "develop", "dev"]
  const opencodeForkRepo = "Cor-Incorporated/opencode"
  const opencodeForkOwner = "Cor-Incorporated"
  const opencodeUpstreamRepo = "anomalyco/opencode"
  const opencodeBaseBranch = "dev"
  let opencodeWorktree: boolean | undefined

  function shellWord() {
    return `(?:"[^"]+"|'[^']+'|\\S+)`
  }

  function gitSubcommand(cmd: string, name: string) {
    return new RegExp(
      `\\bgit(?:\\s+-C\\s+${shellWord()}|\\s+-c\\s+${shellWord()}|\\s+--(?:git-dir|work-tree|namespace)=${shellWord()}|\\s+--(?:git-dir|work-tree|namespace)\\s+${shellWord()})*\\s+${name}\\b`,
      "i",
    ).test(cmd)
  }

  function spawnGh(args: string[]) {
    return Bun.spawn(["gh", ...args], {
      cwd: ctx.input.worktree,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env },
    })
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
      "Guardrail policy blocked this action: GitHub review API cannot approve your own PR. Record the review as a comment instead.",
    )
  }

  async function bashBeforeGit(cmd: string, _out: { output?: string }, _data: Record<string, unknown>) {
    await blockOwnApproval(cmd)
    await blockWrongOpencodePrTarget(cmd)

    const protectedBranch = new RegExp(`^(${protectedBranchNames.join("|")})$`)
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
  }

  return { bashBeforeGit }
}
