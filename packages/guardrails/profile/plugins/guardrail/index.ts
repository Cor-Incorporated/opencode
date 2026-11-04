// 2.x entry for the guardrail plugin. Listed in profile/opencode.json as `"plugins": ["./plugins/guardrail"]`;
// 2.x resolves a plugin directory to `<dir>/index.ts` and expects `export default { id, setup }`.
// The 1.x factory (`../../src/guardrail` → `{ id, server }`) is reused as-is through the adapter. Only directories
// live under profile/plugins: 2.x auto-discovers every top-level *.ts there as a plugin, so the 1.x sources sit in src/.
import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import guardrail from "../../src/guardrail"
import { bridge, v1Input } from "../../src/v2/adapter"

/** Admission data belongs to the plugin; the CLI only reads native providers from opencode.json. */
export function profileConfig(dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..")): unknown {
  const policy: unknown = JSON.parse(readFileSync(path.join(dir, "model-policy.json"), "utf8"))
  if (typeof policy !== "object" || policy === null || !("provider" in policy))
    throw new Error("Invalid guardrail model policy")
  const providers = policy.provider
  if (typeof providers !== "object" || providers === null || Array.isArray(providers) || !Object.keys(providers).length)
    throw new Error("Invalid guardrail model policy")
  const runtime: unknown = JSON.parse(readFileSync(path.join(dir, "opencode.json"), "utf8"))
  if (typeof runtime !== "object" || runtime === null || !("providers" in runtime))
    throw new Error("Invalid guardrail model policy coverage")
  const configured = runtime.providers
  if (typeof configured !== "object" || configured === null || Array.isArray(configured))
    throw new Error("Invalid guardrail model policy coverage")
  // An absent allowlist would otherwise leave this admitted provider unrestricted in the request gate.
  if (Object.keys(configured).some((id) => !Object.hasOwn(providers, id)))
    throw new Error("Invalid guardrail model policy coverage")
  for (const value of Object.values(providers)) {
    if (typeof value !== "object" || value === null || !("whitelist" in value) || !Array.isArray(value.whitelist))
      throw new Error("Invalid guardrail model policy")
    if (!value.whitelist.length || !value.whitelist.every((id: unknown) => typeof id === "string" && id.length > 0))
      throw new Error("Invalid guardrail model policy")
  }
  return policy
}

/** A failed setup can be unloaded by the host. Keep this plugin active and deny model requests instead. */
export function admissionConfig(dir?: string): unknown {
  try {
    return profileConfig(dir)
  } catch {
    return { policyError: "Guardrail model policy unavailable; restore model-policy.json before making model requests" }
  }
}

export default {
  id: guardrail.id,
  setup: async (ctx: any) => {
    const input = v1Input(ctx)
    const hooks = await guardrail.server(input, ctx?.options)
    return bridge(ctx, hooks, { input, config: admissionConfig() })
  },
}
