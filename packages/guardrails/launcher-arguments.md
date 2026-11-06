# 2系CLIの引数とプライベートサーバー

`bin/opencode-guardrails` は、サーバーを利用するコマンドに `--standalone` を加え、今回の設定と環境変数を新しいサーバーへ渡す。フラグは、そのフラグを受理する末端コマンドの直後に置く。例えば `auth export` は `auth export --standalone` になる。`auth --standalone export` は 2.0.32 では構文エラーになる（2.2.5 は受理する）。

| コマンド                                                                       | ランチャーの動作                                       |
| ------------------------------------------------------------------------------ | ------------------------------------------------------ |
| TUI                                                                            | 先頭に `--standalone` を追加                           |
| `run` / `models` / `stats` / `mini` / `api` / `reload`                         | コマンド直後に追加                                     |
| `auth` / `session` の各末端コマンド                                            | 末端コマンド直後に追加                                 |
| `mcp list` / `mcp auth` / `mcp logout`                                         | 対象CLIの `--help` がフラグを宣言すれば追加、しなければ起動を止める |
| `plugin list` / `plugin check` / `plugin update`                               | 対象CLIの `--help` がフラグを宣言すれば追加、しなければ起動を止める |
| `debug config` / `debug agents`                                                | 対象CLIの `--help` がフラグを宣言する場合だけ追加      |
| `debug paths` / `debug heap-dump` / `mcp add` / `plugin add` / `plugin remove` | 変更しない                                             |
| `acp` / `serve` / `pair` / `service` / `upgrade` / `update` / `uninstall`      | 各コマンドがサーバーや設定の扱いを決めるため変更しない |

インストール済みの2.0.32では `debug config`・`debug agents`・`mcp` と `plugin` の末端コマンドが `--standalone` を受理しない（`Unrecognized flag: --standalone in command opencode mcp list`、2026-11-05 実測）。2.2.5 はすべて受理する。同じランチャーで両方を扱うため、これらに限り選択済みバイナリのヘルプを確認する。フラグが無いとき、`debug` はローカル処理なのでそのまま起動する。`mcp` と `plugin` はバックグラウンドサーバーを使ってしまうので起動を止め、`OPENCODE_GUARDRAILS_ALLOW_SERVICE=1` を案内する。この確認に失敗した場合は起動を止め、バックグラウンドサーバーへ切り替えない。ヘルプ確認には最終起動と同じ環境を渡し、認証値を引数や出力へ含めない。

明示された `--server` / `--standalone`、ヘルプ・バージョン・補完要求は維持する。`--log-level debug` の `debug` はコマンド名として扱わず、`--` 以降の文字列もランチャーのオプションとして扱わない。`OPENCODE_GUARDRAILS_ALLOW_SERVICE=1` の明示指定は従来どおりサーバー選択を呼び出し側へ委ねる。

オフラインの回帰検査は `packages/guardrails` で `bun test profile/src/standalone-args.test.ts` を実行する。実ランチャーを厳密な引数スタブへ接続し、末端コマンドの構文、旧版・新版のヘルプ、確認失敗時の停止を検査する。保存済み認証情報やモデルAPIは使用しない。
