// git-guard: 保護ブランチへの直接 push・merge を禁止する OpenCode plugin。
//
// 単層構造:
//   tool.execute.before hook: 実行時にブランチ名を見て main/master/develop/dev への
//   push/merge をブロック。例外を投げて tool 実行を停止する。
//
// 注: config hook による permission.bash の mutation は機能しない。
//   permission system は plugin load 前に config から Ruleset を構築するため、
//   config hook での cfg.permission.bash への書き込みは評価に反映されない。
//   bash permission は opencode.jsonc の permission.bash セクションで直接管理すること。
//
// 補完関係:
//   guardrail-git.ts が包括的な保護 (CI gate, review gate, PR merge block 等) を
//   提供する。本プラグインは guardrail.ts がロードされない環境での最低限の
//   保護として機能する。両方がロードされた場合、二重ガードとなる (先に
//   実行された hook の throw が tool 実行を停止するため、後続 hook は未到達)。
//
// 既知の限界: サブエージェント/MCP 経由のツール呼び出しには発火しない
//   (sst/opencode #5894, #2319)。

import type { PluginInput } from "@opencode-ai/plugin"

const PROTECTED = ["main", "master", "develop", "dev"]
const OPENCODE_FORK_REPO = "Cor-Incorporated/opencode"
const OPENCODE_UPSTREAM_REPO = "anomalyco/opencode"
const OPENCODE_BASE = "dev"

// git subcommand を安全に検出 (git -C ... や git -c ... 等の引数をスキップ)
const shellWord = `(?:"[^"]+"|'[^']+'|\\S+)`
const gitSubcommand =
  (name: string) =>
  (cmd: string): boolean =>
    new RegExp(
      `\\bgit(?:\\s+-C\\s+${shellWord}|\\s+-c\\s+${shellWord}|\\s+--(?:git-dir|work-tree|namespace)=${shellWord}|\\s+--(?:git-dir|work-tree|namespace)\\s+${shellWord})*\\s+${name}\\b`,
      "i",
    ).test(cmd)

const isPush = gitSubcommand("push")
const isMerge = gitSubcommand("merge")

const shellValue = (value: string) => value.replace(/^["']|["']$/g, "")

const optionValue = (cmd: string, long: string, short: string) => {
  const escaped = long.replaceAll("-", "\\-")
  return (
    cmd.match(new RegExp(`(?:^|\\s)${escaped}=([^\\s]+)`))?.[1] ??
    cmd.match(new RegExp(`(?:^|\\s)${escaped}\\s+([^\\s]+)`))?.[1] ??
    cmd.match(new RegExp(`(?:^|\\s)${short}\\s+([^\\s]+)`))?.[1] ??
    cmd.match(new RegExp(`(?:^|\\s)${short}([^\\s]+)`))?.[1] ??
    ""
  )
}

// 明示的な ref 指定から保護ブランチを検出
// "origin main" / "origin/main" / "HEAD:main" 等を検出
// feat/develop-x 等は除外
const explicitRefTargetsProtected = (cmd: string): boolean => {
  // "git push origin main" / "git push origin HEAD:main"
  const pushRef = cmd.match(/\bgit\s+push\s+(?:(?:-\w+|--[\w-]+)\s+)*\S+\s+(?:HEAD:)?(\S+)/i)
  if (pushRef && PROTECTED.includes(pushRef[1])) return true

  // "HEAD:main" style refspec
  const refspec = new RegExp(`HEAD:(${PROTECTED.join("|")})(?:\\s|$)`, "i")
  if (refspec.test(cmd)) return true

  return false
}

const gitArgs = (workdir: string | undefined) => (workdir ? ["-C", workdir] : [])

const isOpencodeWorktree = async (workdir: string | undefined) => {
  try {
    const result = await Bun.spawn(["git", ...gitArgs(workdir), "remote", "-v"], {
      stdout: "pipe",
      stderr: "pipe",
    })
    const [out, code] = await Promise.all([new Response(result.stdout).text(), result.exited])
    return code === 0 && /github\.com[:/](Cor-Incorporated|anomalyco)\/opencode(?:\.git)?/i.test(out)
  } catch {
    return false
  }
}

const blockWrongOpencodePrTarget = async (cmd: string, workdir: string | undefined) => {
  if (!/\bgh\s+pr\s+create\b/i.test(cmd) && !/\bgh\s+api\b[\s\S]*\brepos\/[^/\s]+\/[^/\s]+\/pulls\b/i.test(cmd)) {
    return
  }
  if (!(await isOpencodeWorktree(workdir))) return

  if (/\bgh\s+api\b[\s\S]*\brepos\/anomalyco\/opencode\/pulls\b/i.test(cmd)) {
    throw new Error(
      `opencode の PR 作成先は fork の ${OPENCODE_FORK_REPO}:${OPENCODE_BASE} です。` +
        ` upstream の ${OPENCODE_UPSTREAM_REPO} 宛て PR 作成は禁止です。`,
    )
  }

  if (!/\bgh\s+pr\s+create\b/i.test(cmd)) return
  const repo = shellValue(optionValue(cmd, "--repo", "-R"))
  const base = shellValue(optionValue(cmd, "--base", "-B"))
  const head = shellValue(optionValue(cmd, "--head", "-H"))

  if (repo !== OPENCODE_FORK_REPO) {
    throw new Error(
      `opencode の PR 作成先は fork の ${OPENCODE_FORK_REPO} です。` +
        ` gh pr create には --repo ${OPENCODE_FORK_REPO} を明示してください。`,
    )
  }
  if (base !== OPENCODE_BASE) {
    throw new Error(
      `opencode の PR base は ${OPENCODE_FORK_REPO}:${OPENCODE_BASE} です。` +
        ` gh pr create には --base ${OPENCODE_BASE} を明示してください。`,
    )
  }
  if (head.toLowerCase().startsWith("anomalyco:")) {
    throw new Error(
      `opencode の PR head は origin / ${OPENCODE_FORK_REPO} 側にしてください。` +
        ` upstream (${OPENCODE_UPSTREAM_REPO}) を head にした PR 作成は禁止です。`,
    )
  }
}

export default async function gitGuard(input: PluginInput) {
  return {
    // ---------------------------------------------------------------
    // tool.execute.before: 保護ブランチへの push/merge をブロック
    // ---------------------------------------------------------------
    "tool.execute.before": async (input: { tool: string }, output: { args: Record<string, unknown> }) => {
      if (input.tool !== "bash") return
      const cmd = String(output.args?.command ?? "")
      if (!cmd) return

      const workdir = typeof output.args?.workdir === "string" ? output.args.workdir : undefined
      await blockWrongOpencodePrTarget(cmd, workdir)

      const pushes = isPush(cmd)
      const merges = isMerge(cmd)
      if (!pushes && !merges) return

      // bash コマンドの workdir を取得して正しい branch を判定
      let current = ""
      try {
        const result = await Bun.spawn(["git", ...gitArgs(workdir), "branch", "--show-current"], {
          stdout: "pipe",
          stderr: "pipe",
        })
        const [out] = await Promise.all([new Response(result.stdout).text(), result.exited])
        current = out.trim()
      } catch {
        current = ""
      }
      const onProtected = PROTECTED.includes(current)

      // merge: 保護ブランチ上での直接マージを禁止（PR 経由を強制）
      if (merges && onProtected) {
        throw new Error(`保護ブランチ '${current}' への直接 merge は禁止です。PR 経由でマージしてください。`)
      }

      // push: 保護ブランチを対象にした push を禁止（force / 非force 問わず）
      if (pushes && (explicitRefTargetsProtected(cmd) || onProtected)) {
        throw new Error(
          `保護ブランチ(${PROTECTED.join("/")})への直接 push は禁止です。` +
            `feature ブランチで作業し PR を出してください。`,
        )
      }
    },
  }
}
