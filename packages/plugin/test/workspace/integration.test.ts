/**
 * End-to-end integration smoke tests.
 *
 * Skipped by default. Set INTEGRATION_TESTS=1 to run.
 *
 * Requires:
 *   - `typescript-language-server` and `typescript` available on PATH
 *   - `sg` (ast-grep CLI) available on PATH
 */

import { describe, expect, it, beforeAll } from "bun:test"
import { mkdtemp, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import { runDiagnostics } from "../../src/tools/workspace/lsp/diagnostics.js"
import { runAstGrepSearch } from "../../src/tools/workspace/astgrep/search.js"

const RUN = process.env["INTEGRATION_TESTS"] === "1"
const dsuite = RUN ? describe : describe.skip

dsuite("integration", () => {
  let workdir: string

  beforeAll(async () => {
    workdir = await mkdtemp(path.join(tmpdir(), "ws-int-"))
    // Minimal TS project with a deliberate type error.
    await writeFile(path.join(workdir, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true, target: "es2022" } }))
    await writeFile(path.join(workdir, "bug.ts"), "const x: number = 'string'\nconsole.log(x)\n")
  })

  it("lsp_diagnostics returns at least one error for an obvious type bug", async () => {
    const result = await runDiagnostics(path.join(workdir, "bug.ts"))
    // PR-B re-review (round 2, NM2): when this assertion fires in CI it
    // is invariably because `typescript-language-server` is not
    // installed. Surface result.error so the failure log is actionable
    // instead of just "expected true to be false".
    if (!result.ok) {
      // eslint-disable-next-line no-console
      console.error("[integration] runDiagnostics failed:", result.error)
    }
    expect(result.ok).toBe(true)
    expect((result.diagnostics ?? []).some((d) => d.severity === "error")).toBe(true)
    await rm(workdir, { recursive: true, force: true })
  })

  it("ast_grep_search finds console.log calls", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "ag-int-"))
    await writeFile(path.join(dir, "a.ts"), 'console.log("hi")\nconsole.log(42)\n')
    const result = await runAstGrepSearch({
      pattern: "console.log($MSG)",
      lang: "ts",
      paths: [dir],
    })
    // PR-B re-review (round 2, NM2): same diagnostic enhancement for the
    // ast-grep path. CI failures here are usually `sg` not on PATH or a
    // pattern compile error — print the message so reviewers can act.
    if (!result.ok) {
      // eslint-disable-next-line no-console
      console.error("[integration] runAstGrepSearch failed:", result.error)
    }
    expect(result.ok).toBe(true)
    expect(result.total).toBeGreaterThanOrEqual(2)
    await rm(dir, { recursive: true, force: true })
  })
})
