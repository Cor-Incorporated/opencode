import { appendFile } from "fs/promises"
import type { Plugin } from "@opencode-ai/plugin"

const mode = process.env.GUARDRAIL_MODE ?? "strict"
const deny = [
  ".env",
  ".env.",
  "/.ssh/",
  "/.aws/credentials",
  "/credentials",
  "id_rsa",
  "id_ed25519",
  ".pem",
  ".key",
  ".p12",
  ".pfx",
  ".cer",
  ".crt",
  ".der",
  ".kdbx",
]

function norm(input: string) {
  return input.replaceAll("\\", "/").toLowerCase()
}

function pick(tool: string, args: Record<string, unknown>) {
  if (tool === "read" || tool === "edit" || tool === "write") {
    return typeof args.filePath === "string" ? [args.filePath] : []
  }

  if (tool === "list") {
    return typeof args.path === "string" ? [args.path] : []
  }

  if (tool === "glob") {
    return [args.path, args.pattern].filter((item): item is string => typeof item === "string")
  }

  if (tool === "grep") {
    return typeof args.path === "string" ? [args.path] : []
  }

  return []
}

function hit(tool: string, args: Record<string, unknown>) {
  const vals = pick(tool, args).map(norm)
  return vals.find((item) => deny.some((part) => item.includes(part)))
}

function note(event: string, data: unknown) {
  const file = process.env.GUARDRAIL_LOG_FILE
  if (!file) return Promise.resolve()
  const line = JSON.stringify({ time: Date.now(), event, data }) + "\n"
  return appendFile(file, line).catch(() => undefined)
}

const plugin: Plugin = async () => ({
  event: async ({ event }) => {
    if (event.type !== "session.created" && event.type !== "permission.asked" && event.type !== "permission.replied") {
      return
    }
    await note(event.type, event.properties)
  },
  "shell.env": async (_input, output) => {
    output.env.GUARDRAIL_MODE = mode
  },
  "tool.execute.before": async (input, output) => {
    const bad = hit(input.tool, output.args as Record<string, unknown>)
    if (!bad) return
    throw new Error(`guardrail blocked ${input.tool} access to sensitive path: ${bad}`)
  },
  "experimental.session.compacting": async (_input, output) => {
    output.context.push("Preserve guardrail approvals, denials, and policy mode before compaction.")
  },
})

export default plugin
