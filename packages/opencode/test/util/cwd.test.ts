import { describe, expect, test } from "bun:test"
import path from "path"
import fs from "fs/promises"
import { canonicalizeWorkingDirectory } from "../../src/util/cwd"
import { tmpdir } from "../fixture/fixture"

describe("canonicalizeWorkingDirectory", () => {
  test("normalizes casing when the filesystem accepts mixed-case aliases", async () => {
    await using tmp = await tmpdir()
    const mixedCaseDir = path.join(tmp.path, "CaseCheck")
    await fs.mkdir(mixedCaseDir, { recursive: true })

    const parent = path.dirname(mixedCaseDir)
    const lowerAlias = path.join(parent, "casecheck")
    try {
      await fs.access(lowerAlias)
    } catch {
      return
    }

    const previous = process.cwd()
    try {
      const resolved = canonicalizeWorkingDirectory(lowerAlias)
      expect(resolved).toBe(mixedCaseDir)
      expect(process.cwd()).toBe(mixedCaseDir)
    } finally {
      process.chdir(previous)
    }
  })
})
