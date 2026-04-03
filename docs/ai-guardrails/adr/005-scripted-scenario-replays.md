# ADR 005: Scripted Scenario Replays

- Status: Accepted
- Date: 2026-04-03

## Context

`#5` and `#6` added guarded commands, subagents, and provider lanes. The existing scenario suite proved config and plugin slices, but it still left an MVP gap: the guarded workflows were defined in files yet not replayed end to end.

Epic `#130` from the source Claude harness makes the requirement explicit: implemented behavior is not complete until it is shown to fire in the real runtime path.

The local runtime also needs a way to grow future release-sensitive checks without creating a deep OpenCode fork or relying on live third-party APIs inside tests.

## Decision

Adopt scripted scenario replays for guardrail workflow coverage:

- run scenario tests under `packages/opencode/test/scenario/`
- boot the packaged guardrail profile through the real config, command, agent, plugin, and session layers
- replace network LLM calls with a deterministic fake LLM server
- script expected model replies as replay steps so guarded workflows can be re-run exactly
- assert on runtime artifacts that matter to MVP claims: session messages, task tool output, provider routing, and guardrail state/log files

The replay layer is intentionally small. It is not a second runtime. It is a deterministic driver for the existing runtime path.

## Consequences

### Positive

- workflow commands are proven through the same session path users invoke
- provider-lane regressions can be caught without hitting live vendor APIs
- future issues can add replays for release gates, review freshness, or share/server restrictions without forking core runtime behavior

### Negative

- replay scripts must stay aligned with upstream session semantics
- fake LLM responses prove routing and workflow mechanics, not model quality

## Evidence

- OpenCode commands: https://opencode.ai/docs/commands
- OpenCode plugins: https://opencode.ai/docs/plugins
- OpenCode config: https://opencode.ai/docs/config
- Claude Code hooks guide: https://docs.anthropic.com/en/docs/claude-code/hooks-guide
- Anthropic skill guide PDF: https://resources.anthropic.com/hubfs/The-Complete-Guide-to-Building-Skill-for-Claude.pdf
