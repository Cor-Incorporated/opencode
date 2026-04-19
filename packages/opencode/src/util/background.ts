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
