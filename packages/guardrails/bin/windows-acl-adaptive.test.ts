// Temporary bounded ddmin experiment. Normal test directories do not include this file.
import { expect, test } from "bun:test"
import { diagnose, snapshotNames } from "./windows-acl-transport.mjs"

const all = process.platform === "win32" ? snapshotNames() : []
const deadline = performance.now() + 170_000
let current = all
let granularity = 2
let phase = "full"
let queue: string[][] = []
let probes = 0
let withoutFailed = false
const confirmations: boolean[] = []

function complements() {
  const width = Math.ceil(current.length / granularity)
  queue = Array.from({ length: Math.ceil(current.length / width) }, (_, index) =>
    current.filter((_, position) => position < index * width || position >= (index + 1) * width),
  )
}

function next() {
  if (phase === "full") return { keys: all, stage: "Get-Acl", transport: "bun" }
  if (phase === "search") {
    if (current.length === 1) phase = "without"
    else if (!queue.length) complements()
    if (phase === "search") {
      const keys = queue.shift()
      if (!keys) {
        phase = "no-candidate"
        return
      }
      return { keys, stage: "Get-Acl", transport: "bun" }
    }
  }
  if (phase === "without")
    return { keys: all.filter((key) => !current.includes(key)), stage: "Get-Acl", transport: "bun" }
  if (phase === "confirm") {
    const index = confirmations.length
    return { keys: current, stage: index % 2 ? "Get-Acl" : "Set-Acl", transport: index < 2 ? "bun" : "node24" }
  }
}

function advance(keys: string[], ok: boolean) {
  if (phase === "full") {
    phase = ok ? "search" : "full-group-failed"
    return
  }
  if (phase === "search") {
    if (ok) {
      current = keys
      granularity = Math.max(2, granularity - 1)
      queue = []
      if (!current.length) phase = "empty-group-succeeded"
      return
    }
    if (queue.length) return
    if (granularity >= current.length) phase = "without"
    else granularity = Math.min(current.length, granularity * 2)
    return
  }
  if (phase === "without") {
    withoutFailed = !ok
    phase = "confirm"
    return
  }
  if (phase === "confirm") {
    confirmations.push(ok)
    if (confirmations.length === 4) phase = "done"
  }
}

for (let slot = 0; slot < 30; slot++) {
  test.skipIf(process.platform !== "win32")("Windows ACL adaptive probe " + slot, () => {
    if (performance.now() >= deadline || (phase === "search" && probes >= 24)) phase = "budget-exhausted"
    const plan = next()
    if (plan) {
      const result = diagnose(plan.stage, plan.transport, plan.keys)
      probes++
      console.log("ACL_ADAPTIVE " + JSON.stringify({ phase, transport: plan.transport, ...result }))
      const ok = !result.errorCode && result.status === 0
      advance(plan.keys, ok)
      expect(result.status).toBe(0)
    }
    if (slot === 29)
      console.log(
        "ACL_ADAPTIVE_SUMMARY " +
          JSON.stringify({ phase, probes, unusedSlots: 30 - probes, candidate: current, withoutFailed, confirmations }),
      )
  })
}
