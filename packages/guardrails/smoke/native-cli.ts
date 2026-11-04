// Explicit, local-only acceptance harness. Unlike adapter unit tests, this runs
// the installed CLI, production launcher, actual profile and AIDD plugin loader.
import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const args = process.argv.slice(2)
const option = (name: string, fallback: string) => {
  const i = args.indexOf(name)
  if (i === -1) return fallback
  if (!args[i + 1] || args[i + 1].startsWith("--")) throw new Error(`${name} needs a path`)
  return args[i + 1]
}
const profile = path.resolve(option("--profile", fileURLToPath(new URL("../profile", import.meta.url))))
const cli = path.resolve(option("--cli", path.join(os.homedir(), ".opencode-2/pkg/node_modules/.bin/opencode")))
const launcher = path.resolve(option("--launcher", path.join(os.homedir(), ".local/bin/opencode")))
const plugin = path.resolve(option("--aidd-plugin", path.join(os.homedir(), ".config/opencode/plugins/aidd-cc-v2")))
const oracle = path.resolve(option("--aidd-oracle", path.join(os.homedir(), ".claude/hooks/lib/aidd_cc.py")))
const guard = realpathSync(
  path.resolve(option("--guard", fileURLToPath(new URL("../bin/opencode-guardrails", import.meta.url)))),
)
const destination = option("--out", "")
const out = destination ? path.resolve(destination) : mkdtempSync(path.join(os.tmpdir(), "opencode-native-fire-"))
if (existsSync(out) && readdirSync(out).length > 0) throw new Error("--out must be empty; retain prior run evidence")
for (const file of [path.join(profile, "opencode.json"), cli, launcher, guard, path.join(plugin, "index.ts"), oracle]) {
  if (!existsSync(file)) throw new Error(`required runtime is missing: ${file}`)
}
mkdirSync(out, { recursive: true, mode: 0o700 })
const hash = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex")
const profileFiles = (directory: string): string[] =>
  readdirSync(directory, { withFileTypes: true })
    .flatMap((item) =>
      ["node_modules", "service.json"].includes(item.name)
        ? []
        : item.isDirectory()
          ? profileFiles(path.join(directory, item.name))
          : [path.join(directory, item.name)],
    )
    .sort()
const oracleFiles = readdirSync(path.dirname(oracle)).filter(
  (name) => name === path.basename(oracle) || name === "aidd-cc-adapter.sh" || /^aidd_cc.*\.(py|md)$/.test(name),
)
const manifests = {
  profile: profileFiles(profile).map((file) => ({ path: path.relative(profile, file), sha256: hash(file) })),
  oracle: oracleFiles.map((name) => ({ path: name, sha256: hash(path.join(path.dirname(oracle), name)) })),
  runtime: [
    cli,
    launcher,
    path.join(plugin, "index.ts"),
    guard,
    ...["standalone-args.js", "zai-auth-env.js", "cor-local-env.js"].map((name) =>
      path.join(path.dirname(guard), name),
    ),
  ].map((file) => ({ path: file, sha256: hash(file) })),
}
const manifest = path.join(out, "sources.json")
writeFileSync(manifest, JSON.stringify({ schemaVersion: 1, profile, oracle, ...manifests }, null, 2) + "\n")
const rows = (file: string): Record<string, unknown>[] =>
  existsSync(file)
    ? readFileSync(file, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    : []
const journals = (dir: string): Record<string, unknown>[] =>
  existsSync(dir)
    ? readdirSync(dir, { withFileTypes: true }).flatMap((item) =>
        item.isDirectory()
          ? journals(path.join(dir, item.name))
          : item.name.endsWith(".jsonl")
            ? rows(path.join(dir, item.name))
            : [],
      )
    : []

type ChatRequest = {
  model: string
  stream?: boolean
  tools?: { function?: { name?: string } }[]
  messages?: { role?: string; tool_call_id?: string; content?: unknown }[]
}
type Case = "deny" | "partial"
let current: Case = "deny"
let step = 0
const requests: Record<string, unknown>[] = []
const results = new Map<string, string>()
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    if (new URL(request.url).pathname !== "/v1/chat/completions")
      return new Response("unexpected path", { status: 404 })
    const body = (await request.json()) as ChatRequest
    const tools = body.tools?.map((tool) => tool.function?.name).filter(Boolean) ?? []
    const returned = (body.messages ?? []).filter((message) => message.role === "tool")
    for (const message of returned) {
      if (message.tool_call_id)
        results.set(
          message.tool_call_id,
          typeof message.content === "string" ? message.content : JSON.stringify(message.content),
        )
    }
    const main = tools.includes("shell")
    requests.push({ case: current, model: body.model, main, tools, returned })
    const i = main ? step++ : -1
    if (step > 9) return new Response("bounded harness request limit reached", { status: 429 })
    const commands =
      current === "deny"
        ? [
            "echo ALLOW_SENTINEL",
            "echo forbidden > .opencode/guardrails/violation.txt",
            ...Array(4).fill("bun test tests/fail.test.ts"),
          ]
        : ["echo PARTIAL_SENTINEL"]
    const command = commands[i]
    const tool =
      command === undefined
        ? undefined
        : {
            id: `call_${current}_${i}`,
            type: "function",
            function: { name: "shell", arguments: JSON.stringify({ command }) },
          }
    const text = !main
      ? "Local smoke"
      : current === "deny" && i === commands.length
        ? "実装完了しました。"
        : "Status: partial"
    const message = tool
      ? { role: "assistant", content: null, tool_calls: [tool] }
      : { role: "assistant", content: text }
    const base = { id: `smoke_${current}_${i}`, created: Math.floor(Date.now() / 1000), model: body.model }
    if (!body.stream)
      return Response.json({
        ...base,
        object: "chat.completion",
        choices: [{ index: 0, message, finish_reason: tool ? "tool_calls" : "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
      })
    const delta = tool
      ? { role: "assistant", tool_calls: [{ index: 0, ...tool }] }
      : { role: "assistant", content: text }
    return new Response(
      [
        { ...base, object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: null }] },
        {
          ...base,
          object: "chat.completion.chunk",
          choices: [{ index: 0, delta: {}, finish_reason: tool ? "tool_calls" : "stop" }],
          usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
        },
      ]
        .map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`)
        .join("") + "data: [DONE]\n\n",
      { headers: { "content-type": "text/event-stream" } },
    )
  },
})

const run = (directory: string, env: Record<string, string>) =>
  new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(
      launcher,
      [
        "run",
        "--model",
        "cor-local/glm53-flash",
        "--format",
        "json",
        "--title",
        `native smoke ${current}`,
        "Run the local acceptance fixture. Tool failures in this bounded negative-control test are intentional.",
      ],
      {
        cwd: directory,
        env,
        stdio: ["ignore", "pipe", "pipe"],
        detached: process.platform !== "win32",
      },
    )
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (value) => {
      stdout += value
    })
    child.stderr.on("data", (value) => {
      stderr += value
    })
    const deadline = setTimeout(() => {
      if (child.pid && process.platform !== "win32") process.kill(-child.pid, "SIGTERM")
      else child.kill("SIGTERM")
    }, 90_000)
    child.on("error", (error) => {
      clearTimeout(deadline)
      reject(error)
    })
    child.on("close", (code) => {
      clearTimeout(deadline)
      resolve({ code, stdout, stderr })
    })
  })

const all: Record<string, unknown>[] = []
try {
  for (const scenario of ["deny", "partial"] as const) {
    current = scenario
    step = 0
    const root = path.join(out, scenario)
    const home = path.join(root, "home")
    const project = path.join(home, "project")
    const copied = path.join(home, "profile")
    mkdirSync(path.join(project, "tests"), { recursive: true })
    cpSync(profile, copied, {
      recursive: true,
      filter: (file) => !["node_modules", "service.json"].includes(path.basename(file)),
    })
    const ledger = path.join(home, "guard-ledger.jsonl")
    const state = path.join(home, "aidd-state")
    const copiedOracle = path.join(home, "oracle", path.basename(oracle))
    mkdirSync(path.dirname(copiedOracle), { recursive: true })
    // -I ignores PYTHONDONTWRITEBYTECODE. Copy the deployed sources unchanged so
    // Python's bytecode cache also stays under the scratch HOME.
    for (const name of oracleFiles)
      cpSync(path.join(path.dirname(oracle), name), path.join(path.dirname(copiedOracle), name))
    const oracleCopiedExactly = manifests.oracle.every(
      (file) =>
        file.sha256 === hash(path.join(path.dirname(oracle), file.path)) &&
        file.sha256 === hash(path.join(path.dirname(copiedOracle), file.path)),
    )
    writeFileSync(
      path.join(project, "tests/fail.test.ts"),
      `import { test, expect } from "bun:test"; import { appendFileSync } from "node:fs"; test("intentional negative control", () => { appendFileSync("executions.txt", "attempt\\n"); expect(1).toBe(0) })\n`,
    )
    const env = {
      PATH: process.env.PATH ?? "",
      HOME: home,
      XDG_CONFIG_HOME: path.join(home, "config"),
      XDG_DATA_HOME: path.join(home, "data"),
      XDG_STATE_HOME: path.join(home, "state"),
      XDG_CACHE_HOME: path.join(home, "cache"),
      OPENCODE_BIN_PATH: cli,
      OPENCODE_GUARDRAILS_BIN: guard,
      OPENCODE_CONFIG_DIR: copied,
      OPENCODE_DISABLE_MODELS_FETCH: "1",
      COR_LOCAL_BASE_URL: `http://127.0.0.1:${server.port}/v1`,
      COR_LOCAL_API_KEY: "local-smoke-nonsecret",
      AIDD_CC_V2_PLUGIN: plugin,
      AIDD_CC_PY: copiedOracle,
      AIDD_CC_STATE_DIR: state,
      AIDD_LEDGER_PATH: ledger,
      AIDD_LEDGER_SOURCE: "test",
    }
    console.log(`RUN: native CLI ${scenario}; artifacts=${root}`)
    const processResult = await run(project, env)
    writeFileSync(path.join(root, "stdout.jsonl"), processResult.stdout)
    writeFileSync(path.join(root, "stderr.log"), processResult.stderr)
    const deadline = Date.now() + 30_000
    while (
      !rows(ledger).some(
        (row) => row.component === "H17" && row.rule === (scenario === "deny" ? "evidence" : "evidence.status-partial"),
      ) &&
      Date.now() < deadline
    )
      await Bun.sleep(100)
    const h17 = rows(ledger)
    const profileRows = rows(path.join(project, ".opencode/guardrails/events.jsonl"))
    const toolRows = journals(state)
    const observed =
      scenario === "deny"
        ? {
            cli: processResult.code === 0,
            allowedShell:
              results.get("call_deny_0")?.includes("ALLOW_SENTINEL") === true &&
              toolRows.some(
                (row) => row.event === "post" && row.rc === 0 && String(row.out_sample).includes("ALLOW_SENTINEL"),
              ),
            profileReject:
              !existsSync(path.join(project, ".opencode/guardrails/violation.txt")) &&
              profileRows.some(
                (row) => row.type === "guardrail.block" && row.reason === "protected runtime or config mutation",
              ),
            iterationReject:
              h17.some(
                (row) => row.component === "H17" && row.rule === "iter.repeat-without-delta" && row.decision === "deny",
              ) &&
              results.get("call_deny_5")?.includes("[H17]") === true &&
              readFileSync(path.join(project, "executions.txt"), "utf8").split("\n").filter(Boolean).length === 3,
            completionReject: h17.some(
              (row) =>
                row.component === "H17" &&
                row.rule === "evidence" &&
                row.decision === "deny" &&
                String(row.cmd_head).includes("no status declared"),
            ),
          }
        : {
            cli: processResult.code === 0,
            allowedShell: results.get("call_partial_0")?.includes("PARTIAL_SENTINEL") === true,
            declaredPartial: h17.some(
              (row) => row.component === "H17" && row.rule === "evidence.status-partial" && row.decision === "allow",
            ),
          }
    const result = {
      case: scenario,
      ...observed,
      h17Unavailable: h17.filter((row) => row.component === "H17" && row.decision === "unavailable").length,
      profileConfigCopiedExactly:
        hash(path.join(profile, "opencode.json")) === hash(path.join(copied, "opencode.json")),
      profileSourcesCopiedExactly: manifests.profile.every(
        (file) =>
          file.sha256 === hash(path.join(profile, file.path)) && file.sha256 === hash(path.join(copied, file.path)),
      ),
      runtimeSourcesUnchanged: manifests.runtime.every((file) => file.sha256 === hash(file.path)),
      oracleCopiedExactly,
    }
    all.push(result)
    console.log(JSON.stringify(result))
  }
} finally {
  server.stop(true)
  writeFileSync(path.join(out, "requests.json"), JSON.stringify(requests, null, 2) + "\n")
  writeFileSync(
    path.join(out, "results.json"),
    JSON.stringify(
      {
        profile,
        cli,
        launcher,
        guard,
        plugin,
        oracle,
        sourceHashes: {
          profile: hash(path.join(profile, "opencode.json")),
          aiddPlugin: hash(path.join(plugin, "index.ts")),
          oracle: hash(oracle),
          manifest: hash(manifest),
        },
        results: all,
      },
      null,
      2,
    ) + "\n",
  )
}
const passed =
  all.length === 2 &&
  all.every((row) =>
    Object.entries(row).every(([key, value]) =>
      key === "case" || key === "h17Unavailable" ? key !== "h17Unavailable" || value === 0 : value === true,
    ),
  )
console.log(
  `${passed ? "PASS" : "FAIL"}: native CLI + profile enforcement + AIDD iteration/completion; artifacts=${out}`,
)
process.exit(passed ? 0 : 1)
