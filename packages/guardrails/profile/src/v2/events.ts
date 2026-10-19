// Session status derived from the 2.x event stream, for the 1.x `client.session.status()` call team.ts polls, plus the
// last failed / interrupted execution per session so a worker whose request died before any assistant message is not
// read back as a clean "done" (client.ts appends an errored assistant row from it).
// 2.x publishes `session.execution.started|succeeded|failed|interrupted` (session-event.ts); `session.status` and
// `session.idle` exist in the schema but have no publisher in core, so they are accepted here only defensively.
export type Failure = { type: "failed" | "interrupted"; message: string; at: number }

export class EventStore {
  private readonly status = new Map<string, { type: string }>()
  private readonly failures = new Map<string, Failure>()

  apply(ev: unknown) {
    const e = ev as { type?: string; data?: Record<string, any>; properties?: Record<string, any> }
    const d = e?.data ?? e?.properties ?? {}
    const sid = typeof d.sessionID === "string" ? d.sessionID : undefined
    if (!sid) return
    switch (e.type) {
      case "session.status":
        if (d.status && typeof d.status.type === "string") this.status.set(sid, { type: d.status.type })
        return
      case "session.execution.started":
        this.failures.delete(sid)
        this.busy(sid)
        return
      case "session.execution.failed":
        this.failures.set(sid, { type: "failed", message: String(d.error?.message ?? d.error?._tag ?? "execution failed"), at: Date.now() })
        this.idle(sid)
        return
      case "session.execution.interrupted":
        this.failures.set(sid, { type: "interrupted", message: `execution interrupted (${String(d.reason ?? "unknown")})`, at: Date.now() })
        this.idle(sid)
        return
      case "session.execution.succeeded":
      case "session.idle":
        this.idle(sid)
        return
      case "session.deleted":
        this.status.delete(sid)
        this.failures.delete(sid)
        return
    }
  }
  busy(sid: string) {
    this.status.set(sid, { type: "busy" })
  }
  idle(sid: string) {
    this.status.set(sid, { type: "idle" })
  }
  failure(sid: string): Failure | undefined {
    return this.failures.get(sid)
  }
  statuses(): Record<string, { type: string }> {
    return Object.fromEntries(this.status)
  }
}
