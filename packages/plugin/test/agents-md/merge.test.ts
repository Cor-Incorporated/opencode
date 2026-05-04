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

  // Regression for CRITICAL C1 — pickPreamble used to overwrite any existing
  // preamble with the generated one unless the existing carried an explicit
  // `<!-- preserve -->` marker. Real-world AGENTS.md files (this fork's root
  // included) use a marker-less preamble for top-level directives, so the old
  // behaviour silently deleted hand-written content on every re-run.
  test("C1: hand-written preamble without preserve marker is kept by default", () => {
    const existing = [
      "- ALWAYS USE PARALLEL TOOLS WHEN APPLICABLE.",
      "- The default branch in this repo is `dev`.",
      "- Local `main` ref may not exist; use `dev` or `origin/dev` for diffs.",
      "",
      "## Overview",
      "old auto",
    ].join("\n")
    const generated = ["# Project", "", "Generated preamble.", "", "## Overview", "new auto"].join("\n")
    const result = merge(existing, generated)
    // All three hand-written directives must survive byte-identically.
    expect(result).toContain("ALWAYS USE PARALLEL TOOLS WHEN APPLICABLE.")
    expect(result).toContain("The default branch in this repo is `dev`.")
    expect(result).toContain("Local `main` ref may not exist; use `dev` or `origin/dev` for diffs.")
    // Generated preamble must NOT replace it.
    expect(result).not.toContain("Generated preamble.")
    // Auto section is still refreshed.
    expect(result).toContain("new auto")
    expect(result).not.toContain("old auto")
  })

  // Regression for HIGH H1 — `## Heading` inside a fenced code block used to
  // be promoted to a real section by parseSections, corrupting any markdown
  // example on every merge round-trip.
  test("H1: ## headings inside fenced code blocks are not promoted to sections", () => {
    const md = [
      "# Title",
      "",
      "## Real Section",
      "",
      "Example:",
      "",
      "```md",
      "## This is example markdown",
      "",
      "should stay inside the fence",
      "```",
      "",
      "## Another Real Section",
      "",
      "after fence",
    ].join("\n")
    const sections = parseSections(md)
    // Expected: preamble + "Real Section" + "Another Real Section" → 3 sections.
    expect(sections.map((s) => s.heading)).toEqual(["", "Real Section", "Another Real Section"])
    const real = sections.find((s) => s.heading === "Real Section")!
    expect(real.body).toContain("```md")
    expect(real.body).toContain("## This is example markdown")
    expect(real.body).toContain("```")
  })

  // Regression for H1 — full round-trip through merge() must preserve the
  // example markdown verbatim (no spurious "This is example markdown" section
  // sneaking out of the fence).
  test("H1: code-fenced ## headings survive a merge round-trip", () => {
    const existing = [
      "# Project",
      "",
      "## House Rules",
      "",
      "Use this template:",
      "",
      "```md",
      "## Template Heading",
      "",
      "body",
      "```",
    ].join("\n")
    const generated = ["# Project", "", "## Overview", "fresh"].join("\n")
    const result = merge(existing, generated)
    // Template content must remain attached to House Rules, not promoted.
    expect(result).toContain("## House Rules")
    expect(result).toContain("```md")
    expect(result).toContain("## Template Heading")
    // The "Template Heading" must appear inside the House Rules body, not as
    // an independent section. We assert that by checking it is between the
    // two backtick fences.
    const fenceStart = result.indexOf("```md")
    const fenceEnd = result.indexOf("```", fenceStart + 5)
    const tmplIdx = result.indexOf("## Template Heading")
    expect(tmplIdx).toBeGreaterThan(fenceStart)
    expect(tmplIdx).toBeLessThan(fenceEnd)
  })
})
