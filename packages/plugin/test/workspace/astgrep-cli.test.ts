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
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { Readable } from "node:stream"

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
    const cli = new AstGrepCli({ binary: "/fake/sg", spawn: () => ({ stdout: Readable.from([]), stderr: null, exited: Promise.resolve(0) }) })
    const args = cli.buildSearchArgs({ pattern: "console.log($MSG)", lang: "ts" })
    expect(args).toEqual(["run", "--pattern", "console.log($MSG)", "--lang", "ts", "--json=stream"])
  })

  it("includes context, globs, paths, rewrite, --update-all", () => {
    const cli = new AstGrepCli({ binary: "/fake/sg", spawn: () => ({ stdout: Readable.from([]), stderr: null, exited: Promise.resolve(0) }) })
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
    const cli = new AstGrepCli({ binary: "/fake/sg", spawn: () => ({ stdout: Readable.from([]), stderr: null, exited: Promise.resolve(0) }) })
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
})

describe("AstGrepCli.ensureBinary", () => {
  it("returns the configured binary without probing", async () => {
    const cli = new AstGrepCli({ binary: "/configured/sg", spawn: () => ({ stdout: Readable.from([]), stderr: null, exited: Promise.resolve(0) }) })
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
