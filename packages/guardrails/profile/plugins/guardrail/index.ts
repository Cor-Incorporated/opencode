// 2.x entry for the guardrail plugin. Listed in profile/opencode.json as `"plugins": ["./plugins/guardrail"]`;
// 2.x resolves a plugin directory to `<dir>/index.ts` and expects `export default { id, setup }`.
// The 1.x factory (`../../src/guardrail` → `{ id, server }`) is reused as-is through the adapter. Only directories
// live under profile/plugins: 2.x auto-discovers every top-level *.ts there as a plugin, so the 1.x sources sit in src/.
import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import guardrail from "../../src/guardrail"
import { bridge, v1Input } from "../../src/v2/adapter"

/** profile/opencode.json: the 1.x `config` hook read the provider whitelists from the loaded config. */
export function profileConfig(dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..")): unknown {
  try {
    return JSON.parse(readFileSync(path.join(dir, "opencode.json"), "utf8"))
  } catch {
    return undefined
  }
}

export default {
  id: guardrail.id,
  setup: async (ctx: any) => {
    const input = v1Input(ctx)
    const hooks = await guardrail.server(input, ctx?.options)
    await bridge(ctx, hooks, { input, config: profileConfig() })
  },
}
