import path from "path"

export default async (input: { directory: string }) => ({
  "tool.execute.error": async (
    meta: { tool: string },
    out: { error: unknown },
  ) => {
    const message = out.error instanceof Error ? out.error.message : String(out.error)
    await Bun.write(
      path.join(input.directory, "tool-error.json"),
      JSON.stringify({ tool: meta.tool, message }),
    )
  },
})
