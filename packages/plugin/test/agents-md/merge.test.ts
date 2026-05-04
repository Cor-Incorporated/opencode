import { describe, expect, test } from "bun:test"
import { merge, parseSections } from "../../src/agents-md/merge.js"

describe("parseSections()", () => {
  test("returns the preamble plus each level-2 section in order", () => {
    const md = ["# Title", "", "intro paragraph", "", "## Overview", "", "body 1", "", "## Custom", "", "body 2"].join(
      "\n",
    )
    const sections = parseSections(md)
    expect(sections.length).toBe(3)
    expect(sections[0]!.heading).toBe("")
    expect(sections[0]!.body).toContain("intro paragraph")
    expect(sections[1]!.heading).toBe("Overview")
    expect(sections[1]!.body).toBe("body 1")
    expect(sections[2]!.heading).toBe("Custom")
    expect(sections[2]!.body).toBe("body 2")
  })

  test("detects the preserve marker on hand-written sections", () => {
    const md = ["## Custom", "<!-- preserve -->", "important hand-written notes"].join("\n")
    const sections = parseSections(md)
    const custom = sections.find((s) => s.heading === "Custom")!
    expect(custom.preserved).toBe(true)
  })
})

describe("merge()", () => {
  test("auto sections are replaced; hand-written sections are kept", () => {
    const existing = [
      "# Project",
      "",
      "## Overview",
      "old auto overview",
      "",
      "## House Rules",
      "do not delete me",
    ].join("\n")
    const generated = ["# Project", "", "## Overview", "fresh auto overview", "", "## Languages & Stack", "- TypeScript"].join(
      "\n",
    )
    const result = merge(existing, generated)
    expect(result).toContain("fresh auto overview")
    expect(result).not.toContain("old auto overview")
    expect(result).toContain("House Rules")
    expect(result).toContain("do not delete me")
  })

  test("preserve marker keeps the existing version of an auto section", () => {
    const existing = [
      "# Project",
      "",
      "## Overview",
      "<!-- preserve -->",
      "carefully tuned overview",
    ].join("\n")
    const generated = ["# Project", "", "## Overview", "auto generated"].join("\n")
    const result = merge(existing, generated)
    expect(result).toContain("carefully tuned overview")
    expect(result).not.toContain("auto generated")
  })

  test("orphaned hand-written sections are appended verbatim at the end", () => {
    const existing = ["# Project", "", "## Overview", "old", "", "## Notes", "keep these notes"].join("\n")
    const generated = ["# Project", "", "## Overview", "new"].join("\n")
    const result = merge(existing, generated)
    expect(result).toContain("## Notes")
    expect(result).toContain("keep these notes")
    // Orphaned sections appear after auto sections.
    expect(result.indexOf("## Notes")).toBeGreaterThan(result.indexOf("## Overview"))
  })

  test("idempotent: merging the same generated body twice yields the same output", () => {
    const existing = ["# X", "", "## Overview", "old", "", "## Custom", "kept"].join("\n")
    const generated = ["# X", "", "## Overview", "new"].join("\n")
    const once = merge(existing, generated)
    const twice = merge(once, generated)
    expect(twice).toBe(once)
  })
})
