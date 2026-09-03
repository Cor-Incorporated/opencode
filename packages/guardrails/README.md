# Guardrails Distribution

This package is the thin internal distribution layer for the guardrails plan.

It should be understood as the Cor-Incorporated-specific layer that sits on top of upstream-compatible OpenCode, not as a separate reimplementation of the core runtime.

It keeps upstream OpenCode as the runtime and adds organization policy at the edges:

- `bin/opencode-guardrails` sets `OPENCODE_CONFIG_DIR` to the packaged profile and then delegates to the pinned `opencode` dependency
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

- Keep this package version aligned with `packages/opencode/package.json`
- Upgrade upstream first, then update this package only where the extension surface changed
- Prefer `managed/` and `profile/` assets over core patches

## Current scope

Current contents focus on the first thin-distribution slice:

- packaged wrapper entrypoint
- managed enterprise defaults
- packaged custom config dir profile
- packaged plugin for runtime guardrail hooks
- guarded `implement` and `review` agents plus packaged `/implement`, `/review`, `/ship`, and `/handoff` workflow commands
- declarative provider admission policy for `zai`, `zai-coding-plan`, `openai`, `deepseek`, and the isolated OpenRouter evaluation lane
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

Historical note: a Traceability Matrix that pointed at a deleted instrumentation plugin (removed in #277) was retired from this README. Live push protection is implemented by `profile/plugins/guardrail-git.ts`. Acceptance evidence for anti-pattern work lives in `specs/ai-guardrails-anti-patterns.md`.

## Usage

Run the wrapper directly:

```sh
opencode-guardrails
```

It respects an existing `OPENCODE_CONFIG_DIR` so project- or environment-specific overrides can still replace the packaged profile when needed.

The packaged profile defaults to the `implement` agent. Review and release-readiness work should run through the packaged `/review`, `/ship`, and `/handoff` commands so the workflow stays read-only at the gate layer.

Provider admission is also packaged here. Standard confidential-code work is admitted on the `zai`, `zai-coding-plan`, `openai`, and `deepseek` lane. `zai-coding-plan` is kept as a separate provider because Z.AI's official OpenCode guide tells Coding Plan subscribers to select `Z.AI Coding Plan` explicitly. OpenRouter-backed candidates remain available for evaluation and multi-vendor routing without replacing the default implementation path.

## cor-local (ローカル lane)

`cor-local` is an opt-in, fully offline provider that routes through a local `llama-server`-based router (Mac Studio) exposing an OpenAI-compatible endpoint at `http://127.0.0.1:18082/v1`. It is wired into `managed/opencode.json` and `profile/opencode.json` (both copies, kept identical) via `@ai-sdk/openai-compatible`, the same mechanism documented for the upstream `llama.cpp` / `lmstudio` recipes in `packages/web/src/content/docs/providers.mdx`. It does not change the default model (`zai-coding-plan/glm-5.3`) — it is only reachable by asking for it explicitly.

Three model ids are whitelisted: `deepseek-v4-flash-0731`, `glm53-flash`, `qwen3.8-27b`. All three report cost 0 (self-hosted, no billing) but are classified in `profile/plugins/guardrail-patterns.ts`'s `paid["cor-local"]` set so the `denyFree` guardrail does not mistake "no cost" for "free tier" and block them. `denyPreview` first checks `status !== "active"` (config-defined models default to `active`, see `provider.ts`'s config-provider merge) and only then tests the id against `/(preview|alpha|beta|exp|experimental|:free\b|\bfree\b)/i` — none of the three ids trip either check.

Usage:

```sh
opencode run --model cor-local/glm53-flash "..."
```

or, in a project `opencode.json`:

```json
{ "model": "cor-local/glm53-flash" }
```

Offline environment recipe (no network calls, no auto-update, no telemetry):

```sh
OPENCODE_DISABLE_MODELS_FETCH=1 OPENCODE_DISABLE_AUTOUPDATE=1 opencode run --model cor-local/glm53-flash "..."
```

`share` is already `disabled` in both guardrails profiles, so no extra flag is needed for that.

Cold-start note: the router loads models on first request. GLM in particular can block up to roughly 60 seconds before the first byte arrives — this is expected, not a hang. `options.headerTimeout` is set to 900000ms (15m) and `options.timeout` to `false` so that cold load doesn't trip the request-level timeout. `options.chunkTimeout` is set to 120000ms (2m) separately: once headers arrive, a stalled generation (no SSE chunk for 2 minutes) still aborts instead of hanging forever, since `timeout: false` alone does not bound the time between streamed chunks. All three models return `reasoning_content` (surfaced via each model's `interleaved: "reasoning_content"` declaration), structured `tool_calls`, and SSE streaming. Context window is 32768 tokens, max output 16384 tokens.

Offline verification (no network): `bun run local:check-offline` runs the guardrails whitelist/paid/preview pin tests plus `scripts/sync-model-whitelist.py`'s consistency check across the three copies (managed, profile, `paid`).

## Managed deployment

Copy [managed/opencode.json](/Users/teradakousuke/Developer/opencode/packages/guardrails/managed/opencode.json) into the system managed config directory:

- macOS: `/Library/Application Support/opencode/opencode.json`
- Linux: `/etc/opencode/opencode.json`
- Windows: `%ProgramData%\\opencode\\opencode.json`

For macOS MDM deployments, use the same keys in the `ai.opencode.managed` payload that OpenCode already reads through managed preferences.
