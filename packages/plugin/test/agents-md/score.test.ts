import { describe, expect, test } from "bun:test"
import { score } from "../../src/agents-md/score.js"
import type { DirStats } from "../../src/agents-md/types.js"

function dir(overrides: Partial<DirStats>): DirStats {
  return {
    path: overrides.path ?? "/repo",
    relPath: overrides.relPath ?? ".",
    depth: overrides.depth ?? 0,
    fileCount: overrides.fileCount ?? 0,
    subdirCount: overrides.subdirCount ?? 0,
    loc: overrides.loc ?? 0,
    languages: overrides.languages ?? [],
    manifests: overrides.manifests ?? [],
    existing: overrides.existing,
    packageDescription: overrides.packageDescription,
  }
}

describe("score()", () => {
  test("repo root is always emitted regardless of score", () => {
    const stats = [dir({ relPath: ".", depth: 0, fileCount: 0, subdirCount: 0, loc: 0, languages: [] })]
    const result = score(stats, { createNew: false })
    expect(result[0]!.action).toBe("generate")
    // Empty root should score 0 — well below the high threshold.
    expect(result[0]!.score).toBeLessThan(5)
  })

  test("score formula: sqrt(file_count)*2 + subdir_count + (loc_share/10)*(lang_count+1)", () => {
    // total LOC = 200, this dir LOC = 100 → loc_share = 50% capped at 10
    const stats = [
      dir({ relPath: ".", depth: 0, loc: 100 }),
      dir({
        relPath: "src",
        depth: 1,
        fileCount: 5,
        subdirCount: 2,
        loc: 100,
        languages: [".ts", ".tsx"],
      }),
    ]
    const result = score(stats, { createNew: false })
    // sqrt(5)*2 ≈ 4.472, subdir 2, density (10/10)*(2+1) = 3 → ≈ 9.47, rounded to 9.5
    expect(result[1]!.score).toBe(9.5)
    expect(result[1]!.action).toBe("generate")
  })

  test("score < 3 → skip", () => {
    const stats = [
      dir({ relPath: ".", depth: 0, loc: 1000 }),
      dir({ relPath: "tiny", depth: 1, fileCount: 1, subdirCount: 0, loc: 5, languages: [".ts"] }),
    ]
    const result = score(stats, { createNew: false })
    expect(result[1]!.action).toBe("skip")
    expect(result[1]!.reason).toContain("< 3")
  })

  test("3..5 with no nearby ancestor → generate", () => {
    const stats = [
      dir({ relPath: ".", depth: 0, loc: 1000 }),
      dir({
        relPath: "isolated",
        depth: 1,
        fileCount: 3,
        subdirCount: 0,
        loc: 5,
        languages: [".py"],
      }),
    ]
    const result = score(stats, { createNew: false })
    // sqrt(3)*2 ≈ 3.46, density tiny → ≈ 3.5
    expect(result[1]!.score).toBeGreaterThanOrEqual(3)
    expect(result[1]!.score).toBeLessThanOrEqual(5)
    expect(result[1]!.action).toBe("generate")
  })

  test("3..5 with covered ancestor → skip", () => {
    const stats = [
      dir({ relPath: ".", depth: 0, loc: 1000, fileCount: 0 }),
      dir({
        relPath: "src",
        depth: 1,
        fileCount: 5,
        subdirCount: 3,
        loc: 200,
        languages: [".ts"],
      }),
      dir({
        relPath: "src/util",
        depth: 2,
        fileCount: 3,
        subdirCount: 0,
        loc: 5,
        languages: [".ts"],
      }),
    ]
    const result = score(stats, { createNew: false })
    expect(result[1]!.action).toBe("generate")
    expect(result[2]!.action).toBe("skip")
    expect(result[2]!.reason).toContain("ancestor")
  })

  test("createNew lowers threshold to 2", () => {
    const stats = [
      dir({ relPath: ".", depth: 0, loc: 1000 }),
      dir({ relPath: "small", depth: 1, fileCount: 1, subdirCount: 0, loc: 10, languages: [".ts"] }),
    ]
    const normal = score(stats, { createNew: false })
    // sqrt(1)*2 + 0 + (~1/10)*1 ≈ 2.1 → below MID(3) → skip
    expect(normal[1]!.action).toBe("skip")
    const aggressive = score(stats, { createNew: true })
    // 2.1 ≥ 2 → generate under create-new
    expect(aggressive[1]!.action).toBe("generate")
  })

  test("existing AGENTS.md routes to update action", () => {
    const stats = [
      dir({ relPath: ".", depth: 0, loc: 100, existing: "# existing\n" }),
      dir({
        relPath: "lib",
        depth: 1,
        fileCount: 10,
        subdirCount: 4,
        loc: 500,
        languages: [".ts", ".tsx"],
        existing: "# existing lib\n",
      }),
    ]
    const result = score(stats, { createNew: false })
    expect(result[0]!.action).toBe("update")
    expect(result[1]!.action).toBe("update")
  })

  test("loc_share is clamped at 10", () => {
    // Even if a single dir holds 100% of the LOC, share is capped at 10.
    const stats = [
      dir({ relPath: ".", depth: 0, loc: 0, fileCount: 0, subdirCount: 0 }),
      dir({ relPath: "huge", depth: 1, fileCount: 0, subdirCount: 0, loc: 999_999, languages: [".ts"] }),
    ]
    const result = score(stats, { createNew: false })
    // sqrt(0)*2 + 0 + (10/10)*(1+1) = 2.0
    expect(result[1]!.score).toBe(2)
    // locShare itself is clamped to 10 in the persisted breakdown.
    expect(result[1]!.locShare).toBe(10)
  })

  test("multiplicative density rewards polyglot, code-heavy directories", () => {
    // Two dirs with identical files/subdirs/loc but differing language count.
    // The polyglot dir should score higher thanks to the multiplicative
    // (loc_share/10)*lang_count term — distinguishing the fork formula from a
    // purely additive weighted sum where languages contribute the same fixed
    // amount regardless of LOC concentration.
    const stats = [
      dir({ relPath: ".", depth: 0, loc: 100 }),
      dir({ relPath: "mono", depth: 1, fileCount: 4, subdirCount: 1, loc: 100, languages: [".ts"] }),
      dir({ relPath: "poly", depth: 1, fileCount: 4, subdirCount: 1, loc: 100, languages: [".ts", ".py", ".go"] }),
    ]
    const result = score(stats, { createNew: false })
    expect(result[2]!.score).toBeGreaterThan(result[1]!.score)
  })
})
