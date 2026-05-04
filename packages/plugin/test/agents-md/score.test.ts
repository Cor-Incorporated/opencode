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
    expect(result[0]!.score).toBeLessThan(8)
  })

  test("score formula: file_count*3 + subdir_count*2 + loc_share*2 + lang_count", () => {
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
    // file 5*3=15, subdir 2*2=4, loc_share clamp 10*2=20, langs 2 → 41
    expect(result[1]!.score).toBe(41)
    expect(result[1]!.action).toBe("generate")
  })

  test("score < 8 → skip", () => {
    const stats = [
      dir({ relPath: ".", depth: 0, loc: 1000 }),
      dir({ relPath: "tiny", depth: 1, fileCount: 1, subdirCount: 0, loc: 5, languages: [".ts"] }),
    ]
    const result = score(stats, { createNew: false })
    expect(result[1]!.action).toBe("skip")
    expect(result[1]!.reason).toContain("< 8")
  })

  test("8..15 with no nearby ancestor → generate", () => {
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
    // file 3*3=9 + subdir 0 + loc_share ~0.05*2 + lang 1 ≈ 10
    expect(result[1]!.score).toBeGreaterThanOrEqual(8)
    expect(result[1]!.score).toBeLessThanOrEqual(15)
    expect(result[1]!.action).toBe("generate")
  })

  test("8..15 with covered ancestor → skip", () => {
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

  test("createNew lowers threshold to 5", () => {
    const stats = [
      dir({ relPath: ".", depth: 0, loc: 1000 }),
      dir({ relPath: "small", depth: 1, fileCount: 1, subdirCount: 1, loc: 10, languages: [".ts"] }),
    ]
    const normal = score(stats, { createNew: false })
    expect(normal[1]!.action).toBe("skip")
    const aggressive = score(stats, { createNew: true })
    // file 1*3=3 + subdir 1*2=2 + loc_share ~0.02*2 + lang 1 = 6 → meets 5
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
    // 0*3 + 0*2 + 10*2 + 1 = 21
    expect(result[1]!.score).toBe(21)
  })
})
