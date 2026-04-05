import z from "zod"

export const HOOK_EVENTS = ["PreToolUse", "PostToolUse", "SessionStart", "Notification"] as const
export type HookEvent = (typeof HOOK_EVENTS)[number]

export const HookEntry = z.object({
  command: z.string().describe("Shell command or path to script"),
  matcher: z.string().optional().describe("Tool name glob pattern (PreToolUse/PostToolUse only)"),
  timeout: z.number().int().positive().optional().describe("Timeout in ms (default: 10000)"),
})
export type HookEntry = z.infer<typeof HookEntry>

const hookEntryArray = z.array(HookEntry)

export const HookConfig = z
  .object({
    PreToolUse: hookEntryArray,
    PostToolUse: hookEntryArray,
    SessionStart: hookEntryArray,
    Notification: hookEntryArray,
  })
  .strict()
  .partial()
  .optional()
  .describe("Shell script hooks for lifecycle events")
export type HookConfig = z.infer<typeof HookConfig>
