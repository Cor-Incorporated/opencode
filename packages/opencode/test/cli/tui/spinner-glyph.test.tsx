/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { SpinnerGlyph } from "../../../src/cli/cmd/tui/component/spinner-glyph"

test("spinner glyph renders without a custom spinner component registration", async () => {
  const app = await testRender(() => <SpinnerGlyph frames={["ab"]} interval={1000} color="white" />, {
    width: 4,
    height: 1,
  })

  try {
    await app.renderOnce()
    expect(app.captureCharFrame()).toContain("ab")
  } finally {
    app.renderer.destroy()
  }
})
