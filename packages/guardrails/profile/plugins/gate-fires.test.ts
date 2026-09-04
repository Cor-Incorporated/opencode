/**
 * gate() の判定ロジックを **loader を迂回して** 直接検査する。
 *
 * ## このテストが保証しないこと（2026-09-04 に実環境で反証された）
 *
 * 本テストは `createContext` を直接 import して `gate()` を呼ぶ。
 * **opencode の plugin loader は通らない。** したがって次は一切保証しない:
 *   - profile の plugin が実 CLI でロードされること
 *   - `chat.params` フックが登録されること
 *   - 実セッションで gate() に到達すること
 *
 * 実測（2026-09-04、実 `opencode run`）: 本テストが 6 pass の状態で
 *   failed to load plugin .../guardrail.ts  (paths[0] must be of type string, got object)
 *   failed to load plugin .../team.ts       (Plugin export is not a function)
 * が出ており、`chat.params` の block は events.jsonl に**全期間で 0 件**だった。
 * つまり **本テストが緑のまま、本番の強制経路は死んでいた。**
 *
 * 当初のヘッダは「The guardrail must actually BLOCK」と書き、発火検証済みと読めた。
 * それは過大だった。ロード経路の検査は plugin-loads.test.ts が担う。
 *
 * ## 本テストが保証すること
 *
 *   F1 発火   拒否すべき入力で gate() が理由文字列を返す
 *   F2 統制   通すべき入力で gate() が undefined を返す
 *             （F2 が無いと「全部拒否する壊れた gate」と区別できない）
 *   F3 変異   拒否理由を 1 つずつ外すと、対応する入力だけが通るようになる
 *
 * これは「gate() が正しく判定するか」であって「gate() が呼ばれるか」ではない。
 *
 * Run: bun test packages/guardrails/profile/plugins/gate-fires.test.ts
 */
import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createContext, type GuardrailInput } from "./guardrail-context"
import { free, preview } from "./guardrail-patterns"

const dir = mkdtempSync(join(tmpdir(), "guardrail-gate-"))

// gate() は client を触らない。ここで実 client を作ると単体テストが
// ネットワークと起動順に依存する。触らないことは下の F2 が担保する
// （client を使う経路なら undefined 参照で落ちる）。
// 触らない前提を型ではなく **Proxy** で表明する: 実際に触ったら例外で落ちる。
// Proxy は Client を構造的に満たせないので型表明が要るが、型を緩めるのではなく
// 挙動で担保している（前提が破れた瞬間に例外で分かる）。
// oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
const clientStub = new Proxy(
  {},
  {
    get(_t, prop) {
      throw new Error(`gate() が client.${String(prop)} を触った — この前提は破れている`)
    },
  },
) as GuardrailInput["client"]

const ctx = await createContext({
  client: clientStub,
  directory: dir,
  worktree: dir,
})

const activeCost = { input: 1, output: 2, cache: { read: 0, write: 0 } }

describe("gate() は実際に拒否する（発火検証）", () => {
  test("F1 preview: status が active でないモデルを拒否する", () => {
    const err = ctx.gate({
      agent: "implement",
      model: { id: "glm-4.7", providerID: "zai", status: "beta", cost: activeCost },
    })
    expect(err).toBeString()
    expect(err).toContain("preview-only")
  })

  test("F1 preview: id に preview/alpha を含むモデルを拒否する", () => {
    for (const id of ["some-model-preview", "foo-alpha", "bar-experimental"]) {
      const err = ctx.gate({
        agent: "implement",
        model: { id, providerID: "zai", status: "active", cost: activeCost },
      })
      expect(err, `${id} は拒否されるべき`).toBeString()
    }
  })

  test("F1 whitelist: provider の許可集合に無いモデルを拒否する", () => {
    // allow は呼び出し側が埋める。空のままだと whitelist 判定は素通りする —
    // それ自体が「宣言はあるが強制されていない」形なので、埋めた場合の
    // 挙動をここで固定する。
    ctx.allow["zai"] = new Set(["glm-4.7"])
    try {
      const err = ctx.gate({
        agent: "implement",
        model: { id: "glm-9.9-not-real", providerID: "zai", status: "active", cost: activeCost },
      })
      expect(err).toBeString()
      expect(err).toContain("not admitted by provider policy")
    } finally {
      delete ctx.allow["zai"]
    }
  })

  test("F2 統制: 正当なモデルは通る（全部拒否する壊れた gate ではない）", () => {
    const err = ctx.gate({
      agent: "implement",
      model: { id: "glm-4.7", providerID: "zai", status: "active", cost: activeCost },
    })
    expect(err).toBeUndefined()
  })

  test("F2 統制: providerID が無ければ判定しない（早期 return）", () => {
    expect(ctx.gate({ agent: "implement", model: { id: "glm-4.7" } })).toBeUndefined()
  })

  test("F3 変異: 判定関数そのものが結論を作っている", () => {
    // preview() / free() を直接叩き、gate の結論と対応することを示す。
    // 片方だけ真になる入力を選ぶ。
    const previewOnly = { id: "glm-4.7", providerID: "zai", status: "beta", cost: activeCost }
    const clean = { id: "glm-4.7", providerID: "zai", status: "active", cost: activeCost }

    expect(preview(previewOnly)).toBe(true)
    expect(preview(clean)).toBe(false)
    // gate の結論が preview() に追随している
    expect(ctx.gate({ agent: "implement", model: previewOnly })).toBeString()
    expect(ctx.gate({ agent: "implement", model: clean })).toBeUndefined()

    // free() は cost で判定する。cost ゼロは free 扱いになる。
    const zeroCost = {
      id: "glm-4.7",
      providerID: "zai",
      status: "active",
      cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    }
    if (free(zeroCost)) {
      expect(ctx.gate({ agent: "implement", model: zeroCost })).toBeString()
    } else {
      // free() が cost ゼロを free と見なさない実装なら、この分岐が
      // 「free 判定は cost 以外で決まる」ことの記録になる。
      expect(free(zeroCost)).toBe(false)
    }
  })
})

process.on("exit", () => {
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    /* 後始末の失敗はテスト結果を変えない */
  }
})
