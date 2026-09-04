import { expect, test } from "bun:test"
import { guardrail } from "../../../../packages/guardrails/profile/plugins/guardrail"
import { tmpdir } from "../fixture/fixture"

test("guardrail masks secrets from bash output", async () => {
  await using tmp = await tmpdir()
  const plugin = await guardrail(
    {
      client: {
        session: {
          async create() {
            return { data: { id: "unused" } }
          },
          async promptAsync() {
            return {}
          },
          async prompt() {
            return {}
          },
          async status() {
            return { data: {} }
          },
          async messages() {
            return { data: [] }
          },
          async abort() {
            return {}
          },
        },
      },
      directory: tmp.path,
      worktree: tmp.path,
    },
    {},
  )

  const out = {
    title: "bash",
    output: [
      "AWS_ACCESS_KEY_ID=AKIA1234567890ABCDEF",
      "OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwxyz",
      "safe output",
    ].join("\n"),
    metadata: { exitCode: 0 },
  }

  await plugin["tool.execute.after"](
    { tool: "bash", args: { command: "echo secrets" } },
    out,
  )

  expect(out.output).toContain("[REDACTED:aws-access-key]")
  expect(out.output).toContain("[REDACTED:openai-key]")
  expect(out.output).toContain("safe output")
  expect(out.output).not.toContain("AKIA1234567890ABCDEF")
  expect(out.output).not.toContain("sk-abcdefghijklmnopqrstuvwxyz")
  expect(await Bun.file(`${tmp.path}/.opencode/guardrails/events.jsonl`).text()).toContain("secret_masked")
})
