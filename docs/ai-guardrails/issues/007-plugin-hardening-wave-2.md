# Issue 007: Plugin Hardening Wave 2

## Problem

The plugin MVP in `003-guardrail-plugin-mvp.md` proves the extension surface, but it does not yet cover enough of the highest-value hook migration set to support an MVP claim by itself.

## Deliverables

- expand plugin policy to cover high-priority fast-feedback hooks from the migration inventory
- add crash-safe state/logging expectations where needed for local runtime continuity
- document which plugin behaviors are part of the MVP floor versus later operational hardening

## Candidate scope

- `post-lint-format`
- `block-version-downgrade`
- `context-budget-*`
- `mark-factcheck-done`
- `reset-factcheck`
- targeted review or fact-check runtime state where feasible without broad core patches

## Acceptance

- the plugin covers the highest-value remaining fast-feedback policies needed for MVP
- behavior is scenario-tested or otherwise runtime-verified
- scope remains thin-distribution-first and upstream-friendly

## Dependencies

- `003-guardrail-plugin-mvp.md`
- `006-scenario-and-replay-harness.md`
- `docs/ai-guardrails/mvp-readiness.md`
- `docs/ai-guardrails/migration/claude-code-skills-inventory.md`

## Sources

- `claude-code-skills` epic `#130`
- `claude-code-skills` README
- Anthropic `The Complete Guide to Building Skills for Claude`
