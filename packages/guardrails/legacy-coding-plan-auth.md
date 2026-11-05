# Coding Plan の旧認証ストア連携

`bin/opencode-guardrails` は、旧 `auth.json` に保存された
`zai-coding-plan` の API キーだけを、未設定の `ZHIPU_API_KEY` へ引き継ぎます。
`zai` に保存された Standard API 専用キーは引き継ぎません。
両方のキーがあっても Coding Plan のキーを選び、Coding Plan の登録が不正な場合も
Standard のキーへ切り替えません。

Z.ai の Standard と Personal Coding Plan はキーの管理区分が異なります。
接続先が Coding Plan 用でも、Standard 専用キーでは `1113` になることがあります。
残量 API の成功やモデル一覧への表示だけでは、推論が成功する証拠になりません。
契約で利用できるモデルを選び、実応答まで確認してください。

この連携は旧ストアとの互換処理です。明示された `ZHIPU_API_KEY` を変更せず、
旧 `OPENCODE_AUTH_CONTENT` のファイルに対する優先順も維持します。
OpenCode 2 系の保存済み認証は CLI 自身が選択するため、active な保存済み認証が
環境変数より優先されます。この helper は 2 系の DB を読み書きしません。

検証は `packages/guardrails` で
`bun test profile/src/zai-auth-bin-defaults.test.ts` を実行します。
実ランチャーから起動するオフライン child に、Standard キーが渡らないことも確認します。
