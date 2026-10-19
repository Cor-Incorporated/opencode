// 2.x entry for the team plugin (`team`, `background`, `team_status` tools + worker-session hygiene). Listed in
// profile/opencode.json as `"plugins": ["./plugins/team"]`. The 1.x factory (`../../src/team` → `{ id, server }`) is
// reused through the adapter; its SDK calls go through the 1.x-shaped client shim (src/v2/client.ts).
import team from "../../src/team"
import { bridge, v1Input } from "../../src/v2/adapter"

export default {
  id: team.id,
  setup: async (ctx: any) => {
    const input = v1Input(ctx)
    const hooks = await team.server(input)
    return bridge(ctx, hooks, { input })
  },
}
