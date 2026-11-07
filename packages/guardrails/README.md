# Guardrails Distribution

This package is the thin internal distribution layer for the guardrails plan.

It should be understood as the Cor-Incorporated-specific layer that sits on top of upstream-compatible OpenCode, not as a separate reimplementation of the core runtime.

It keeps upstream OpenCode as the runtime and adds organization policy at the edges:

- `bin/opencode-guardrails` sets `OPENCODE_CONFIG_DIR` to the packaged profile and then runs the upstream 2.x CLI (`@opencode/cli`) on a private server — see Usage
- `managed/opencode.json` is the admin-managed profile for system deployment
- `profile/` contains the packaged custom config dir defaults, including `AGENTS.md`, `opencode.json`, and the guardrail plugin

## Design intent

This package exists to preserve the operating model imported from `claude-code-skills` without turning OpenCode into a deep fork.

- mechanism-first guardrails
- fast feedback before slower workflow gates
- pointer-based instructions instead of bloated always-loaded prompts
- runtime verifiability over "the code exists, so it must work"

Those principles come from `claude-code-skills` epic `#130` and are tracked in this fork under `specs/ai-guardrails-anti-patterns.md`.
They now also explicitly inherit Anthropic's `The Complete Guide to Building Skills for Claude` as the BDF-equivalent source for progressive disclosure, use-case-first design, and measurable testing discipline.

## Positioning

When describing this package or this fork externally, use wording close to:

- forked from OpenCode
- compatibility with upstream preserved where practical
- Cor-Incorporated-specific policy and workflow layer added in `packages/guardrails`

Avoid wording that implies this package replaces OpenCode itself. The intended architecture is still upstream engine plus thin internal distribution.

## Upstream strategy

- The fork `dev` is re-based on upstream `anomalyco/opencode` `dev` (2.x, `@opencode/cli`); this package is the only
  fork-owned code and it carries no core patches (2026-10-19 re-platform, Cor-Incorporated/opencode#342)
- Upgrade upstream first, then update this package only where the extension surface changed
- Prefer `managed/` and `profile/` assets over core patches

## 2.x plugin API (how the 1.x plugins run on upstream)

Upstream 2.x replaced the 1.x plugin API (`server(input) → hooks object`, `@opencode-ai/plugin`) with
`@opencode/plugin`'s `setup(ctx)` and per-domain registrations, and a configured local plugin is a **directory** whose
`index.ts` default-exports `{ id, setup }`. 2.x also auto-discovers every top-level `*.ts` under `<config dir>/plugins/`
as a plugin, so the 1.x sources moved to `profile/src/` and `profile/plugins/` holds only the two entry directories.
`profile/src/guardrail.ts` and `profile/src/team.ts` are kept in their 1.x shape (every policy test runs against them
unchanged); `profile/src/v2/` is the bridge:

| file                                                  | role                                                                                                                                                                                               |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/v2/adapter.ts`                                   | 1.x hook object → 2.x registrations (`session.hook` prompt/context/compaction, `tool.hook`, `shell.hook("create.before")`, `tool.transform`, `event.subscribe`). Mapping table in the file header. |
| `src/v2/client.ts`                                    | 1.x SDK-shaped `client.session.*` over `ctx.session.*` (create / promptAsync / prompt / messages / status / abort) for team.ts                                                                     |
| `src/v2/events.ts`                                    | session status derived from `session.status` / `session.execution.*` events (2.x has no status call in the plugin domain)                                                                          |
| `src/v2/tool.ts`                                      | 1.x `tool({ args: tool.schema.* })` helper emitting JSON Schema (no zod), defaults filled before `execute`                                                                                         |
| `src/v2/background.ts`                                | local copy of the 19-line `Background` registry team.ts used from core                                                                                                                             |
| `plugins/guardrail/index.ts`, `plugins/team/index.ts` | the directory entries listed in `profile/opencode.json` `plugins`                                                                                                                                  |

Tool vocabulary: 2.x renamed the built-in tools and their argument keys (`bash→shell`, `task→subagent`,
`write/patch→edit`; file tools take `path`, the subagent tool `agent`, the shell result `metadata.exit` — the same table
upstream applies to migrated v1 config in `packages/core/src/v1/config/migrate.ts`). The 1.x guards compare against the
old names, so the adapter translates every tool call to the 1.x shape before the hook and back afterwards
(`toV1Call` / `toV2Input`); a native `patch` is judged as one `edit` per touched path (move destinations included).
A 2.x tool resolves a relative `path`, patch path or shell `workdir` against `ctx.location.directory`, while the 1.x
guards resolve against `process.cwd()`; the two differ for a team worker moved into its own worktree on a server
started elsewhere, so the 1.x view carries those paths already absolute at the location. For a shell `workdir` other
than the session directory the runtime guard resolves the command's path tokens at that workdir instead of matching
`.opencode/guardrails/` text only (Cor-Incorporated/opencode#345). `guardrail-shell.ts` adds blocks on top of that and
never removes one (#349). When a command could change its directory (`cd` in any spelling, `pushd`/`popd`, CDPATH,
`-C`, `$(…)`), every path token counts as a possible base. The guard does not try to work out which `cd` ran. It also
blocks a dir-target writer (`cp`, `mv`, `rm`, `tar`, `find -delete`, …) that names the runtime or `.opencode`, a glob
that can match the runtime, and quoted code under `eval`, `sh -c` and inline interpreters. Such a command passes only
when every segment is read-only. A path no guard rewrote goes back to the tool as written.
The plugin keeps its state in `<session directory>/.opencode/guardrails` and team runs in
`<project root>/.opencode/guardrails/team-runs`. A session opened below the repo root has the two roots apart (core walks
up to `.git` for the project), so both are plugin-owned for file tools and for the shell check
(Cor-Incorporated/opencode#347). On a filesystem that folds case (APFS, NTFS) a case variant such as
`.OPENCODE/Guardrails/state.json` is the same file and is plugin-owned as well (#349).
Worker permission rules and the 1.x per-prompt `tools: { x: false }` lists go through the same mapping as 2.x
`permissions` (deny rules), and a worker
created with `parentID` is moved to its isolated directory afterwards because the 2.x host lets a child inherit the
parent's location.

Known gaps of the bridge (documented, not hidden): 2.x expands a command into a plain prompt and offers no wrap point
(`CommandEditor` only adds commands), so the five packaged command templates end with a marker
`<!-- guardrails:command=NAME -->` that the prompt hook recognises to run the 1.x `command.execute.before`
(`workflow_phase`, state summary); a command without the marker is only recognised as literal `/name` text.
`dropKeylessCatalogLanes` cannot mutate the live 2.x config and only shapes the whitelist. The provider gate runs on
the `context`, `compaction`, `generate` and `title` hooks and reads model cost/status from `ctx.model.list()`
(cached, misses included); a model missing from the catalog has unknown cost, which is not treated as free-tier.
`session.status` / `session.idle` have no publisher in 2.x core; worker status is derived from the
`session.execution.*` events and a failed execution is surfaced to team.ts as an errored assistant row.

Tests: `bun test profile/src profile/plugins` (from `packages/guardrails`). `src/v2/adapter.test.ts` drives the real v2
entries with a recording 2.x ctx; `src/plugin-loads.test.ts` pins the loader facts against upstream source.
Runtime settings use the native 2.x `providers` schema in both `opencode.json` copies. The plugin-owned allowlists
live separately in `profile/model-policy.json` and `managed/model-policy.json`; the guardrail entry reads the
packaged policy and enforces it on all four model request hooks. The policy must be a provider record covering every
provider declared by the same profile's native configuration; an array or partial policy keeps those hooks blocked
and records the denials. Explicitly configured additional providers can supply their own matching policy entries.
`src/native-config.test.ts` passes both runtime files through the real normalizer and requires zero
unsupported, invalid, or conflicting settings. Catalog synchronization updates the two policies and the `paid` sets
without changing runtime model overrides.

The catalog source is upstream's bundled models.dev catalog, `packages/core/src/models-dev/snapshot.txt`, which every
upstream sync brings along. Refresh with `python3 scripts/sync-model-whitelist.py --refresh-snapshot --apply` and
commit the snapshot and both policies together; the no-argument check (CI `guardrails` job) fails when that catalog has
a model the committed snapshot lacks. 2.x offers each `experimental.modes` entry as its own model id (`gpt-5.5-fast`),
so those ids are admitted with their model. For a model the catalog defines, runtime `providers` may only switch it
off (`disabled`); `model-whitelist.test.ts` fails on a fork-side copy of such a model, because the copy freezes its
prices and capabilities on the day it was made. Fork-only lanes (`cor-local`) keep their own model definitions.

## Current scope

Current contents focus on the first thin-distribution slice:

- packaged wrapper entrypoint
- managed enterprise defaults
- packaged custom config dir profile
- packaged plugin for runtime guardrail hooks
- guarded `implement` and `review` agents plus packaged `/implement`, `/review`, `/ship`, and `/handoff` workflow commands
- declarative provider admission policy for `zai-coding-plan`, `openai`, `deepseek`, and the isolated OpenRouter evaluation lane
- scenario coverage for managed config precedence, project-local asset compatibility, plugin behavior, and workflow safety defaults

Planned next slices are tracked in the fork:

- epic [#1](https://github.com/Cor-Incorporated/opencode/issues/1)
- MVP readiness epic [#16](https://github.com/Cor-Incorporated/opencode/issues/16)
- safe agents and commands [#5](https://github.com/Cor-Incorporated/opencode/issues/5)
- provider policy [#6](https://github.com/Cor-Incorporated/opencode/issues/6)
- scenario/replay harness [#7](https://github.com/Cor-Incorporated/opencode/issues/7)
- plugin hardening wave 2 [#13](https://github.com/Cor-Incorporated/opencode/issues/13)
- post-MVP CI and release gates [#14](https://github.com/Cor-Incorporated/opencode/issues/14)
- post-MVP broader asset migration [#12](https://github.com/Cor-Incorporated/opencode/issues/12)

## AI agent instrumentation quality gate

Historical note: a Traceability Matrix that pointed at a deleted instrumentation plugin (removed in #277) was retired from this README. Live push protection is implemented by `profile/src/guardrail-git.ts`. Acceptance evidence for anti-pattern work lives in `specs/ai-guardrails-anti-patterns.md`.

## Usage

Run the wrapper directly:

```sh
opencode-guardrails
```

What the wrapper does on the 2.x CLI (since the 2026-10-19 re-platform, #343):

- **CLI binary**: `OPENCODE_BIN_PATH`, else the first `opencode` on `PATH` that is not a wrapper around this launcher. A monorepo checkout is not used (`bun install` does not fetch the `@opencode/cli-*` binaries).
- **Private server**: server-backed commands get `--standalone` after the command leaf, and the TUI gets it first. Local configuration commands and server lifecycle commands pass through; `debug` leaves are checked against the selected CLI version. See [launcher arguments](./launcher-arguments.md). The background service retains its startup environment; `OPENCODE_GUARDRAILS_ALLOW_SERVICE=1` deliberately keeps that connection.
- **`run` stdin**: upstream `run` reads a non-TTY stdin to EOF before it starts, so a socket nobody closes (the stdio of a Node/libuv harness or an agent's shell tool) would hang it. For a socket stdin, input that starts within `OPENCODE_GUARDRAILS_STDIN_WAIT_MS` (default 1000) is read to EOF and passed on unchanged; with none by then the CLI gets an empty stdin and the launcher prints a one-line notice. This also holds with `OPENCODE_GUARDRAILS_ALLOW_SERVICE=1` and when no message argument is given (the CLI then stops with "You must provide a message" instead of waiting; upstream's own fix, anomalyco/opencode#61911, waits only when a message argument is given). Pipes, files, terminals and help/version requests are left to the CLI. Retire it once the CLI includes #61911. See `bin/run-stdin.js`.
- **Config layering**: in 2.x `OPENCODE_CONFIG_DIR` _replaces_ the global config directory, so the user's global `opencode.json(c)` is handed back through `OPENCODE_CONFIG`. Extra plugin directories (for example the AIDD H17 control) go in `OPENCODE_GUARDRAILS_EXTRA_PLUGINS` (`:`-separated) and are merged into `OPENCODE_CONFIG_CONTENT`.
- On this Mac the entry point is `~/.local/bin/opencode` → `opencode2` (claude-code-skills `opencode/launcher/opencode2`), which calls this wrapper from the main checkout.

Paths under `packages/opencode/src/…` cited further below describe the 1.x runtime the fork ran before the re-platform; that package no longer exists upstream.

It respects an existing `OPENCODE_CONFIG_DIR` so project- or environment-specific overrides can still replace the packaged profile when needed.

The packaged profile defaults to the `implement` agent. Review and release-readiness work should run through the packaged `/review`, `/ship`, and `/handoff` commands so the workflow stays read-only at the gate layer.

Provider admission is packaged here. Standard work is admitted on `zai-coding-plan`, `openai`, and `deepseek`;
OpenRouter remains available for multi-vendor routing and evaluation. Native `provider.use` policies enumerate the
admitted providers. Model allowlists remain an independent request gate in `model-policy.json`. The `zai` platform
lane (`api.z.ai/api/paas/v4`) is excluded from both provider admission and model policy; enabling it requires its own
Standard API credential and billing entitlement.

## Z.AI Coding Plan credentials and model access

[Z.AI's OpenCode guide](https://docs.z.ai/devpack/tool/opencode) requires the `Z.AI Coding Plan` integration and the
Coding endpoint `https://api.z.ai/api/coding/paas/v4`. The provider ID and endpoint alone do not establish the key's
scope. The API Keys management page separates **Standard** and **Personal Coding Plan** keys; keys issued in the
Standard tab since 2026-10-16 are for the Standard API. Select an existing key from **Personal Coding Plan** and use
`opencode auth login --standalone` with `Z.AI Coding Plan`. Keep the key out of logs and repository files.

Error `1113` can therefore occur with the correct endpoint when a Standard-only key is stored under the Coding Plan
integration. The account quota API returning a plan level or unused quota does not prove that key can make Coding
Plan model requests. Check the key scope and a bounded request through OpenCode before concluding that funds are
missing. See the [official FAQ](https://docs.z.ai/devpack/faq).

Model access is a separate entitlement. `glm-5.3` is the default; `glm-5.2-highspeed` and `glm-5.3-highspeed` are
disabled in native configuration because a Coding Plan subscription does not by itself establish Highspeed access.
A correct Coding Plan key can still receive `1311` stating that the current subscription excludes Highspeed. After
confirming the account's Highspeed entitlement, an explicit user or project override can enable that model:

```json
{
  "providers": {
    "zai-coding-plan": {
      "models": {
        "glm-5.3-highspeed": { "disabled": false }
      }
    }
  }
}
```

The allowlist retains the model ID so this explicit opt-in still passes the request gate. Catalog synchronization
changes only admission policy data and cannot remove the native `disabled` defaults.

## ZHIPU_API_KEY (z.ai lane credential bridge)

`zai` and `zai-coding-plan` declare the same catalog environment variable, `ZHIPU_API_KEY`. That shared name does not
make credentials interchangeable between the two products.

`bin/zai-auth-env.js` is a legacy `auth.json` compatibility helper imported by the launcher. It does not read the
2.x credential database, and its selection cannot establish a key's product entitlement. In 2.x, saved active
integration credentials take precedence over an environment credential; changing an environment variable does not
replace the selected account. Use the native authentication commands to select the intended credential. Legacy
helper behavior is covered by `profile/src/zai-auth-bin-defaults.test.ts`.

`model-whitelist.test.ts` pins the exclusion of the platform lane in both runtime files and policies. The legacy
`dropKeylessCatalogLanes` helper only shapes admission data; it does not remove models from the native 2.x picker.

## cor-local (ローカル lane)

`cor-local` is an opt-in provider for the company's `llama-server` router exposing an OpenAI-compatible endpoint, today
`http://100.91.85.86:18082/v1` on EVO-X2 (`evo-x2`, Tailscale only, key required). Set `COR_LOCAL_BASE_URL` to that
address: the loopback default `http://127.0.0.1:18082/v1` (below) reaches no router on any machine today. Both runtime
files use `@opencode/ai/providers/openai-compatible` with the same model settings. It does not change the default model
(`zai-coding-plan/glm-5.3`).

### baseURL / apiKey (env vars)

`settings.baseURL` and `settings.apiKey` use `{env:COR_LOCAL_BASE_URL}` / `{env:COR_LOCAL_API_KEY}` substitutions so the
router address and authentication stay outside the repository.

`{env:VAR}` resolves an _unset_ variable to `""` unconditionally (`variable.ts`'s `substitute()` never errors on a missing env var, unlike `{file:...}`), so an empty `COR_LOCAL_BASE_URL` would break every cor-local call the moment this change lands. `packages/guardrails/bin/opencode-guardrails` — the single Node entry point that runs before every invocation (managed deploy, the deployed live wrapper, and a direct `opencode-guardrails` call alike) — is the layer that keeps that from happening, via `packages/guardrails/bin/cor-local-env.js`:

- `COR_LOCAL_BASE_URL` defaults to `http://127.0.0.1:18082/v1` when unset or empty. A project `.env` (loaded earlier in the entry point) or an exported shell value both win over this default.
- `COR_LOCAL_API_KEY`, when unset or empty, is read from a key file: `COR_LOCAL_KEY_FILE` if set, else `~/cluster-ops/cor-local.key`. The file must be owner-only permissions (`chmod 600`) and contain exactly one line matching `[A-Za-z0-9._~+/=-]+` — because `{env:VAR}` splices raw, unescaped bytes into the JSON config text (unlike `{file:...}`, which is `JSON.stringify`-escaped), a key containing `"`, `\`, or a newline would corrupt the whole config and take down every provider, not just cor-local. A file that fails validation is ignored with `cor-local: key file ignored (invalid format)` on stderr — the warning never includes the file's contents.

`@ai-sdk/openai-compatible` only adds an `Authorization: Bearer ...` header when `apiKey` is a non-empty string (`...options.apiKey && { Authorization: ... }`), so with `apiKey` resolving to `""` no header is sent. The EVO-X2 router requires the key (`--api-key-file`), so such requests are rejected; only a keyless router would accept them. This defaulting is covered by `packages/guardrails/profile/src/cor-local-bin-defaults.test.ts`, which unit-tests `cor-local-env.js` directly and runs the real `bin/opencode-guardrails` entry point against a stub binary to prove the `.env`-vs-default ordering, offline.

**`opencode debug config` prints the resolved config, including the substituted `apiKey` — never paste its output into a GitHub issue or share it outside a private channel.**

Key rotation: replace `~/cluster-ops/cor-local.key`'s contents (owner-only permissions) and every subsequent `opencode-guardrails` invocation picks up the new key — no redeploy needed. To point at a different file instead, set `COR_LOCAL_KEY_FILE=/path/to/key` before invoking.

MacBook usage (the router runs on EVO-X2 `evo-x2`, bound to its Tailscale address only — ai-cluster ADR-0023,
`docs/03-runbooks/evo-x2-shared-llm-router.md`; no `tailscale serve`):

```sh
export COR_LOCAL_BASE_URL=http://100.91.85.86:18082/v1
opencode run --model cor-local/qwen3.8-27b "..."
```

No key export is needed: the key is read from `~/cluster-ops/cor-local.key` when `COR_LOCAL_API_KEY` is unset, including under a managed deploy. Do not type the key into a shell (it lands in the history). The Mac Studio router this lane used until 2026-10 is retired.

Three model ids are whitelisted: `ornith-1.5-35b-a3b`, `qwen3.6-35b-a3b`, `qwen3.8-27b`. All three report cost 0 (self-hosted, no billing) but are classified in `profile/src/guardrail-patterns.ts`'s `paid["cor-local"]` set so the `denyFree` guardrail does not mistake "no cost" for "free tier" and block them. `denyPreview` first checks `status !== "active"` (config-defined models default to `active`, see `provider.ts`'s config-provider merge) and only then tests the id against `/(preview|alpha|beta|exp|experimental|:free\b|\bfree\b)/i` — none of the three ids trip either check.

Usage:

```sh
opencode run --model cor-local/qwen3.6-35b-a3b "..."
```

or, in a project `opencode.json`:

```json
{ "model": "cor-local/qwen3.6-35b-a3b" }
```

Vendor-egress-free recipe (no model-vendor calls, no auto-update, no telemetry; requests still go over Tailscale to the EVO-X2 router):

```sh
OPENCODE_DISABLE_MODELS_FETCH=1 OPENCODE_DISABLE_AUTOUPDATE=1 opencode run --model cor-local/qwen3.6-35b-a3b "..."
```

`share` is already `disabled` in both guardrails profiles, so no extra flag is needed for that.

Cold-start note: the router loads models on first request. `settings.headerTimeout` is 900000ms, `settings.timeout`
is `false`, and `settings.chunkTimeout` is 120000ms, bounding stalled streams separately from cold loading.
`compatibility.reasoningField` preserves `reasoning_content`; native `capabilities.reasoning` declares the effort
controls. Context window is 131072 tokens per request and maximum output is 16384 tokens.

`limit.context` (131072) must equal one request's share of the router's context: `-c 262144` split over `-np 2` slots without kv-unified (ai-cluster repo, `config/llama-router/evo1-router.yaml`, rendered by `scripts/cluster-ops/evo_router.py`; its `evo1-router.clients.json` is the source of this block). Until 2026-11-06 this said 262144, although from 2026-09-13 (ai-cluster #389, requested in #385) the Mac Studio router (`config/llama-router/cor-local.ini.template`) also split 262144 over 2 slots. The block is copied from ai-cluster Cor-Incorporated/ai-cluster#614 (`evo1-router.clients.json`, unchanged since `e7b52063`); `scripts/cluster-ops/evo_router.py client-diff <this opencode.json>` there prints `no difference` when the two agree. They were at 32768 through 2026-09-02 and at 65536 from 2026-09-03 to 2026-09-07 (raised because a trivial two-line edit session on glm53-flash consumed 62% of the 64k window; opencode auto-compacts at `context - limit.output`, so the usable working window was only ~25K after the AGENTS.md/system prompt/tool schemas); with the guardrails profile's AGENTS.md (15.6KB) plus system prompt and tool schemas already eating into the window, the mismatch made opencode auto-compact after every single step (`packages/opencode/src/session/compaction.ts`'s synthetic "Continue if you have next steps…"), and both `qwen3.8-27b` and `glm53-flash` looped re-planning without terminating even after fixing the target bug. If you change the router's `-c` value, update `limit.context` in both `managed/opencode.json` and `profile/opencode.json` to match — `model-whitelist.test.ts` pins both to 131072.

Offline verification: from `packages/guardrails`, run `bun run test:ci` for the guardrail tests and catalog snapshot
consistency check across the two admission policies and `paid` sets. These checks make no model requests.

## cor-os (Cor OS router lane)

`cor-os` reaches the Cor OS router at `https://llm.cor-jp.com/v1` (OpenAI-compatible, behind Cloudflare Access / Tunnel). The router checks the requested model name against what it publishes, so `cor-local` cannot be pointed at it: the guardrail admits only cor-local's three llama-server ids and the router answers `model_not_found` for them. The model definitions come from the ai-cluster repo (`ops/opencode-pi/cor-os-models.json`); in 2.x the block is the native `providers["cor-os"]` entry in both `managed/opencode.json` and `profile/opencode.json`, `provider.use` allows it in their `policies`, and both `model-policy.json` copies admit its ids. `profile/src/cor-os-router-lane.test.ts` pins all of them and runs the block through the real normalizer.

- `settings.apiKey` is `{env:COR_OS_LLM_TOKEN_NEXT}` (the router's Bearer; the owner keeps it in Bitwarden as `env/common/COR_OS_LLM_TOKEN_NEXT` and exports it with `eval "$(~/Developer/bin/bwenv env COR_OS_LLM_TOKEN_NEXT)"`). Unset, the substitution is "" and the 2.x resolver drops the empty key (core `model-resolver.ts` `prepareRuntimeModel`), so no token is sent; whether the request then fails locally or reaches the router unauthenticated has not been measured.
- Two public aliases are admitted: `cor-qwen3.6-35b` and `gemma4-12b` (cor-os `a43df4e`; which of them production publishes is confirmed with ai-cluster `ops/opencode-pi/verify_router.py`). Both are in `paid["cor-os"]` for the same reason as cor-local.
- `limit.context` is 32768, the production runner's `-c 32768 -np 1`. OpenCode's first agent request with this profile is about 125 KB (two thirds of it the skills catalog), which is over the `context - limit.output` budget, so at 32768 OpenCode sends a compaction request before the model ever sees the question; the context has to grow on the router side before this lane is usable for agent work (ai-cluster L2).

```sh
opencode run --model cor-os/cor-qwen3.6-35b "..."
```

## Managed deployment

Copy [managed/opencode.json](/Users/teradakousuke/Developer/opencode/packages/guardrails/managed/opencode.json) into the system managed config directory:

- macOS: `/Library/Application Support/opencode/opencode.json`
- Linux: `/etc/opencode/opencode.json`
- Windows: `%ProgramData%\\opencode\\opencode.json`

For macOS MDM deployments, use the same keys in the `ai.opencode.managed` payload that OpenCode already reads through managed preferences.
