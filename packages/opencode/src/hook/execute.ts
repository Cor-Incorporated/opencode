import { Log } from "../util/log"
import { Process } from "../util/process"
import type { HookEntry } from "./schema"

const log = Log.create({ service: "hook" })
const DEFAULT_TIMEOUT = 10_000

export interface HookEnv {
  OPENCODE_HOOK_EVENT: string
  OPENCODE_TOOL_NAME?: string
  OPENCODE_TOOL_INPUT?: string
  OPENCODE_PROJECT_DIR: string
  OPENCODE_SESSION_ID: string
}

export interface HookResult {
  action: "pass" | "block"
  message?: string
}

export async function runHook(entry: HookEntry, env: HookEnv): Promise<HookResult> {
  const timeout = entry.timeout ?? DEFAULT_TIMEOUT
  const command = entry.command.replace(/^~/, process.env.HOME ?? "~")

  try {
    const result = await Process.run(["sh", "-c", command], {
      env: toEnvRecord(env),
      abort: AbortSignal.timeout(timeout),
      nothrow: true,
    })

    const stderr = result.stderr.toString().trim()

    if (result.code === 0) {
      return { action: "pass", message: stderr || undefined }
    }
    if (result.code === 2) {
      return { action: "block", message: stderr || "Blocked by hook" }
    }

    log.warn("hook exited with unexpected code", {
      command: entry.command,
      code: result.code,
      stderr,
    })
    return { action: "pass" }
  } catch (error) {
    log.warn("hook execution failed", {
      command: entry.command,
      error: error instanceof Error ? error.message : String(error),
    })
    return { action: "pass" }
  }
}

function toEnvRecord(env: HookEnv): Record<string, string> {
  const record: Record<string, string> = {
    OPENCODE_HOOK_EVENT: env.OPENCODE_HOOK_EVENT,
    OPENCODE_PROJECT_DIR: env.OPENCODE_PROJECT_DIR,
    OPENCODE_SESSION_ID: env.OPENCODE_SESSION_ID,
  }
  if (env.OPENCODE_TOOL_NAME !== undefined) record.OPENCODE_TOOL_NAME = env.OPENCODE_TOOL_NAME
  if (env.OPENCODE_TOOL_INPUT !== undefined) record.OPENCODE_TOOL_INPUT = env.OPENCODE_TOOL_INPUT
  return record
}

export function matchesTool(matcher: string | undefined, toolName: string): boolean {
  if (!matcher) return true
  if (matcher === toolName) return true
  if (matcher.endsWith("*")) {
    return toolName.startsWith(matcher.slice(0, -1))
  }
  return false
}

export async function runHooks(
  entries: HookEntry[] | undefined,
  toolName: string,
  env: HookEnv,
): Promise<HookResult> {
  if (!entries || entries.length === 0) return { action: "pass" }

  const messages: string[] = []

  for (const entry of entries) {
    if (!matchesTool(entry.matcher, toolName)) continue

    const result = await runHook(entry, env)
    if (result.message) messages.push(result.message)
    if (result.action === "block") {
      return { action: "block", message: messages.join("\n") }
    }
  }

  return {
    action: "pass",
    message: messages.length > 0 ? messages.join("\n") : undefined,
  }
}
