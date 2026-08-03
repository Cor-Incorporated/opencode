# ADR: Agent-Spanning Implementation Anti-Patterns — Guards as OpenCode Mechanism

- Status: Accepted (2026-08-03)
- Related: `packages/guardrails/README.md`, Grift #1741 / #1750 / #1753, specs/v2/catalog-config-plugin-lifecycle.md
- Driver: 5 リポジトリ横断調査(Grift / ai-cluster / phone-training-system / persona-village-forecast / persona-village-v2)で、エージェント(Claude Code / Codex / Cursor / Grok / OpenCode)を問わず反復する実装問題を、**ドキュメントではなく OpenCode の仕組み(plugin / permission / command / skill)で止める**。

## Context

### 調査対象と実測(2026-08-03)

| リポジトリ | worktree | ローカルブランチ | マージ済み放置 | OPEN Issue | エージェント署名 |
|---|---|---|---|---|---|
| Grift | 13 | 24 | 17/24 | 49 | — |
| persona-village-v2 | **24** | **86** | 11/86 | 16 | Claude Code 206 |
| persona-village-forecast | **17** | 18 | 8/18 | 0 | Claude Code 64 |
| phone-training-system | 1 | 2 | 1/2 | **50** | — |
| ai-cluster | 1 | 3 | 0 | 11 | Claude Code 7 |

### 反復する 8 パターン(エージェント横断の抽象化)

| # | パターン | 実例 | 本質 |
|---|---|---|---|
| **A** | 変更の影響範囲分析の欠如 | Grift #1741(質問 skip でデッドロック)/ #1750(policy-ci ジョブ削除で CI 結線破壊) | 取り除く・変えるとき、逆被参照(参照元・名前ベース結線)を構造的に検証しない |
| **B** | 並列実行の権限不足 | Grift team/subagent が `git worktree list` / `git merge-base` で deny → 失敗 | ワーカーに必要な読み取り系ツールが許可されず独立実行できない |
| **C** | パイプラインの両極端 | Grift 重層レビュー → 廃止 / phone-training-system レビュー 0 往復(過疎)/ persona-village-v2 PR +4753 行(巨大) | 「最小の検証で最大の学習」の原則が無い。重すぎても軽すぎても学習が遅れる |
| **D** | 環境の過剰構築 | Grift cloudia-grift-uat(1 日+大量リソース→削除)/ phone-training-system UAT サービス | 既存環境で足りるのに新環境を作る(宣言と実体の二重管理) |
| **E** | Issue/ブランチ/worktree 放置 | 全リポジトリ横断(persona-village-v2 86 ブランチ・24 worktree 等) | 作る前に「使い捨て・整理」の仕組みが無く、環境が雪だるま式に汚染 |
| **F** | 反証なし修正 | Grift #1741/#1750(修正が正しく見えて実はバグより悪化) | 「修正を外すと落ちる」を実装時に強制しない |
| **G** | 余計なパイプラインをそもそも作らない | 重量級 CI/レビュー基盤の構築が学習を遅らせる | 最小検証パスをデフォルトにし、追加は実証後 |
| **H** | 外部エージェント非依存のダブルチェック | 客観性証明を codex/claudecode に依存 | 自己完結で客観性を証明する手段(反証テスト・結線テスト)を標準装備 |

### 既存の対応と限界

- Grift では ADR-0067(削除は置換まで)やハンドオーバー文書で対処したが、**ドキュメントは強制力ゼロ**(#1750 で再発)
- OpenCode の `packages/guardrails` は「mechanism-first guardrails / fast feedback / runtime verifiability」を原則としているが、上記 8 パターンを網羅するガードは未実装

## Decision

### 1. ガードは「ドキュメントではなく仕組み」で実装する

ADR・ハンドオーバー文書は**ソフト規約**として残すが、実効性は以下の 4 レイヤーで担保する:

1. **CI 結線テスト**(最高の強制力)— 宣言と実体を結ぶテストを常設
2. **Plugin フック**(実行時強制)— 問題パターンを検知して警告・ブロック
3. **Permission**(物理的制限)— 破壊的操作を deny、必要な操作を allow
4. **Command / Skill**(手順強制)— 軽量 PDCA・環境スコープ・衛生を行動規範に

### 2. 各パターンを OpenCode の仕組みにマッピング

| パターン | 実装手段 | 配置 |
|---|---|---|
| A(影響範囲) | Plugin: 削除検知 → 逆被参照 grep → 警告 | `packages/guardrails/profile/plugins/` |
| B(並列権限) | Permission: 読み取り系 git を allow / 破壊系を deny | `packages/guardrails/profile/opencode.json` |
| C(パイプライン両極端) | Command: `/plan-light`(最小検証パス宣言)+ Plugin: PR サイズ警告 | `packages/guardrails/profile/commands/` |
| D(環境過剰構築) | Command: `/env-check`(既存で足りるか確認)+ Skill | `packages/guardrails/profile/commands/` |
| E(放置) | Plugin: セッション開始時の衛生警告 + Command: `/repo-hygiene` | `packages/guardrails/profile/plugins/` |
| F(反証なし) | Skill + CI 結線テストテンプレート(反証可能なテストの強制) | `packages/guardrails/profile/skills/` |
| G(余計なパイプライン) | Command: `/plan-light` で最小検証パスをデフォルト化 | `packages/guardrails/profile/commands/` |
| H(外部依存ダブルチェック) | Skill + CI 結線テスト(自己完結の客観性証明) | `packages/guardrails/profile/skills/` |

### 3. 実装は「反証付き」で行う

各ガード(plugin / command / permission)は、**実装時に「ガードを無効化すると落ちる」ことを実測**してからマージする。ガード自体が 8 パターン(F)の適用対象である。

## Consequences

### 良い面

- 8 パターンが**エージェントを問わず** OpenCode の仕組みで止まる(Claude Code / Codex / Cursor / Grok / OpenCode のどれで作業しても同じガードが効く)
- 「ドキュメントに書いたのに繰り返す」問題を、CI テスト + plugin フック + permission の 3 層で解消
- guardrails profile は `packages/guardrails` の既存設計(thin distribution layer)と整合

### 負の面

- 実装コスト(plugin 3 本 + command 3 本 + skill 4 本 + permission 変更)
- Permission の誤設定は作業を阻害するため、allow は読み取り系のみに限定し、ask/deny を慎重に設計する必要がある

## Acceptance Evidence

| 基準 | 証跡タイプ | 追跡先 | 状態 |
|---|---|---|---|
| 8 パターンの抽象化が 5 リポジトリ調査に基づく | 調査記録 | 本 ADR Context 表 | 取得済み(2026-08-03) |
| 各ガードが「無効化すると落ちる」反証を持つ | 実装 PR + テスト | 実装 Issue の各 PR | 未着手 |
| guardrails profile にガードが追加される | 実装 diff | `packages/guardrails/profile/` | 未着手 |
| 全リポジトリ(Grift 含む)でガードが効く | 運用記録 | 次回以降の PR | 未着手 |
