// Temporary Windows-only transport diagnosis for #366; the real ACL tests remain unchanged.
import { expect, test } from "bun:test"
import { diagnose } from "../../bin/windows-acl-transport.mjs"

for (const transport of ["bun", "node24"]) {
  for (const stage of ["exit 0", "Set-Acl", "Get-Acl"]) {
    test.skipIf(process.platform !== "win32")(`Windows ACL transport ${transport} ${stage}`, () => {
      const result = diagnose(stage, transport)
      console.log(`ACL_TRANSPORT ${JSON.stringify({ transport, ...result })}`)
      expect(result.errorCode).toBeUndefined()
      expect(result.status).toBe(0)
    })
  }
}
