import { describe, expect, test } from "bun:test"
import { isAncestorPid } from "../../src/notification"

// Build a fake /proc/<pid>/stat line.  Field index 3 (0-based) is the ppid.
// Real format: "pid (comm) S ppid pgrp session ..."
function procStat(pid: number, ppid: number): string {
  return `${pid} (bash) S ${ppid} ${pid} ${pid} 0 -1 4194304`
}

type ReadFileFn = (path: string, encoding: "utf8") => Promise<string>

/** Helper: build a mock readFile from a pid->ppid map */
function mockReadFile(tree: Record<number, number>): ReadFileFn {
  return async (filePath: string) => {
    const match = filePath.match(/\/proc\/(\d+)\/stat/)
    if (!match) throw new Error("ENOENT")
    const pid = parseInt(match[1], 10)
    if (pid in tree) return procStat(pid, tree[pid])
    throw new Error("ENOENT: no such file or directory")
  }
}

describe("isAncestorPid", () => {
  test("returns true when ancestorPid matches currentPid directly", async () => {
    // pid === ancestorPid on first iteration — no /proc read needed
    const reader = mockReadFile({})
    const result = await isAncestorPid(100, 100, reader)
    expect(result).toBe(true)
  })

  test("returns true for direct parent", async () => {
    // currentPid=200, parent=100 (the ancestor we're looking for)
    const reader = mockReadFile({ 200: 100 })
    const result = await isAncestorPid(100, 200, reader)
    expect(result).toBe(true)
  })

  test("returns true for grandparent (two levels up)", async () => {
    // currentPid=300 -> ppid=200 -> ppid=100 (ancestor)
    const reader = mockReadFile({ 300: 200, 200: 100 })
    const result = await isAncestorPid(100, 300, reader)
    expect(result).toBe(true)
  })

  test("returns false when ancestorPid is not in the process tree", async () => {
    // currentPid=300 -> ppid=200 -> ppid=1 (init, loop ends)
    const reader = mockReadFile({ 300: 200, 200: 1 })
    const result = await isAncestorPid(999, 300, reader)
    expect(result).toBe(false)
  })

  test("handles cycle protection via visited set", async () => {
    // Pathological case: pid 200 claims its parent is 200 (cycle)
    const reader = mockReadFile({ 200: 200 })
    const result = await isAncestorPid(100, 200, reader)
    expect(result).toBe(false)
  })

  test("returns false gracefully when /proc is unavailable", async () => {
    // Simulates macOS or any system without /proc
    const reader: ReadFileFn = async () => {
      throw new Error("ENOENT: no such file or directory")
    }
    const result = await isAncestorPid(100, 200, reader)
    expect(result).toBe(false)
  })

  test("returns false when /proc/stat contains non-numeric ppid", async () => {
    const reader: ReadFileFn = async (filePath: string) => {
      if (filePath === "/proc/200/stat") return "200 (bash) S notanumber 200 200 0"
      throw new Error("ENOENT")
    }
    const result = await isAncestorPid(100, 200, reader)
    expect(result).toBe(false)
  })

  test("returns false when currentPid is 1 (init)", async () => {
    // pid <= 1 should exit immediately without walking
    const reader = mockReadFile({})
    const result = await isAncestorPid(100, 1, reader)
    expect(result).toBe(false)
  })

  test("walks deep process trees correctly", async () => {
    // currentPid=500 -> 400 -> 300 -> 200 -> 100 (ancestor)
    const reader = mockReadFile({ 500: 400, 400: 300, 300: 200, 200: 100 })
    const result = await isAncestorPid(100, 500, reader)
    expect(result).toBe(true)
  })
})
