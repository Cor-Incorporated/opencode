# 実CLIからのローカル発火検査

`native-cli.ts` は、インストール済みOpenCode、実ランチャー、指定したguardrails profile、配備済みAIDD 2系プラグインとPython判定器を通す検査である。プラグインのctxや判定関数を直接呼ぶ単体テストとは別に、ツール実行の入口と台帳への到達を確認する。

`packages/guardrails` から実行する。

```sh
bun run smoke/native-cli.ts
```

既定値は現在のユーザーの `~/.local/bin/opencode`、`~/.opencode-2/pkg/node_modules/.bin/opencode`、`~/.config/opencode/plugins/aidd-cc-v2`、`~/.claude/hooks/lib/aidd_cc.py`。別の配備先は `--launcher`、`--cli`、`--aidd-plugin`、`--aidd-oracle` で指定する。検証対象のprofileは `--profile /path/to/packages/guardrails/profile`、guardrailsランチャーは `--guard /path/to/packages/guardrails/bin/opencode-guardrails` で切り替えられるため、統合後や配備後の実物にも同じ検査を実行できる。出力先は新しい一時ディレクトリが既定で、`--out /private/tmp/任意の新規ディレクトリ` でも指定できる。既存の証跡を上書きしないよう、空でない出力先は拒否する。

モデルの応答だけをloopbackのOpenAI互換HTTPサーバーで固定する。既存の `cor-local/glm53-flash` laneを使い、外部モデルの推論や課金は発生させない。モデルカタログの取得も無効にする。実認証情報は読み込まず、loopback用の非秘密値を子プロセスにだけ渡す。

HOMEとXDG各領域、profileの写し、作業ディレクトリ、AIDD状態・台帳をすべて出力先のscratch HOMEへ置く。配備済みPython判定器と関連ソースもバイトを変えずに写し、Pythonのbytecode cacheが配備先へ書かれないようにする。設定と判定器の写しはハッシュを照合する。AIDDの無効化・変異フラグ、guardrailのadvisory化、権限の自動承認は使わない。

| 層                 | 実際の入力                                   | 必須の証跡                                                                  |
| ------------------ | -------------------------------------------- | --------------------------------------------------------------------------- |
| CLI構文・ロード    | 実ランチャーからの `run`                     | CLI終了0と後続の実発火                                                      |
| profile許可        | `echo ALLOW_SENTINEL`                        | ネイティブtool結果とAIDD post行の終了0・出力                                |
| profile拒否        | plugin所有runtime配下へのshell書込           | 実 `guardrail.block` 行と対象ファイルの不在                                 |
| H17 C-ITER         | 同じ意図的失敗テストを4回要求                | 実行回数3、4回目toolの `[H17]` エラー、`iter.repeat-without-delta` のdeny行 |
| H17 C-EVIDENCE拒否 | tool使用後にStatusを付けない最終回答         | `evidence` のdeny行と `no status declared`                                  |
| H17 C-EVIDENCE許可 | 別セッションでtool使用後に `Status: partial` | `evidence.status-partial` のallow行                                         |

失敗テストの反復はC-ITERを発火させるための負の対照で、4回の要求に固定している。CLI実行は各90秒、終了後の非同期H17判定待ちは各30秒、通常のモデル応答系列は各9要求までに制限する。

`sources.json` に、profile全ファイル（`model-policy.json` があれば含む）、plugin entry、adapter、guardrail本体、実CLI・ランチャー、指定guardとその引数・認証・ローカル接続helper、Python判定器ファミリーのSHA-256を記録する。profileと判定器の写し、および実行中の元ソースもこのmanifestと突き合わせる。`results.json` には層ごとの真偽、参照した配備先、manifestのハッシュを出力する。`requests.json` にはloopbackで受け取ったtool名・実tool結果を残す。各caseの `stdout.jsonl`、`stderr.log`、`home/guard-ledger.jsonl`、`home/project/.opencode/guardrails/events.jsonl`、`home/aidd-state` が一次証跡になる。外部の本番台帳には書かない。

全項目が満たされ、H17 unavailableが0件の場合だけ検査を成功とする。ここでのCLI終了0は、H17が回答を承認したことを意味しない。拒否caseはCLI終了0でもH17の実denyが必要である。また、この検査は本番モデルの利用権限、外部APIへの接続、既存TUIの画面状態を検証しない。
