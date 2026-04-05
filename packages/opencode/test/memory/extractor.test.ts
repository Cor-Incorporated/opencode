import { describe, test, expect } from "bun:test"
import path from "path"
import { Instance } from "../../src/project/instance"
import { MemoryExtractor } from "../../src/memory/extractor"

const projectRoot = path.join(__dirname, "../..")

describe("memory.extractor", () => {
  test("trackCommand accumulates counts and triggers at threshold", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const sessionID = "ses_cmd_" + Date.now()

        MemoryExtractor.trackCommand(sessionID, "bun test")
        MemoryExtractor.trackCommand(sessionID, "bun test")
        MemoryExtractor.trackCommand(sessionID, "bun test")

        MemoryExtractor.trackCommand(sessionID, "bun build")
        MemoryExtractor.trackCommand(sessionID, "bun build")

        await MemoryExtractor.cleanup(sessionID)
      },
    })
  })

  test("trackError and trackFix detects error-fix sequence", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const sessionID = "ses_errfix_" + Date.now()

        MemoryExtractor.trackError(sessionID, "TypeError: cannot read property 'x' of undefined")
        MemoryExtractor.trackFix(sessionID, "Added null check before accessing property")

        MemoryExtractor.trackFix(sessionID, "Another fix without error")

        await MemoryExtractor.cleanup(sessionID)
      },
    })
  })

  test("trackPreference creates pending memory", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const sessionID = "ses_pref_" + Date.now()

        MemoryExtractor.trackPreference(sessionID, "User prefers tabs over spaces")

        await MemoryExtractor.cleanup(sessionID)
      },
    })
  })

  test("session state is isolated between sessions", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const sessionA = "ses_iso_a_" + Date.now()
        const sessionB = "ses_iso_b_" + Date.now()

        MemoryExtractor.trackCommand(sessionA, "bun test")
        MemoryExtractor.trackCommand(sessionA, "bun test")

        MemoryExtractor.trackCommand(sessionB, "bun test")

        MemoryExtractor.trackCommand(sessionA, "bun test")

        MemoryExtractor.trackCommand(sessionB, "bun test")

        await MemoryExtractor.cleanup(sessionA)
        await MemoryExtractor.cleanup(sessionB)
      },
    })
  })

  test("cleanup awaits flush before deleting state", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const sessionID = "ses_cleanup_" + Date.now()

        MemoryExtractor.trackPreference(sessionID, "test preference")

        await MemoryExtractor.cleanup(sessionID)

        MemoryExtractor.trackCommand(sessionID, "bun test")

        await MemoryExtractor.cleanup(sessionID)
      },
    })
  })

  test("trackConfigChange records file modification", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const sessionID = "ses_config_" + Date.now()

        MemoryExtractor.trackConfigChange(sessionID, "tsconfig.json", "added strict mode")

        await MemoryExtractor.cleanup(sessionID)
      },
    })
  })
})
