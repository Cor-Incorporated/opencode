import { Config } from "@/config/config"
import { Log } from "@/util/log"
import { MemoryFile } from "./file"

const log = Log.create({ service: "memory.injector" })

// NOTE: beast.txt (used for GPT-4/o1/o3 system prompts) references
// `.github/instructions/memory.instruction.md` as the memory file path.
// Our injector uses `.opencode/memory/MEMORY.md` which is correct for the
// OpenCode memory system. The beast.txt path is an upstream convention and
// should NOT be changed here.
export namespace MemoryInjector {
  export async function load(): Promise<string | undefined> {
    const config = await Config.get()
    if (config.memory?.enabled === false) return undefined

    const maxLines = config.memory?.max_memory_lines ?? 200
    const content = await MemoryFile.readIndex(maxLines).catch((err) => {
      log.warn("failed to read MEMORY.md", { error: err })
      return undefined
    })

    if (!content || !content.trim()) return undefined

    return [
      "# Memory",
      "The following memory entries were loaded from MEMORY.md in the project directory.",
      "These represent learned patterns, preferences, and context from previous sessions.",
      "",
      content,
    ].join("\n")
  }
}
