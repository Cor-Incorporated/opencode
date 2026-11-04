# Fork の CI 実行環境

Cor-Incorporated/opencode は公開 fork で、2026-11-04 時点の登録 runner は 0 台だった。
上流の Blacksmith ラベルをそのまま要求した PR #356 の typecheck、unit、build、Nix は
runner_id=0 のまま待機し、24 時間後に cancelled となっていた。

検証 workflow の job と実行コマンドは維持し、上流では従来の Blacksmith を使い、fork では
GitHub 標準の `ubuntu-24.04` / `windows-2025` を使う。Linux と Windows の matrix、
affected 判定、browser test、集約 check を省略しない。公開リポジトリの標準 runner が対象で、
larger runner、新サービス、追加 secret は使用しない。

標準 runner の clean 環境には `rg` がない場合がある。core のテストは意図しない HTTP 呼び出しを
拒否するため、通常実行時の自動ダウンロードには依存できない。unit job で既存 runtime と同じ
ripgrep 15.1.0 を公式 release から取得し、公式の SHA-256 を固定して照合してから PATH へ追加する。
続けて隔離 HOME の実際の Ripgrep / search tool テストを実行し、`which` の確認だけで済ませない。

guardrails の設定互換テストは core の実 normalizer を読み込むため、Node 24 と固定 lockfile による
workspace の依存インストールを行ってから実行する。ローカルの既存 node_modules に依存させない。

Windows では POSIX の `chmod(600)` で鍵ファイルの非公開性を判定できない。cor-local の鍵ファイルは
組み込み PowerShell の `Get-Acl` で SID を照合し、本人・SYSTEM・Administrators 以外への許可や
検査失敗を拒否する。テストも保護した実 ACL と Everyone の読み取り許可を使って判定を確認する。
`OPENCODE_BIN_PATH` の JavaScript shim は launcher と同じ Node で起動し、native executable の
呼び出しは維持する。Python の検査パスは `fileURLToPath` で変換し、Windows の drive を重複させない。

`close-prs` の失敗 run 41727034808 は、固定対象 `anomalyco/opencode` の PR を 1,428 件取得後、
fork の GITHUB_TOKEN での更新が 403 となっていた。`close-issues` も上流を固定対象にする。
これらの job、上流の有料モデルを使う issue triage、上流 App secret で更新する Nix hash の
job は上流リポジトリでのみ起動する。`context.repo` を対象とする fork の compliance 処理は残す。
release / deploy workflow はこの変更の対象外。

検査は `packages/guardrails` で実行する。

```sh
bun test profile/src/fork-ci.test.ts
```

このテストは実際の YAML にある runner / job 条件式を、上流と fork、Linux と Windows の
コンテキストで評価する。API 呼び出し、PR の close、メッセージ送信は行わない。
workflow の変更も `guardrails.yml` を起動するため、runner の設定だけが戻る変更を検出できる。
upstream の `test.yml` → `check-test.yml`、`nix-eval.yml` → `check-nix.yml`、triage の rename 後も
同じ条件式を移し、旧ファイルを復活させない。

撤収条件は、fork 側で上流ラベルを使える runner が存在し、同一 SHA の全対象 job が待機せず
20 回連続で成功するか、上流自体が標準 runner を選択すること。実測と撤収 PR で fallback を外す。

構造変更の H5 検査は既存 `scripts/h5-admission-check.sh` が担当する。構造 PR の証跡不足では
同スクリプトの block 分岐から `H5_LEDGER_PATH`（既定 `guard-ledger.jsonl`）へ追記される。
runner の既知不正値は本テストで red にし、H5 の ledger 接続は一時 ledger による陰性検査で確認する。
