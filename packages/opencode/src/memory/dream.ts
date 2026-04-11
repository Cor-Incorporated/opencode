import path from "path"
import { Log } from "@/util/log"
import { MemoryStore } from "./store"
import { MemoryPromoter } from "./promoter"
import { MemoryMaintenance } from "./maintenance"

const log = Log.create({ service: "memory.dream" })

const META_FILENAME = ".dream-meta.json"

interface DreamMeta {
  lastDreamTime: number
  sessionsSinceLast: number
}

export namespace MemoryDream {
  export interface DreamResult {
    consolidated: number
    pruned: number
    promoted: number
  }

  /**
   * Check if Auto Dream should run.
   * Conditions: 24+ hours since last dream AND 5+ sessions since last dream.
   */
  export async function shouldRun(projectPath: string): Promise<boolean> {
    const meta = await loadMeta(projectPath)
    if (!meta) return false // No meta file = first session, skip dream

    const hoursSinceLast = (Date.now() - meta.lastDreamTime) / (1000 * 60 * 60)
    return hoursSinceLast >= 24 && meta.sessionsSinceLast >= 5
  }

  /**
   * Increment the session counter in dream metadata.
   * Called at session start.
   */
  export async function trackSession(projectPath: string): Promise<void> {
    const meta = (await loadMeta(projectPath)) ?? {
      lastDreamTime: Date.now(),
      sessionsSinceLast: 0,
    }
    const updated = { ...meta, sessionsSinceLast: meta.sessionsSinceLast + 1 }
    await saveMeta(projectPath, updated)
  }

  /**
   * Run the Auto Dream consolidation cycle.
   * This is a heavier operation than regular maintenance — it looks for
   * semantic patterns across all memories and consolidates them.
   */
  export async function run(projectPath: string): Promise<DreamResult> {
    log.info("auto dream starting", { projectPath })
    const result: DreamResult = { consolidated: 0, pruned: 0, promoted: 0 }

    try {
      // Phase 1: Orient — load all memories and group by type/scope
      const entries = await MemoryStore.runPromise((svc) => svc.list(projectPath))
      if (entries.length === 0) {
        log.info("auto dream skipped — no entries", { projectPath })
        return result
      }

      // Phase 2: Consolidate — merge semantically similar entries
      // Group by type + scope + agent + normalized name prefix (first 3 words, lowercased).
      // Including type/scope/agent prevents entries from different buckets being merged.
      const groups = new Map<string, typeof entries>()
      for (const entry of entries) {
        const key = `${entry.type}|${entry.scope}|${entry.agent ?? ""}|${normalizeKey(entry.name)}`
        const group = groups.get(key) ?? []
        group.push(entry)
        groups.set(key, group)
      }

      for (const [, group] of groups) {
        if (group.length <= 1) continue

        // Keep the entry with highest relevance * accessCount
        const sorted = [...group].sort(
          (a, b) =>
            b.relevanceScore * (b.accessCount + 1) -
            a.relevanceScore * (a.accessCount + 1),
        )
        const keeper = sorted[0]

        // Merge content from duplicates (deduplicated)
        const seenContent = new Set<string>()
        seenContent.add(keeper.content.trim())
        const additionalContent: string[] = []

        for (let i = 1; i < sorted.length; i++) {
          const trimmed = sorted[i].content.trim()
          if (!seenContent.has(trimmed)) {
            seenContent.add(trimmed)
            additionalContent.push(trimmed)
          }
        }

        // Update keeper with merged content if there's new material
        if (additionalContent.length > 0) {
          const mergedContent = [keeper.content, ...additionalContent].join(
            "\n\n---\n\n",
          )
          await MemoryStore.runPromise((svc) =>
            svc.update({
              id: keeper.id,
              content: mergedContent,
              skipTimeUpdate: true,
            }),
          )
        }

        // Remove duplicates
        for (let i = 1; i < sorted.length; i++) {
          await MemoryStore.runPromise((svc) => svc.remove(sorted[i].id))
          result.consolidated++
        }
      }

      // Phase 3: Promote — auto-promote high-access personal entries
      result.promoted = await MemoryPromoter.autoPromote(projectPath)

      // Phase 4: Prune — remove low-relevance entries
      const afterEntries = await MemoryStore.runPromise((svc) =>
        svc.list(projectPath),
      )
      for (const entry of afterEntries) {
        if (entry.relevanceScore < 0.1) {
          await MemoryStore.runPromise((svc) => svc.remove(entry.id))
          result.pruned++
        }
      }

      // Phase 5: Reindex
      await MemoryMaintenance.reindex(projectPath)

      // Update meta
      await saveMeta(projectPath, {
        lastDreamTime: Date.now(),
        sessionsSinceLast: 0,
      })

      log.info("auto dream complete", { projectPath, ...result })
    } catch (err) {
      log.warn("auto dream failed", { error: err, projectPath })
    }

    return result
  }

  function normalizeKey(name: string): string {
    return name
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, "")
      .split(/\s+/)
      .slice(0, 3)
      .join(" ")
  }

  async function loadMeta(
    projectPath: string,
  ): Promise<DreamMeta | undefined> {
    const metaPath = path.join(
      projectPath,
      ".opencode",
      "memory",
      META_FILENAME,
    )
    try {
      const file = Bun.file(metaPath)
      if (!(await file.exists())) return undefined
      return (await file.json()) as DreamMeta
    } catch {
      return undefined
    }
  }

  async function saveMeta(
    projectPath: string,
    meta: DreamMeta,
  ): Promise<void> {
    const dir = path.join(projectPath, ".opencode", "memory")
    const metaPath = path.join(dir, META_FILENAME)
    try {
      const { mkdirSync, writeFileSync } = await import("fs")
      mkdirSync(dir, { recursive: true })
      writeFileSync(metaPath, JSON.stringify(meta, null, 2))
    } catch (err) {
      log.warn("failed to save dream meta", { error: err })
    }
  }
}
