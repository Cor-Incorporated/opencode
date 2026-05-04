import { describe, expect, test } from "bun:test"
import { dedupe } from "../../src/agents-md/dedupe.js"

describe("dedupe()", () => {
  // Regression for CRITICAL C2 — stripGeneric used to run unconditionally on
  // the raw text *before* parseSections, which silently dropped any line in a
  // hand-written section that happened to contain a common English phrase
  // like "follow best practices" or "be helpful". User-authored content must
  // be byte-preserved; only auto sections (which the generator never emits
  // these phrases into anyway) may be stripped.
  test("C2: hand-written sections containing generic phrases are byte-preserved", () => {
    const handWritten = [
      "# Project",
      "",
      "## House Rules",
      "",
      "- Always follow best practices when writing code.",
      "- Be helpful to teammates during code review.",
      "- It is important to note that we ship on Fridays.",
    ].join("\n")
    const input = new Map<string, string>([["AGENTS.md", handWritten]])
    const result = dedupe({ files: input })
    const out = result.files.get("AGENTS.md")!
    expect(out).toContain("Always follow best practices when writing code.")
    expect(out).toContain("Be helpful to teammates during code review.")
    expect(out).toContain("It is important to note that we ship on Fridays.")
  })

  // Regression for C2 — preserve marker on an auto section also disables the
  // generic strip on that section.
  test("C2: <!-- preserve --> on an auto section disables the generic strip", () => {
    const md = [
      "# Project",
      "",
      "## Overview",
      "<!-- preserve -->",
      "We follow best practices defined in CONTRIBUTING.md.",
    ].join("\n")
    const input = new Map<string, string>([["AGENTS.md", md]])
    const result = dedupe({ files: input })
    const out = result.files.get("AGENTS.md")!
    expect(out).toContain("We follow best practices defined in CONTRIBUTING.md.")
  })

  // Regression for C2 — auto sections without a preserve marker still get
  // stripped, so the protection is narrowly scoped (we did not regress the
  // intended boilerplate filter).
  test("C2: unmarked auto sections still have generic phrases stripped", () => {
    const md = [
      "# Project",
      "",
      "## Overview",
      "Repository root.",
      "Please ensure that you follow best practices.",
      "Final useful sentence.",
    ].join("\n")
    const input = new Map<string, string>([["AGENTS.md", md]])
    const result = dedupe({ files: input })
    const out = result.files.get("AGENTS.md")!
    expect(out).toContain("Repository root.")
    expect(out).toContain("Final useful sentence.")
    expect(out).not.toContain("Please ensure that you follow best practices.")
  })

  // Sanity: parent-vs-child dedupe still works.
  test("identical sections in a child file are removed in favour of the ancestor", () => {
    const root = ["# Project", "", "## Overview", "shared overview"].join("\n")
    const child = ["# Sub", "", "## Overview", "shared overview"].join("\n")
    const input = new Map<string, string>([
      ["AGENTS.md", root],
      ["pkg/AGENTS.md", child],
    ])
    const result = dedupe({ files: input })
    expect(result.removed.length).toBe(1)
    expect(result.removed[0]!.heading).toBe("Overview")
    expect(result.files.get("pkg/AGENTS.md")!).not.toContain("shared overview")
  })

  // Regression for round-2 CRITICAL — the parent-vs-child dedupe pass used to
  // run against *every* section (not just generator-owned auto sections), so a
  // child file's hand-written `## House Rules` that echoed an ancestor
  // verbatim was silently deleted. Hand-written sections must survive even
  // when their content matches an ancestor exactly.
  test("child hand-written sections matching an ancestor are preserved", () => {
    const root = [
      "# Project",
      "",
      "## House Rules",
      "",
      "- ship on Fridays",
      "- no force push",
    ].join("\n")
    const child = [
      "# Pkg",
      "",
      "## House Rules",
      "",
      "- ship on Fridays",
      "- no force push",
    ].join("\n")
    const input = new Map<string, string>([
      ["AGENTS.md", root],
      ["pkg/AGENTS.md", child],
    ])
    const result = dedupe({ files: input })
    const childOut = result.files.get("pkg/AGENTS.md")!
    expect(childOut).toContain("## House Rules")
    expect(childOut).toContain("- ship on Fridays")
    expect(childOut).toContain("- no force push")
    expect(result.removed.find((r) => r.child === "pkg/AGENTS.md" && r.heading === "House Rules")).toBeUndefined()
  })

  // Companion to the above — auto sections (Overview, Build & Test, etc.) MUST
  // still be deduped against ancestors. The hand-written carve-out is narrow:
  // only sections the generator does not own are exempt.
  test("child auto sections matching an ancestor are still removed", () => {
    const root = ["# Project", "", "## Build & Test", "", "Run `bun test`."].join("\n")
    const child = ["# Pkg", "", "## Build & Test", "", "Run `bun test`."].join("\n")
    const input = new Map<string, string>([
      ["AGENTS.md", root],
      ["pkg/AGENTS.md", child],
    ])
    const result = dedupe({ files: input })
    const childOut = result.files.get("pkg/AGENTS.md")!
    expect(childOut).not.toContain("Run `bun test`.")
    expect(result.removed.find((r) => r.child === "pkg/AGENTS.md" && r.heading === "Build & Test")).toBeDefined()
  })
})
