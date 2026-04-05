import { Database, eq, and, sql } from "@/storage/db"
import { ulid } from "ulid"
import { Effect, Layer, ServiceMap } from "effect"
import { MemoryTable } from "./memory.sql"
import { makeRuntime } from "@/effect/run-service"
import { Log } from "@/util/log"
import type { Memory } from "./types"

const log = Log.create({ service: "memory.store" })

function toInfo(row: typeof MemoryTable.$inferSelect): Memory.Info {
  return {
    id: row.id,
    projectPath: row.project_path,
    topic: row.topic,
    type: row.type as Memory.Type,
    content: row.content,
    sessionID: row.session_id ?? undefined,
    accessCount: row.access_count ?? 0,
    timeCreated: row.time_created,
    timeUpdated: row.time_updated,
  }
}

export namespace MemoryStore {
  const db = <T>(fn: (d: Parameters<typeof Database.use>[0] extends (trx: infer D) => any ? D : never) => T) =>
    Effect.sync(() => Database.use(fn))

  export interface Interface {
    readonly list: (projectPath: string) => Effect.Effect<Memory.Info[]>
    readonly get: (id: string) => Effect.Effect<Memory.Info | undefined>
    readonly create: (input: Memory.Create) => Effect.Effect<Memory.Info>
    readonly update: (input: Memory.Update) => Effect.Effect<Memory.Info | undefined>
    readonly remove: (id: string) => Effect.Effect<void>
    readonly listByType: (projectPath: string, type: Memory.Type) => Effect.Effect<Memory.Info[]>
  }

  export class Service extends ServiceMap.Service<Service, Interface>()("@opencode/MemoryStore") {}

  export const layer: Layer.Layer<Service> = Layer.effect(
    Service,
    Effect.gen(function* () {
      const list = Effect.fn("MemoryStore.list")(function* (projectPath: string) {
        const rows = yield* db((d) =>
          d
            .select()
            .from(MemoryTable)
            .where(eq(MemoryTable.project_path, projectPath))
            .all(),
        )
        return rows.map(toInfo)
      })

      const get = Effect.fn("MemoryStore.get")(function* (id: string) {
        const row = yield* db((d) =>
          d
            .select()
            .from(MemoryTable)
            .where(eq(MemoryTable.id, id))
            .get(),
        )
        if (!row) return undefined
        yield* db((d) =>
          d
            .update(MemoryTable)
            .set({ access_count: sql`${MemoryTable.access_count} + 1` })
            .where(eq(MemoryTable.id, id))
            .run(),
        )
        const updated = yield* db((d) =>
          d
            .select()
            .from(MemoryTable)
            .where(eq(MemoryTable.id, id))
            .get(),
        )
        return updated ? toInfo(updated) : toInfo(row)
      })

      const create = Effect.fn("MemoryStore.create")(function* (input: Memory.Create) {
        const id = ulid()
        const now = Date.now()
        const row = {
          id,
          project_path: input.projectPath,
          topic: input.topic,
          type: input.type,
          content: input.content,
          session_id: input.sessionID ?? null,
          access_count: 0,
          time_created: now,
          time_updated: now,
        }
        yield* db((d) => d.insert(MemoryTable).values(row).run())
        log.info("memory created", { id, topic: input.topic, type: input.type })
        return toInfo(row)
      })

      const update = Effect.fn("MemoryStore.update")(function* (input: Memory.Update) {
        // Use direct select to check existence without incrementing access_count
        // (the public get() method has a side effect of incrementing access_count)
        const existing = yield* db((d) =>
          d
            .select()
            .from(MemoryTable)
            .where(eq(MemoryTable.id, input.id))
            .get(),
        )
        if (!existing) return undefined
        const values: Record<string, unknown> = { time_updated: Date.now() }
        if (input.topic !== undefined) values.topic = input.topic
        if (input.type !== undefined) values.type = input.type
        if (input.content !== undefined) values.content = input.content
        yield* db((d) => d.update(MemoryTable).set(values).where(eq(MemoryTable.id, input.id)).run())
        log.info("memory updated", { id: input.id })
        // Return updated row without incrementing access_count
        const updated = yield* db((d) =>
          d
            .select()
            .from(MemoryTable)
            .where(eq(MemoryTable.id, input.id))
            .get(),
        )
        return updated ? toInfo(updated) : undefined
      })

      const remove = Effect.fn("MemoryStore.remove")(function* (id: string) {
        yield* db((d) => d.delete(MemoryTable).where(eq(MemoryTable.id, id)).run())
        log.info("memory removed", { id })
      })

      const listByType = Effect.fn("MemoryStore.listByType")(function* (projectPath: string, type: Memory.Type) {
        const rows = yield* db((d) =>
          d
            .select()
            .from(MemoryTable)
            .where(and(eq(MemoryTable.project_path, projectPath), eq(MemoryTable.type, type)))
            .all(),
        )
        return rows.map(toInfo)
      })

      return Service.of({ list, get, create, update, remove, listByType })
    }),
  )

  export const { runPromise } = makeRuntime(Service, layer)
}
