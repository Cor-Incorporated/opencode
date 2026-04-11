import z from "zod"

export const HOOK_EVENTS = [
  "PreToolUse", "PostToolUse", "SessionStart", "Notification",
  "SessionEnd", "PreCompact", "PostCompact",
] as const
export type HookEvent = (typeof HOOK_EVENTS)[number]

export const HookEntry = z.object({
  type: z.enum(["command", "prompt"]).optional().describe("Handler type: command (shell script, default) or prompt (template injection)"),
  command: z.string().min(1).optional().describe("Shell command or path to script (required when type is 'command' or omitted)"),
  prompt: z.string().min(1).optional().describe("Template text to inject as hook context (required when type is 'prompt'). Supports {{TOOL_NAME}} and {{TOOL_INPUT}} placeholders"),
  matcher: z.string().optional().describe("Tool name glob pattern (PreToolUse/PostToolUse only)"),
  timeout: z.number().int().positive().optional().describe("Timeout in ms (default: 10000)"),
}).refine(
  (entry) => {
    if (entry.type === "prompt") return !!entry.prompt
    return !!entry.command // type "command" or undefined both require command
  },
  { message: "command required when type is 'command' (default), prompt required when type is 'prompt'" },
)
export type HookEntry = z.infer<typeof HookEntry>

const hookEntryArray = z.array(HookEntry)

export const HookConfig = z
  .object({
    PreToolUse: hookEntryArray,
    PostToolUse: hookEntryArray,
    SessionStart: hookEntryArray,
    Notification: hookEntryArray,
    SessionEnd: hookEntryArray,
    PreCompact: hookEntryArray,
    PostCompact: hookEntryArray,
  })
  .strict()
  .partial()
  .optional()
  .describe("Lifecycle event hooks (shell scripts or prompt templates)")
export type HookConfig = z.infer<typeof HookConfig>
