import { Bus } from "@/bus"
import { Config } from "@/config/config"
import { Log } from "@/util/log"
import { MemoryStore } from "./store"
import type { Memory } from "./types"
import { Instance } from "@/project/instance"

const log = Log.create({ service: "memory.extractor" })

type SessionState = {
  commands: Map<string, number>
  errors: string[]
  fixes: string[]
  configChanges: string[]
  lastFlush: number
  pending: Memory.Create[]
}

const FLUSH_INTERVAL = 3000
const COMMAND_THRESHOLD = 3

export namespace MemoryExtractor {
  const sessions = new Map<string, SessionState>()

  function getState(sessionID: string): SessionState {
    const existing = sessions.get(sessionID)
    if (existing) return existing
    const state: SessionState = {
      commands: new Map(),
      errors: [],
      fixes: [],
      configChanges: [],
      lastFlush: Date.now(),
      pending: [],
    }
    sessions.set(sessionID, state)
    return state
  }

  export function trackCommand(sessionID: string, command: string) {
    const state = getState(sessionID)
    const count = (state.commands.get(command) ?? 0) + 1
    state.commands.set(command, count)
    if (count === COMMAND_THRESHOLD) {
      state.pending.push({
        projectPath: Instance.directory,
        topic: `Frequently used command: ${command}`,
        type: "build-command",
        content: `Command \`${command}\` has been used ${count}+ times in this session.`,
        sessionID,
      })
      maybeFlush(sessionID)
    }
  }

  export function trackError(sessionID: string, error: string) {
    const state = getState(sessionID)
    state.errors.push(error)
  }

  export function trackFix(sessionID: string, fix: string) {
    const state = getState(sessionID)
    state.fixes.push(fix)
    if (state.errors.length > 0) {
      const lastError = state.errors[state.errors.length - 1]
      state.pending.push({
        projectPath: Instance.directory,
        topic: `Error pattern and fix: ${lastError.slice(0, 50)}`,
        type: "error-solution",
        content: `**Error:** ${lastError}\n**Fix:** ${fix}`,
        sessionID,
      })
      state.errors = []
      maybeFlush(sessionID)
    }
  }

  export function trackPreference(sessionID: string, preference: string) {
    const state = getState(sessionID)
    state.pending.push({
      projectPath: Instance.directory,
      topic: `User preference: ${preference.slice(0, 50)}`,
      type: "preference",
      content: preference,
      sessionID,
    })
    maybeFlush(sessionID)
  }

  export function trackConfigChange(sessionID: string, file: string, change: string) {
    const state = getState(sessionID)
    state.configChanges.push(`${file}: ${change}`)
    state.pending.push({
      projectPath: Instance.directory,
      topic: `Config file modification: ${file}`,
      type: "config-pattern",
      content: `Config file \`${file}\` was modified: ${change}`,
      sessionID,
    })
    maybeFlush(sessionID)
  }

  function maybeFlush(sessionID: string) {
    const state = getState(sessionID)
    if (Date.now() - state.lastFlush < FLUSH_INTERVAL) return
    flush(sessionID)
  }

  export async function flush(sessionID: string) {
    const state = sessions.get(sessionID)
    if (!state || state.pending.length === 0) return
    const batch = [...state.pending]
    state.pending = []
    state.lastFlush = Date.now()

    for (const entry of batch) {
      await MemoryStore.runPromise((svc) => svc.create(entry)).catch((err) => {
        log.warn("failed to flush memory entry", { error: err, topic: entry.topic })
      })
    }
    log.info("flushed memory entries", { sessionID, count: batch.length })
  }

  export async function cleanup(sessionID: string) {
    await flush(sessionID).catch((err) => {
      log.warn("failed to flush on cleanup", { error: err })
    })
    sessions.delete(sessionID)
  }
}
