/**
 * profile の plugin が **opencode の loader を通るか** を検査する。
 *
 * ## 起点（2026-09-04、実 `opencode run` で反証）
 *
 * gate-fires.test.ts が 6 pass の状態で、実 CLI は
 *   failed to load plugin .../guardrail.ts  (The "paths[0]" property must be of type string, got object)
 *   failed to load plugin .../team.ts       (Plugin export is not a function)
 * を出し、`chat.params` の block は events.jsonl に**全期間で 0 件**だった。
 * gate() の単体テストが緑でも、**gate() に到達する経路が死んでいれば強制は無い。**
 *
 * ## なぜ loader を直接 import せず判定を複製するか
 *
 * loader 本体（packages/opencode/src/plugin/shared.ts の readV1Plugin と
 * packages/opencode/src/plugin/index.ts の getLegacyPlugins）は `@/util/*` と
 * `@opencode-ai/core/npm` に依存し、guardrails の bun test からは解決できない。
 * そこで判定だけを忠実に複製し、**複製がソースからずれたら落ちる pair 検査**を付ける
 * （ソースの決定的な 2 条件を文字列で照合する）。複製だけだと「テストは緑だが loader は
 * 変わっていた」を通してしまう。
 *
 * ## 軸
 *   F1 v1 判定    default が object で server() を持つ → loader は named export に触れない
 *   F2 legacy 経路 default が関数の module（修正前の形）は legacy に落ち、named export を
 *                  server(input) で呼んで throw する — これが修正前の red の再現
 *   F3 到達性      server(stubInput) が返す hooks に "chat.params" がある
 *   PAIR           複製した判定条件がソースに実在する
 *
 * Run: bun test packages/guardrails/profile/plugins/plugin-loads.test.ts
 */
import { describe, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import * as guardrailMod from "./guardrail"
import * as teamMod from "./team"

// ---- loader の判定を複製（packages/opencode/src/plugin/{shared,index}.ts） ----
type Mod = Record<string, unknown>
type ServerFn = (input: unknown, opts?: unknown) => Promise<unknown>
type V1 = { id?: unknown; server: ServerFn }

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object"
const isServerFn = (v: unknown): v is ServerFn => typeof v === "function"
const isV1 = (v: unknown): v is V1 => isRecord(v) && isServerFn(v.server)

/** shared.ts readV1Plugin(mod, spec, "server", "detect") の判定部 */
function readV1PluginDetect(mod: Mod): V1 | undefined {
  const value = mod.default
  if (!isRecord(value)) return undefined
  if (!("id" in value) && !("server" in value) && !("tui" in value)) return undefined
  if ("server" in value && value.server !== undefined && !isServerFn(value.server)) {
    throw new TypeError("invalid server export")
  }
  if (!isV1(value)) throw new TypeError("must default export an object with server()")
  return value
}

/** index.ts getServerPlugin / getLegacyPlugins の判定部 */
function getLegacyPlugins(mod: Mod): ServerFn[] {
  const seen = new Set<unknown>()
  const out: ServerFn[] = []
  for (const entry of Object.values(mod)) {
    if (seen.has(entry)) continue
    seen.add(entry)
    if (isServerFn(entry)) {
      out.push(entry)
      continue
    }
    if (isRecord(entry) && isServerFn(entry.server)) {
      out.push(entry.server)
      continue
    }
    throw new TypeError("Plugin export is not a function")
  }
  return out
}

/** index.ts applyPlugin: v1 があればそれだけ、無ければ legacy で全 export を呼ぶ */
async function applyPluginLike(mod: Mod, input: unknown): Promise<unknown[]> {
  const v1 = readV1PluginDetect(mod)
  // Promise.resolve で包む: 型ガード越しの戻り値を oxlint が thenable と確定できないため。
  // 実体は async 関数なので挙動は同じ。
  if (v1) return [await Promise.resolve(v1.server(input, {}))]
  const hooks: unknown[] = []
  for (const server of getLegacyPlugins(mod)) hooks.push(await Promise.resolve(server(input, {})))
  return hooks
}

// ---- loader が実際に渡す入力に近い stub（client は触ったら落ちる Proxy） ----
const dir = process.cwd()
const stubInput = {
  client: new Proxy(
    {},
    {
      get(_t, p) {
        throw new Error(`plugin touched client.${String(p)} at load`)
      },
    },
  ),
  project: { id: "test" },
  directory: dir,
  worktree: dir,
  serverUrl: new URL("http://localhost:0"),
  experimental_workspace: { register() {} },
  $: undefined,
}

describe("profile plugin は opencode の loader を通る", () => {
  test("F1 guardrail: default は object で server() を持つ（v1 として認識される）", () => {
    const v1 = readV1PluginDetect(guardrailMod)
    expect(v1).toBeDefined()
    expect(v1?.id).toBe("aidd-guardrail")
  })

  test("F1 team: default は object で server() を持つ", () => {
    const v1 = readV1PluginDetect(teamMod)
    expect(v1).toBeDefined()
    expect(v1?.id).toBe("aidd-team")
  })

  test("F2 legacy 経路の再現: default が関数だと named export が server(input) で呼ばれて落ちる", async () => {
    // 修正前の guardrail.ts と同じ形を合成する: default は関数、named export に
    // 「string を要求する補助関数」がある。loader はこれを plugin と誤認して input を渡す。
    const legacyShaped: Mod = {
      default: async () => ({}),
      ensureLocalOpencodeIgnored: async (worktree: string) => join(worktree, ".gitignore"),
    }
    expect(readV1PluginDetect(legacyShaped)).toBeUndefined() // v1 とは認識されない
    // bun test は返した Promise を待つ。await にすると oxlint が expect(...).rejects を
    // thenable と確定できず await-thenable を出すので return にする。
    return expect(applyPluginLike(legacyShaped, stubInput)).rejects.toThrow(/paths\[0\]|must be of type string/)
  })

  test("F2 legacy 経路の再現: 非関数の named export は 'Plugin export is not a function'", () => {
    const legacyShaped: Mod = { default: async () => ({}), DEFAULT_TIMEOUT_MS: 1000 }
    expect(() => getLegacyPlugins(legacyShaped)).toThrow("Plugin export is not a function")
  })

  test("F3 到達性: guardrail.server(input) が返す hooks に chat.params がある", async () => {
    const [hooks] = await applyPluginLike(guardrailMod, stubInput)
    expect(isRecord(hooks)).toBe(true)
    if (!isRecord(hooks)) return
    expect(typeof hooks["chat.params"]).toBe("function")
    expect(typeof hooks["tool.execute.before"]).toBe("function")
  })

  test("F3 統制: 現行の guardrail は named export を持つが、v1 なので loader はそれを呼ばない", async () => {
    // named export が残っていること自体は正しい（他の用途がある）。
    // v1 判定が効いていれば applyPluginLike は default.server だけを呼び、例外は出ない。
    const named = Object.keys(guardrailMod).filter((k) => k !== "default")
    expect(named.length).toBeGreaterThan(0)
    return expect(applyPluginLike(guardrailMod, stubInput)).resolves.toBeDefined()
  })
})

describe("PAIR: 複製した loader 判定がソースに実在する（ずれたら落ちる）", () => {
  const root = join(import.meta.dir, "..", "..", "..", "opencode", "src", "plugin")
  const shared = join(root, "shared.ts")
  const index = join(root, "index.ts")

  test("loader のソースが解決できる（無ければ pair は成立しない）", () => {
    expect(existsSync(shared)).toBe(true)
    expect(existsSync(index)).toBe(true)
  })

  test("readV1Plugin: detect モードは id/server/tui の無い default を無視する", () => {
    const src = readFileSync(shared, "utf-8")
    expect(src).toContain(`if (mode === "detect" && !("id" in value) && !("server" in value) && !("tui" in value)) return`)
  })

  test("getLegacyPlugins: 全 export を走査し、非関数なら throw する", () => {
    const src = readFileSync(index, "utf-8")
    expect(src).toContain("for (const entry of Object.values(mod))")
    expect(src).toContain(`throw new TypeError("Plugin export is not a function")`)
  })
})
