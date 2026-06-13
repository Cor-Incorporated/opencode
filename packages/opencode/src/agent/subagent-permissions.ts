import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import type { Agent } from "./agent"

/**
 * Build the `permission` ruleset for a subagent session spawned by the task tool.
 *
 * The child gets a non-interactive worker baseline, but parent agent/session
 * denies stay hard ceilings so delegation cannot bypass Plan Mode or runtime
 * deny rules.
 */
export function deriveSubagentSessionPermission(input: {
  parentSessionPermission: PermissionV1.Ruleset
  parentAgent?: Agent.Info
  subagent: Agent.Info
}): PermissionV1.Ruleset {
  const canTask = input.subagent.permission.some((rule) => rule.permission === "task" && rule.action === "allow")
  const canTodo = input.subagent.permission.some((rule) => rule.permission === "todowrite" && rule.action === "allow")
  const parentAgentDenies = input.parentAgent?.permission.filter((rule) => rule.action === "deny") ?? []
  const parentSessionInherited = input.parentSessionPermission.filter(
    (rule) => rule.action === "deny" || (rule.permission === "external_directory" && rule.action === "allow"),
  )
  return [
    { permission: "*" as const, pattern: "*" as const, action: "allow" as const },
    { permission: "edit" as const, pattern: "*" as const, action: "allow" as const },
    { permission: "external_directory" as const, pattern: "*" as const, action: "allow" as const },
    { permission: "bash" as const, pattern: "*" as const, action: "allow" as const },
    { permission: "read" as const, pattern: "*" as const, action: "allow" as const },
    { permission: "glob" as const, pattern: "*" as const, action: "allow" as const },
    { permission: "grep" as const, pattern: "*" as const, action: "allow" as const },
    { permission: "list" as const, pattern: "*" as const, action: "allow" as const },
    { permission: "webfetch" as const, pattern: "*" as const, action: "allow" as const },
    { permission: "websearch" as const, pattern: "*" as const, action: "allow" as const },
    { permission: "repo_clone" as const, pattern: "*" as const, action: "allow" as const },
    { permission: "repo_overview" as const, pattern: "*" as const, action: "allow" as const },
    { permission: "lsp_diagnostics" as const, pattern: "*" as const, action: "allow" as const },
    { permission: "lsp_hover" as const, pattern: "*" as const, action: "allow" as const },
    { permission: "workflow_tool_approval" as const, pattern: "*" as const, action: "allow" as const },
    { permission: "doom_loop" as const, pattern: "*" as const, action: "allow" as const },
    ...parentAgentDenies,
    ...input.subagent.permission.filter((rule) => rule.permission === "todowrite" || rule.permission === "task"),
    ...parentSessionInherited,
    ...(canTodo ? [] : [{ permission: "todowrite" as const, pattern: "*" as const, action: "deny" as const }]),
    ...(canTask ? [] : [{ permission: "task" as const, pattern: "*" as const, action: "deny" as const }]),
  ]
}
