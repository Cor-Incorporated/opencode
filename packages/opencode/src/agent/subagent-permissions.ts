import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import type { Agent } from "./agent"

/**
 * Build the `permission` ruleset for a subagent's session when it's spawned
 * via the task tool. Combines:
 *
 * 1. A permissive session baseline so subagents don't stop on interactive
 *    permission asks after the parent already chose to delegate the task.
 * 2. The parent **agent's** edit-class deny rules — Plan Mode's file-edit
 *    restriction lives on the agent ruleset, not on the session, so a
 *    subagent that only inherited the parent SESSION's permission would
 *    silently bypass it. (#26514)
 * 3. The parent **session's** deny rules as hard ceilings while dropping
 *    inherited `ask` rules that would strand the child without the parent UI.
 * 4. Default `todowrite` and `task` denies if the subagent's own ruleset
 *    doesn't already permit them.
 */
export function deriveSubagentSessionPermission(input: {
  parentSessionPermission: PermissionV1.Ruleset
  parentAgent: Agent.Info | undefined
  subagent: Agent.Info
}): PermissionV1.Ruleset {
  const canTask = input.subagent.permission.some((rule) => rule.permission === "task" && rule.action === "allow")
  const canTodo = input.subagent.permission.some((rule) => rule.permission === "todowrite" && rule.action === "allow")
  const parentAgentDenies =
    input.parentAgent?.permission.filter((rule) => rule.action === "deny" && rule.permission === "edit") ?? []
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
    ...input.parentSessionPermission.filter((rule) => rule.action === "deny"),
    ...(canTodo ? [] : [{ permission: "todowrite" as const, pattern: "*" as const, action: "deny" as const }]),
    ...(canTask ? [] : [{ permission: "task" as const, pattern: "*" as const, action: "deny" as const }]),
  ]
}
