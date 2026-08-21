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

## Route B/C 委任受領契約

handover を受領したら、次の 10 欄が一字一句一致で存在し、内容が埋まっていることを着手前に確認する。不足欄を推測で補わない。

1. 停止条件と最大反復
2. 報告間隔 / 無進捗タイムアウト
3. 課金上限
4. 発射前の実現可能性チェック
5. 人間ゲート列挙（「リマインドのみ」セクションに分離）+ 待ち中の可否
6. 反証可能な完了条件
7. 事前スパイク回答欄
8. 完了条件の検査
9. 追加を提案しない
10. 強制点の実測表

H8 の補助欄は次の 7 欄を一字一句一致で記載し、各欄を 20 文字以上の実質内容で埋める。

### 一次資料

推測ではなく、判定に用いる Issue・正本・実装・実測証跡を列挙する。

### 要求インベントリ

要求を原子単位で列挙し、実装・検証・人間ゲートの境界を分ける。

### 突合表

要求と実装、実装と配備、配備と実測を対応づけて漏れを示す。

### 標準質問

過大主張、未検証境界、権限越境、既存装置の破壊がないかを問う。

### 北極星

活動量ではなく、今回の変更で到達させる利用者価値または事故削減を示す。

### 反証軸

実装前に、F1 の軸列挙、F2 の事故入力、F3 の片側変異のいずれかを 20 文字以上で書く。「テスト green」だけは不可。

### 撤収

worktree の回収先として commit / PR 番号または retire 判定を書き、`active` / `recover` / `preserve` / `retire` のいずれかを含める。

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
