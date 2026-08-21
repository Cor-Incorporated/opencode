# Guardrail Profile

- Treat this profile as a thin distribution over upstream OpenCode.
- Prefer config, commands, agents, and plugins over core runtime patches.
- Prefer mechanism over prose: enforce with plugins, commands, permissions, and CI before adding more instruction text.
- Keep always-loaded instructions short and pointer-based; move detailed rationale into ADRs and docs.
- Keep skill-style progressive disclosure intact: brief routing text here, detailed rationale in docs, deterministic enforcement in plugins and commands.
- Push checks to the fastest reliable layer first, then fall back to command workflows and CI for authoritative gates.
- Keep project-local `.opencode` assets working; use them for repo-specific workflows instead of editing this profile unless the rule is organization-wide.
- Treat `.opencode/guardrails/` as plugin-owned runtime state, not a manual editing surface.
- Use `implement` as the guarded default primary agent. Route review, ship, and handoff work through the packaged `/review`, `/ship`, and `/handoff` commands instead of freeform release flows.
- Keep review paths read-only. If a workflow needs edits, return to `implement` or a project-local implementation agent instead of widening the review agent.
- All configured providers are available for standard work. The `provider-eval` agent and `/provider-eval` command remain available for dedicated evaluation workflows.

## Code Style

- Immutable: `return { ...user, name }` — no mutations
- High cohesion, low coupling; organize by feature/domain
- Functions < 50 lines, files < 800 lines, nesting < 4 levels
- Validate inputs with Zod; use parameterized queries for SQL
- No `console.log`, no hardcoded values, secrets in env vars only
- Pre-commit: no API keys/tokens, XSS prevention, CSRF protection

## Testing

- Coverage ≥ 80% (unit + integration + E2E combined)
- Test levels: Unit = project test runner (`bun test`, vitest, jest), E2E = Playwright/browser only
- `curl` alone is NOT E2E — E2E requires browser verification
- TDD cycle: RED → GREEN → IMPROVE → check coverage
- Test falsifiability: prove the test fails when the bug exists (see `/test`)
- Prefer in-repo `bun test` for guardrail verification. Inline interpreter shells (`bun -e`, `python -c`, `node --eval`, etc.) are blocked by the access guard because they can mutate `.opencode/guardrails` runtime state — do not rely on `/tmp` one-off scripts for proof.

## Team / background timeouts

`/team` and background workers use a **hard wait ceiling** (not true idle detection). Override with env vars:

| Variable | Meaning | Default |
|----------|---------|---------|
| `OPENCODE_TEAM_IDLE_TIMEOUT_MS` | Global hard wait for any worker | write budget (20m) when unset and task is write/deepseek; else see below |
| `OPENCODE_TEAM_WRITE_IDLE_TIMEOUT_MS` | Write/implement workers | `1200000` (20m) |
| `OPENCODE_TEAM_IDLE_TIMEOUT_MS_<PROVIDER>` | Provider-scoped override (e.g. `OPENCODE_TEAM_IDLE_TIMEOUT_MS_DEEPSEEK`) | unset |

Defaults: read-only workers `600000` (10m); write workers and deepseek `1200000` (20m). Timeout errors include last status/tool/text and remind you of these variables.

## Quality

- Fix errors and warnings introduced by the current change; pre-existing issues outside scope are tracked, not fixed inline
- "Done" = implementation + tests + docs updated + verified by the smallest relevant check; partial ≠ done
- Pre-commit: lint, typecheck, and tests must all pass
- Bug fixes: grep all instances → fix all → re-grep to confirm zero remaining
- Fact-check: back every claim with CLI output, git diff, or API response; mark estimates as "(unverified)"

## 完了報告の証跡トレーラー（不可逆・課金・完了宣言に限定）
「完了」「verified」「根因確定」を含む報告の末尾に必須:
`Evidence: <実行コマンド> | <生出力の要点 or ログパス> | <実行時刻>`
- 宣言ファイルを変えたら「誰がそれを読んで強制しているか」の grep 結果を同報告に貼る
- 監督（Claude/人間）の記載に事実誤りを見つけたら実測付きで反証してよい

## 委任受領プロトコル（経路 B/C）
- 受領した handover に次の 10 欄が無ければ、着手前に不足欄を指摘して返す。
  `停止条件と最大反復` / `報告間隔 / 無進捗タイムアウト` / `課金上限` /
  `発射前の実現可能性チェック` /
  `人間ゲート列挙（「リマインドのみ」セクションに分離）+ 待ち中の可否` /
  `反証可能な完了条件` / `事前スパイク回答欄` / `完了条件の検査` /
  `追加を提案しない` / `強制点の実測表`。
- H8 補助欄として `一次資料` / `要求インベントリ` / `突合表` / `標準質問` /
  `北極星` / `反証軸` / `撤収` も空欄不可。Route B/C の 10 欄とは別に検査する。
- 「詰まっています」は義務発信: 同一エラーで 3 回失敗 / 30 分無進捗 / 判断待ちで
  次の手が無い、のいずれかで作業を止めて報告する（無言のリトライ継続は禁止）
- 人間ゲート待ち中: 準備・別タスクは可。本番系の迂回経路新設は不可

## 新規依存の実物照合（着手前に回答。空欄不可・「確認せず採用」は明記すれば可）
- 新規フレームワーク / 外部 API: インストール済みソース・公式 docs・実レジストリで確認したか
- 性能仮説（速くなるはず）: 数ターンの最小実測をしたか
- 組織ポリシー: org allowlist / quota / 環境変数の実在を確認したか

## リポ個別の禁止事項枠
handover の「禁止事項」節は本ブロックと同格の絶対遵守として読む。
違反しかけた場合はその場で停止して報告する。

## 並列作業の撤収（完了条件）
- 完了報告 3 欄: 回収コミット SHA / 削除した worktree・ブランチ / 残す判断待ち在庫（理由つき）
- worker 成果の回収は定型コミット `chore(team): apply worker changes` を完了条件に含める

## AI作成PR本文のH5マーカー書式

PRを作る前に変更パスを確認し、初版本文へ次の機械可読マーカーを証跡から記入する。最初のCI失敗を待って書式を学ばない。これは既存 `h5-admission` の入力契約を可視化する節であり、強制点そのものは変更しない。

実行環境を持たない変更は次の1行を使う。

```text
H5-E2E: none
```

実行環境を持つ変更はコマンドと20文字以上の生出力要約または安定ログパスを対にする。

```text
H5-E2E: <実際に実行したコマンド>
H5-E2E-OUT: <生出力要約または安定ログパス、20文字以上>
```

`hooks/**/*.sh`、`scripts/**/*.sh`、`settings.json`、`.github/workflows/**` の変更はguard/verifier PRとして、実測した内容を次の形で全て書く。

```text
H5-guard: yes
H5-NEGATIVE: <既知の事故入力と修正前red/exit結果>
H5-LEDGER: <発火がaidd_ledger_appendまたはguard-ledger.jsonlへ届く経路>
H5-RETIRE: <測定可能な撤収条件>
H5-SUBTRACTION: N/A
```

既存装置を廃止する場合だけ `H5-SUBTRACTION: N/A` の代わりに `H5-RETIRE-PR: <merge済みPR番号>` を使う。宣言と強制のpairを変更する場合は両側と片側変異を記録し、変更しない場合は該当なしを明示する。

```text
H5-PAIR: <宣言側> ↔ <強制側>; mutation=<片側変異のred結果>
H5-PAIR: N/A
```

「該当なし」を使えるのは `H5-E2E: none`（実行環境なし）、`H5-SUBTRACTION: N/A`（装置純増・廃止なし）、`H5-PAIR: N/A`（pair変更なし）だけである。構造パス変更の `H5-NEGATIVE` / `H5-LEDGER` / `H5-RETIRE` をN/Aで埋めてはならない。非構造PRでは不要なguardマーカーを省略する。`H5-PAIR` は可視化欄であり、現行h5の合否入力ではない。

## 診断プロトコル（可視化のみ）

これは可視化であり、hook・workflow・required check による強制ではない（C9 適用限界）。
修正前に、仮説を最安で壊す全体クエリを 1 本打つ。

- fleet 分布: 対象全体を状態・鮮度・tenant/org 別に集計し、逸脱数を先に出す。
- production callsite 数: production entrypoint 配下を `rg` し、実呼出し件数を先に数える。
- 実行 role: read-only query で `current_user` と `rolbypassrls` を確認する。

本番接続・資格情報・有料実行は人間ゲートを越えない。

## Git 履歴のツール帰属（可視化のみ）

AI が作成する非 merge commit の末尾に、次の trailer を 1 行記録する。

`Agent-Lane: <claude-code|codex|cursor|opencode>`

これは可視化であり強制ではない。Claude Code の Co-Authored-By は削除せず併記する。
trailer が無い、値が不正、または複数値が競合する commit は H10 で unknown として数える。
## Git Workflow

- Protected branches: dev, develop, main, master — no direct push (hard-blocked by the guardrail plugin; force-push is also hard-blocked), PR only by convention
- Branch naming: `feat/<desc>`, `fix/<desc>`, `refactor/<desc>`, `chore/<desc>`
- Commits: `<type>: <description>` — types: feat/fix/refactor/docs/test/chore/perf/ci/release
- PR granularity: 1 PR = 1 intent, branch type matches PR title type, feat PR includes tests
- Merge: default `--merge`, `--squash` only when explicitly requested
- Check CI status before merging (`gh pr checks`); GitHub branch protection and repo CI are the authoritative merge gates, not this profile

## OpenCode runtime H8 compatibility

The local wrapper smoke reads the seven H8 fields as Markdown headings. The
authoritative wording remains the payload-managed contract above.

### 一次資料

### 要求インベントリ

### 突合表

### 標準質問

### 北極星

### 反証軸

### 撤収

## Delegation

- Dialog, judgment, design → main agent
- 1+ independent tasks → `team` tool via `/delegate` (1-5 tasks, supports single-task isolation)
- Review → `/review` command (stays read-only; uses `code-reviewer` subagent internally)
- Parallel limits: subagents 1-5, Bash 3-4, total ≤ 7

## Commands

| Command | Description |
|---------|-------------|
| `/implement` | Default implementation workflow — code, test, and commit within guardrails. |
| `/review` | Run a read-only code review on the current diff or PR. |
| `/ship` | Merge-ready workflow: verifies CI status and pushes. |
| `/handoff` | Generate a handoff document for cross-session continuity. |
| `/plan` | Analyze requirements, assess risks, and produce a phased implementation plan. |
| `/plan-light` | Declare the minimal verification path before implementing (anti-patterns C/G). |
| `/env-check` | Confirm an existing environment is insufficient before creating a new one (D). |
| `/repo-hygiene` | List stale branches/worktrees and dry-run cleanup candidates (E). |
| `/ssot-check` | Compare mirrored SSOT artifacts (migrations/schema, version pins, OpenAPI) before PR (K). |
| `/test-honesty` | Treat skipped tests as incomplete verification; report passed/failed/skipped (L–O). |
| `/investigate` | Systematic debugging with root cause analysis — spawns an exploration subagent. |
| `/test` | Run the TDD workflow: RED, GREEN, IMPROVE, then verify coverage. |
| `/delegate` | Route work to parallel subagents or Codex CLI based on task shape. |
| `/provider-eval` | Dedicated evaluation workflow for comparing configured providers. |

## Agents

### Primary agents

| Agent | Description |
|-------|-------------|
| `implement` | Default guarded agent for all implementation work. Edits, tests, and commits code within permission boundaries. |
| `provider-eval` | Evaluation-only agent for benchmarking and comparing LLM providers. |

### Subagents

| Agent | Trigger | Description |
|-------|---------|-------------|
| `planner` | `/plan`, complex feature requests | Read-only planning agent. Produces phased plans with risk assessment without modifying code. |
| `investigate` | `/investigate`, debugging tasks | Deep exploration subagent. Reads code, traces data flow, and identifies root causes without edits. |
| `security` | `/review` (security scope), OWASP checks | Security-focused review subagent. Scans for OWASP Top 10 vulnerabilities, credential leaks, and injection risks. |
| `code-reviewer` | `/review`, PR review pipeline | Read-only review agent. Analyzes diffs for quality, correctness, and style issues. |
| `ship` | `/ship` command | Ship agent for merge execution. Verifies CI status and executes `gh pr merge`. Write-restricted except for merge commands. |
| `terraform-engineer` | Infrastructure-as-code tasks | Terraform specialist for module design, state management, and multi-cloud provisioning. Write-capable with safe Terraform CLI commands only. |
| `cloud-architect` | Architecture design, Well-Architected reviews | Read-only cloud architecture analyst for system design, scalability, and compliance. |
| `deployment-engineer` | CI/CD pipeline, container deployments | Write-capable deployment specialist for zero-downtime releases with Docker and Kubernetes read commands. |
| `api-designer` | API design, OpenAPI specs | API design specialist for REST, GraphQL, and OpenAPI specification creation. Write-capable with ask-mode curl. |
| `python-pro` | Python development tasks | Python specialist for modern 3.10+ patterns, async services, and data pipelines. Write-capable with Python toolchain commands. |
| `swift-expert` | Swift/iOS/macOS development | Swift specialist for SwiftUI, async/await concurrency, and protocol-oriented design. Write-capable with Swift and Xcode CLI commands. |
| `websocket-engineer` | Real-time communication tasks | WebSocket and Socket.IO specialist for bidirectional protocols, scaling, and reconnection patterns. Write-capable with Node/Bun runtime. |
| `backend-developer` | Server-side application tasks | Backend specialist for APIs, microservices, auth, caching, and message queues. Write-capable with ask-mode curl. |
| `sql-pro` | SQL and database schema tasks | SQL specialist for query optimization, schema design, migrations, and cross-platform SQL. Write-capable with no direct DB execution. |
| `architect` | System design, architecture decisions | Read-only architecture specialist for system design, scalability, and technical decision-making. |
| `technical-writer` | Documentation, guides, content | Write-capable documentation specialist for README, API docs, ADRs, and tutorials. |
| `doc-updater` | Codemap and doc maintenance | Write-capable specialist for keeping docs in sync with code changes and updating codemaps. |
| `e2e-runner` | End-to-end testing, Playwright | Write-capable E2E testing specialist for Playwright test generation, artifact capture, and flaky test management. |
| `build-error-resolver` | Build failures, type errors | Write-capable build fix specialist. Minimal surgical fixes to get builds green — no refactoring. |
