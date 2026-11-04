// Temporary factor experiment, outside the normal production test directories.
import { expect, test } from "bun:test"
import { diagnose } from "./windows-acl-transport.mjs"

for (const restore of ["PSModulePath", "LOCALAPPDATA", "both"]) {
  for (const transport of ["bun", "node24"]) {
    for (const stage of ["Set-Acl", "Get-Acl"]) {
      test.skipIf(process.platform !== "win32")(
        "Windows ACL environment factor " + restore + " " + transport + " " + stage,
        () => {
          const result = diagnose(stage, transport, restore)
          console.log("ACL_ENVIRONMENT " + JSON.stringify({ transport, ...result }))
          expect(result.errorCode).toBeUndefined()
          expect(result.status).toBe(0)
        },
      )
    }
  }
}
