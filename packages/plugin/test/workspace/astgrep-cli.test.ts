/**
 * Mock-based unit tests for the ast-grep CLI wrapper.
 *
 * Verifies:
 *   - command line construction (args, --lang, --rewrite, --update-all),
 *   - JSON-stream parsing,
 *   - search result truncation at 200,
 *   - dryRun preserves files,
 *   - non-dryRun applies replacements via atomic write.
 */

import { describe, expect, it } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { Readable } from "node:stream"

import { astGrepSearchTool } from "../../src/tools/workspace/astgrep/search.js"
import { AstGrepCli, isSupportedLang, type SpawnFn } from "../../src/tools/workspace/astgrep/cli.js"
import type { ReplaceOpts, SearchOpts } from "../../src/tools/workspace/astgrep/types.js"

interface MockOptions {
  stdout?: string
  exitCode?: number
}

function mockSpawn(programResponses: Record<string, MockOptions> | string): {
  spawn: SpawnFn
  calls: string[][]
} {
  const calls: string[][] = []
  const spawn: SpawnFn = (cmd) => {
    calls.push(cmd)
    let stdout = ""
    let exit = 0
    if (typeof programResponses === "string") {
      stdout = programResponses
    } else {
      // Match against the *non-flag* portion of cmd (after the binary).
      const key = cmd[1] ?? ""
      const resp = programResponses[key] ?? programResponses["default"] ?? { stdout: "", exitCode: 0 }
      stdout = resp.stdout ?? ""
      exit = resp.exitCode ?? 0
    }
    const stream = Readable.from([Buffer.from(stdout)])
    return {
      stdout: stream,
      stderr: null,
      exited: Promise.resolve(exit),
    }
  }
  return { spawn, calls }
}

describe("isSupportedLang", () => {
  it("accepts supported languages", () => {
    expect(isSupportedLang("ts")).toBe(true)
    expect(isSupportedLang("py")).toBe(true)
  })
  it("rejects unsupported languages", () => {
    expect(isSupportedLang("ruby")).toBe(false)
  })
})

describe("AstGrepCli.buildSearchArgs", () => {
  it("builds a basic search command", () => {
    const cli = new AstGrepCli({
      binary: "/fake/sg",
      spawn: () => ({ stdout: Readable.from([]), stderr: null, exited: Promise.resolve(0) }),
    })
    const args = cli.buildSearchArgs({ pattern: "console.log($MSG)", lang: "ts" })
    expect(args).toEqual(["run", "--pattern", "console.log($MSG)", "--lang", "ts", "--json=stream"])
  })

  it("includes context, globs, paths, rewrite, --update-all", () => {
    const cli = new AstGrepCli({
      binary: "/fake/sg",
      spawn: () => ({ stdout: Readable.from([]), stderr: null, exited: Promise.resolve(0) }),
    })
    const opts: SearchOpts = {
      pattern: "p",
      lang: "ts",
      paths: ["src"],
      globs: ["*.ts"],
      context: 2,
    }
    const args = cli.buildSearchArgs(opts, "r", false)
    expect(args).toContain("--context")
    expect(args).toContain("2")
    expect(args).toContain("--globs")
    expect(args).toContain("*.ts")
    expect(args).toContain("--rewrite")
    expect(args).toContain("r")
    expect(args).toContain("--update-all")
    expect(args).toContain("src")
  })

  it("omits --update-all when dryRun=true with rewrite", () => {
    const cli = new AstGrepCli({
      binary: "/fake/sg",
      spawn: () => ({ stdout: Readable.from([]), stderr: null, exited: Promise.resolve(0) }),
    })
    const args = cli.buildSearchArgs({ pattern: "p", lang: "ts" }, "r", true)
    expect(args).toContain("--rewrite")
    expect(args).not.toContain("--update-all")
  })
})

describe("AstGrepCli.search (mocked)", () => {
  it("parses JSON stream output", async () => {
    const stdout = [
      JSON.stringify({
        file: "/abs/foo.ts",
        text: 'console.log("hi")',
        range: {
          byteOffset: { start: 0, end: 18 },
          start: { line: 0, column: 0 },
          end: { line: 0, column: 18 },
        },
        metaVariables: { single: { MSG: { text: '"hi"' } } },
      }),
      JSON.stringify({
        file: "/abs/bar.ts",
        text: "console.log(x)",
        range: {
          byteOffset: { start: 0, end: 14 },
          start: { line: 5, column: 2 },
          end: { line: 5, column: 16 },
        },
      }),
    ].join("\n")
    const { spawn } = mockSpawn(stdout)
    const cli = new AstGrepCli({ binary: "/fake/sg", spawn })
    const out = await cli.search({ pattern: "console.log($MSG)", lang: "ts" })
    expect(out.total).toBe(2)
    expect(out.truncated).toBe(false)
    expect(out.results[0]?.file).toBe("/abs/foo.ts")
    expect(out.results[0]?.metavars?.MSG).toBe('"hi"')
    expect(out.results[1]?.line).toBe(5)
  })

  it("truncates at 200 matches and reports total", async () => {
    const lines: string[] = []
    for (let i = 0; i < 250; i++) {
      lines.push(
        JSON.stringify({
          file: `/abs/f${i}.ts`,
          text: `m${i}`,
          range: { byteOffset: { start: 0, end: 1 }, start: { line: 0, column: 0 }, end: { line: 0, column: 1 } },
        }),
      )
    }
    const { spawn } = mockSpawn(lines.join("\n"))
    const cli = new AstGrepCli({ binary: "/fake/sg", spawn })
    const out = await cli.search({ pattern: "x", lang: "ts" })
    expect(out.total).toBe(250)
    expect(out.truncated).toBe(true)
    expect(out.results).toHaveLength(200)
  })

  it("returns empty results when stdout is empty", async () => {
    const { spawn } = mockSpawn("")
    const cli = new AstGrepCli({ binary: "/fake/sg", spawn })
    const out = await cli.search({ pattern: "x", lang: "ts" })
    expect(out.total).toBe(0)
    expect(out.results).toHaveLength(0)
  })
})

describe("AstGrepCli.replace (mocked)", () => {
  it("does not modify files in dryRun mode", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "ag-dry-"))
    const file = path.join(dir, "foo.ts")
    const original = 'console.log("hi")\n'
    await writeFile(file, original)
    const stdout = JSON.stringify({
      file,
      text: 'console.log("hi")',
      replacement: 'logger.info("hi")',
      range: {
        byteOffset: { start: 0, end: 17 },
        start: { line: 0, column: 0 },
        end: { line: 0, column: 17 },
      },
    })
    const { spawn } = mockSpawn(stdout)
    const cli = new AstGrepCli({ binary: "/fake/sg", spawn })
    const opts: ReplaceOpts = {
      pattern: "console.log($MSG)",
      rewrite: "logger.info($MSG)",
      lang: "ts",
      dryRun: true,
    }
    const out = await cli.replace(opts)
    expect(out.totalEdits).toBe(1)
    expect(out.filesChanged).toBe(1)
    expect(await readFile(file, "utf8")).toBe(original)
    await rm(dir, { recursive: true, force: true })
  })

  it("applies replacements atomically when dryRun is false", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "ag-write-"))
    const file = path.join(dir, "foo.ts")
    await writeFile(file, 'console.log("hi")\n')
    const stdout = JSON.stringify({
      file,
      text: 'console.log("hi")',
      replacement: 'logger.info("hi")',
      range: {
        byteOffset: { start: 0, end: 17 },
        start: { line: 0, column: 0 },
        end: { line: 0, column: 17 },
      },
    })
    const { spawn } = mockSpawn(stdout)
    const cli = new AstGrepCli({ binary: "/fake/sg", spawn })
    const out = await cli.replace({
      pattern: "console.log($MSG)",
      rewrite: "logger.info($MSG)",
      lang: "ts",
    })
    expect(out.filesChanged).toBe(1)
    expect(out.totalEdits).toBe(1)
    expect(await readFile(file, "utf8")).toBe('logger.info("hi")\n')
    await rm(dir, { recursive: true, force: true })
  })

  it("preserves non-ASCII content when applying byte-offset edits (regression)", async () => {
    // PR-B regression: ast-grep emits UTF-8 byte offsets, but the previous
    // implementation sliced UTF-16 code units. CJK characters are 3 bytes
    // each in UTF-8 but 1 code unit in UTF-16, so even a simple replacement
    // around them used to land on the wrong byte boundary and corrupt the
    // file. We assert that 'こんにちは' survives unchanged when the edit
    // happens AFTER it.
    const dir = await mkdtemp(path.join(tmpdir(), "ag-utf8-"))
    const file = path.join(dir, "foo.ts")
    const original = 'console.log("こんにちは")\n'
    await writeFile(file, original)
    // Byte offsets of `console.log("こんにちは")`:
    //   "console.log(\"" = 13 bytes
    //   "こんにちは"      = 5 chars × 3 bytes = 15 bytes
    //   "\")"             = 2 bytes
    //   total            = 30 bytes
    const startByte = 0
    const endByte = Buffer.byteLength(original.trimEnd(), "utf8") // 30
    const stdout = JSON.stringify({
      file,
      text: 'console.log("こんにちは")',
      replacement: 'logger.info("こんにちは")',
      range: {
        byteOffset: { start: startByte, end: endByte },
        start: { line: 0, column: 0 },
        end: { line: 0, column: 24 },
      },
    })
    const { spawn } = mockSpawn(stdout)
    const cli = new AstGrepCli({ binary: "/fake/sg", spawn })
    const out = await cli.replace({
      pattern: "console.log($MSG)",
      rewrite: "logger.info($MSG)",
      lang: "ts",
    })
    expect(out.filesChanged).toBe(1)
    expect(out.totalEdits).toBe(1)
    const written = await readFile(file, "utf8")
    expect(written).toBe('logger.info("こんにちは")\n')
    // Sanity check: non-ASCII bytes survive byte-for-byte.
    expect(Buffer.from(written, "utf8").toString("utf8")).toContain("こんにちは")
    await rm(dir, { recursive: true, force: true })
  })

  it("surfaces a real CLI failure as an error (not silent empty results)", async () => {
    // PR-B regression: previously a non-zero exit + non-empty stderr was
    // dropped on the floor. Bad patterns now throw AstGrepCliError.
    const spawn: SpawnFn = () => ({
      stdout: Readable.from([]),
      stderr: Readable.from([Buffer.from("error: Pattern is invalid\n")]),
      exited: Promise.resolve(2),
    })
    const cli = new AstGrepCli({ binary: "/fake/sg", spawn })
    await expect(cli.search({ pattern: "((", lang: "ts" })).rejects.toThrow(/exited with code 2/)
  })

  it("treats exit code 1 with empty stdout as 'no matches' (not failure)", async () => {
    // ast-grep returns 1 when no matches are found — we must not surface
    // this as an error or callers will break on every clean search.
    const spawn: SpawnFn = () => ({
      stdout: Readable.from([]),
      stderr: null,
      exited: Promise.resolve(1),
    })
    const cli = new AstGrepCli({ binary: "/fake/sg", spawn })
    const out = await cli.search({ pattern: "x", lang: "ts" })
    expect(out.total).toBe(0)
    expect(out.results).toHaveLength(0)
  })

  it("surfaces ERROR-tagged stderr as failure even when exit code is 0 (re-review NH2)", async () => {
    // PR-B re-review (round 2, NH2): real `sg` sometimes prints
    //   ERROR: file not found: <path>
    // to stderr and STILL exits 0. Treating that as "no matches" lets
    // genuinely broken inputs masquerade as successful empty searches.
    // The wrapper must escalate any ERROR-prefixed stderr to a thrown
    // `AstGrepCliError`, regardless of exit code.
    const spawn: SpawnFn = () => ({
      stdout: Readable.from([]),
      stderr: Readable.from([Buffer.from("ERROR: file not found: /nope.ts\n")]),
      exited: Promise.resolve(0),
    })
    const cli = new AstGrepCli({ binary: "/fake/sg", spawn })
    await expect(cli.search({ pattern: "x", lang: "ts", paths: ["/nope.ts"] })).rejects.toThrow(/exited with code 0/)
  })

  it("does not pass paths[0] as cwd to the spawned process (re-review NH3)", async () => {
    // PR-B re-review (round 2, NH3): previously the CLI wrapper passed
    // opts.paths?.[0] as the spawn's `cwd`. `paths` is the search target
    // (positional CLI args), not a directory hint. Misusing it caused
    // hangs (non-existent path) and ENOTDIR (file path). The fix relies
    // on process.cwd() instead — assert by inspecting what the spawn
    // function actually receives.
    const seenCwds: Array<string | undefined> = []
    const spawn: SpawnFn = (_cmd, opts) => {
      seenCwds.push(opts.cwd)
      return { stdout: Readable.from([]), stderr: null, exited: Promise.resolve(1) }
    }
    const cli = new AstGrepCli({ binary: "/fake/sg", spawn })
    // Pass a *file* path as `paths[0]` — the previous implementation
    // would use it as cwd and the spawn would crash with ENOTDIR. The
    // fixed implementation should ignore it for cwd purposes.
    await cli.search({ pattern: "x", lang: "ts", paths: ["/abs/path/to/file.ts"] })
    expect(seenCwds.length).toBeGreaterThan(0)
    for (const cwd of seenCwds) {
      // Accept either undefined or process.cwd(); explicitly REJECT the
      // bad value (the file path that was previously misused as cwd).
      expect(cwd).not.toBe("/abs/path/to/file.ts")
    }
  })

  it("uses the configured workspace cwd for cwd-relative search paths", async () => {
    const seenCwds: Array<string | undefined> = []
    const spawn: SpawnFn = (_cmd, opts) => {
      seenCwds.push(opts.cwd)
      return { stdout: Readable.from([]), stderr: null, exited: Promise.resolve(1) }
    }
    const cli = new AstGrepCli({ binary: "/fake/sg", spawn, cwd: "/workspace/project" })
    await cli.search({ pattern: "x", lang: "ts", paths: ["src"] })
    expect(seenCwds).toEqual(["/workspace/project"])
  })
})

describe("AstGrepCli.ensureBinary (re-review NH4)", () => {
  it("resolves the sg binary via the @ast-grep/cli package's bin field in a Bun workspace", async () => {
    // PR-B re-review (round 2, NH4): in a Bun workspace, the bin shim
    // `node_modules/.bin/sg` only exists at the *package* level
    // (e.g. packages/plugin/node_modules/.bin/sg), not at the workspace
    // root. The previous implementation only probed `process.cwd() +
    // node_modules/.bin/sg` and PATH, so when run from the workspace
    // root it returned "ast-grep CLI not found". The fix resolves the
    // binary by reading `@ast-grep/cli`'s `package.json#bin`.
    //
    // The repository ships `@ast-grep/cli` as a real dependency, so
    // ensureBinary() with no overrides must succeed in this test
    // environment without relying on PATH.
    const cli = new AstGrepCli()
    const resolved = await cli.ensureBinary()
    expect(resolved).toBeTruthy()
    // Resolved path should either be an absolute path that ends with
    // `sg` / `ast-grep`, OR one of the bare names if PATH lookup wins.
    // Either way, it must NOT be the empty string and the file must
    // actually exist when it's an absolute path.
    const isAbsolute = path.isAbsolute(resolved)
    if (isAbsolute) {
      const fs = await import("node:fs/promises")
      // Asserts the file is reachable; access() rejects on missing/unreadable.
      await fs.access(resolved)
    }
    // Sanity: the resolved value should reference the ast-grep binary
    // by name.
    expect(/sg$|ast-grep$/.test(resolved)).toBe(true)
  }, 10_000)
})

describe("AstGrepCli.ensureBinary", () => {
  it("returns the configured binary without probing", async () => {
    const cli = new AstGrepCli({
      binary: "/configured/sg",
      spawn: () => ({ stdout: Readable.from([]), stderr: null, exited: Promise.resolve(0) }),
    })
    expect(await cli.ensureBinary()).toBe("/configured/sg")
  })

  it("falls back to PATH `sg` when --version probe succeeds", async () => {
    const calls: string[][] = []
    const spawn: SpawnFn = (cmd) => {
      calls.push(cmd)
      // First candidate (node_modules path) likely doesn't exist; simulate failure code.
      // Second/third candidate succeed with code 0.
      const succeed = cmd[0] === "sg" || cmd[0] === "ast-grep"
      return {
        stdout: Readable.from([Buffer.from(succeed ? "0.30.0\n" : "")]),
        stderr: null,
        exited: Promise.resolve(succeed ? 0 : 127),
      }
    }
    const cli = new AstGrepCli({ spawn })
    const resolved = await cli.ensureBinary()
    expect(resolved === "sg" || resolved === "ast-grep" || resolved.endsWith("/sg")).toBe(true)
  })
})

describe("ast_grep_search tool context", () => {
  it("uses ToolContext.directory for relative paths", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "ag-tool-cwd-"))
    await mkdir(path.join(dir, "src"))
    await writeFile(path.join(dir, "src", "a.ts"), 'console.log("from context")\n')
    try {
      const result = await astGrepSearchTool.execute(
        { pattern: "console.log($MSG)", lang: "ts", paths: ["src"] },
        {
          sessionID: "ses_test",
          messageID: "msg_test",
          agent: "test",
          directory: dir,
          worktree: dir,
          abort: new AbortController().signal,
          metadata: () => {},
          ask: async () => {},
        },
      )
      const output = typeof result === "string" ? JSON.parse(result) : JSON.parse(result.output)
      expect(output.ok).toBe(true)
      expect(output.total).toBe(1)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }, 10_000)
})
