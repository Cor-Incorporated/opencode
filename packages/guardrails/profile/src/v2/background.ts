// Local copy of the fork's `packages/opencode/src/util/background.ts` (1.x). The 2.x monorepo has no `opencode`
// package, so the guardrails plugins must not reach into core internals; this 19-line registry is the only thing
// team.ts used from there. Semantics unchanged: tasks are tracked per directory until they settle.
const map = new Map<string, Set<Promise<unknown>>>()

export const Background = {
  add(dir: string, task: Promise<unknown>) {
    const set = map.get(dir) ?? new Set<Promise<unknown>>()
    set.add(task)
    map.set(dir, set)
    void task.finally(() => {
      set.delete(task)
      if (set.size) return
      map.delete(dir)
    })
  },
  async wait(dir: string) {
    const set = map.get(dir)
    if (!set?.size) return
    await Promise.allSettled([...set])
  },
}
