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

Those principles come from `claude-code-skills` epic `#130` and are tracked in this fork under `docs/ai-guardrails/`.
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
- declarative provider admission policy for `zai`, `zai-coding-plan`, `openai`, and the isolated OpenRouter evaluation lane
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

The packaged guardrail plugin enforces AI agent instrumentation and metric changes through source-level hooks. It blocks global monkey patches during edit hooks and blocks PR/merge commands when instrumentation evidence is missing.

Traceability Matrix:

| Acceptance Criteria                                                                 | Implementation code path                                                     |
| ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Source-level hooks are required and global monkey patches are prohibited            | `profile/plugins/guardrail-instrumentation.ts#createInstrumentationHandlers` |
| Instrumentation/cross-cutting PRs require integration or smoke coverage             | `profile/plugins/guardrail-instrumentation.ts#integrationTestEvidence`       |
| Metric semantics and source code path must be explicit                              | `profile/plugins/guardrail-instrumentation.ts#metricSemanticsEvidence`       |
| Unmeasurable metrics must not be claimed                                            | `profile/plugins/guardrail-instrumentation.ts#unmeasurableMetricClaim`       |
| Optional dependency availability must be probed before use                          | `profile/plugins/guardrail-instrumentation.ts#dependencyProbeEvidence`       |
| Resource lifecycle cleanup/finally paths are required for instrumentation resources | `profile/plugins/guardrail-instrumentation.ts#resourceLifecycleEvidence`     |
| Unavailable metric state must carry an explicit reason instead of null              | `profile/plugins/guardrail-instrumentation.ts#nullUnavailableReason`         |

Metric semantics: `instrumentation_quality_state` records only this gate's evaluated state (`done` or `blocked`) for the current diff. `instrumentation_quality_blockers` records concrete blocker strings from the code path above; it does not claim runtime observability metrics that the guardrail cannot directly measure.

Dependency availability probe: PR/merge evidence must show the dependency, provider, SDK, CLI, or MCP dependency was checked and that unavailable data includes `unavailable_reason` or equivalent `reason`.

## Usage

Run the wrapper directly:

```sh
opencode-guardrails
```

It respects an existing `OPENCODE_CONFIG_DIR` so project- or environment-specific overrides can still replace the packaged profile when needed.

The packaged profile defaults to the `implement` agent. Review and release-readiness work should run through the packaged `/review`, `/ship`, and `/handoff` commands so the workflow stays read-only at the gate layer.

Provider admission is also packaged here. Standard confidential-code work is admitted on the `zai`, `zai-coding-plan`, and `openai` lane. `zai-coding-plan` is kept as a separate provider because Z.AI's official OpenCode guide tells Coding Plan subscribers to select `Z.AI Coding Plan` explicitly. OpenRouter-backed candidates are available only through the dedicated `provider-eval` lane so evaluation traffic does not silently become the default implementation path.

## Managed deployment

Copy [managed/opencode.json](/Users/teradakousuke/Developer/opencode/packages/guardrails/managed/opencode.json) into the system managed config directory:

- macOS: `/Library/Application Support/opencode/opencode.json`
- Linux: `/etc/opencode/opencode.json`
- Windows: `%ProgramData%\\opencode\\opencode.json`

For macOS MDM deployments, use the same keys in the `ai.opencode.managed` payload that OpenCode already reads through managed preferences.
