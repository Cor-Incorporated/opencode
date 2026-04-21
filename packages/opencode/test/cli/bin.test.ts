import { expect, test } from "bun:test"
import path from "path"

test("bin wrapper runs under node in an ESM package", async () => {
  const proc = Bun.spawn(["node", path.resolve(import.meta.dir, "../../bin/opencode"), "--help"], {
    env: {
      ...process.env,
      OPENCODE_DISABLE_DEFAULT_PLUGINS: "1",
    },
    stdout: "pipe",
    stderr: "pipe",
  })
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])

  expect(code).toBe(0)
  expect(err).not.toContain("ReferenceError: require is not defined")
  expect(out + err).not.toContain("ReferenceError")
})
