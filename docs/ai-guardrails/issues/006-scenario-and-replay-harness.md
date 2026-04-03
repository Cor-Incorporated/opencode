# Issue 006: Scenario And Replay Harness

## Problem

Guardrails are only credible if config precedence, plugin behavior, and migration compatibility are exercised automatically.

This issue is part of the MVP floor because the philosophy from epic `#130` treats runtime proof as a requirement, not a follow-up.

## Deliverables

- scenario tests for guarded workflow commands
- scenario tests for provider admission behavior
- scenario tests for plugin state and carry-over that matter to MVP claims
- follow-up replay strategy for release-gate and provider-admission scenarios

## Acceptance

- scenario suite runs under `packages/opencode`
- the tests are stable on local development machines and CI
- future guardrail issues can link to specific scenario or replay coverage

## Dependencies

- `003-guardrail-plugin-mvp.md`
- `004-safe-agents-and-commands.md`
- `005-provider-admission-policy.md`
- `docs/ai-guardrails/mvp-readiness.md`

## Sources

- `claude-code-skills` epic `#130`
- `claude-code-skills` README
- Anthropic `The Complete Guide to Building Skills for Claude`
- `packages/opencode/test/scenario/guardrails.test.ts`
