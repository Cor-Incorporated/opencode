// Session status derived from the 2.x event stream, for the 1.x `client.session.status()` call team.ts polls.
// 2.x emits `session.status` ({sessionID, status:{type:"idle"|"busy"|"retry"}}) and `session.execution.*`;
// there is no status operation in the plugin's session domain.
export class EventStore {
  private readonly status = new Map<string, { type: string }>()

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
        this.busy(sid)
        return
      case "session.execution.succeeded":
      case "session.execution.failed":
      case "session.execution.interrupted":
      case "session.idle":
        this.idle(sid)
        return
      case "session.deleted":
        this.status.delete(sid)
        return
    }
  }
  busy(sid: string) {
    this.status.set(sid, { type: "busy" })
  }
  idle(sid: string) {
    this.status.set(sid, { type: "idle" })
  }
  statuses(): Record<string, { type: string }> {
    return Object.fromEntries(this.status)
  }
}
