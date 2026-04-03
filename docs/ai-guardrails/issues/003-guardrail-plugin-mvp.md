# Issue 003: Guardrail Plugin MVP

## Problem

The source harness derived much of its value from deterministic hook behavior, but OpenCode does not run Claude hooks directly. The first runtime policy slice therefore needs an OpenCode-native plugin that preserves the operating model without patching core.

## Deliverables

- packaged guardrail plugin under `packages/guardrails/profile/plugins/`
- packaged profile config that loads the plugin without core patches
- secret and state-file read blocking
- protection for linter/formatter config edits
- shell environment injection for policy mode and runtime state paths
- lifecycle logging for session and permission events
- compaction context stub that preserves guardrail state across handoff
- issue brief and canon updates that treat Anthropic's skill guide PDF as mandatory source input

## Acceptance

- the plugin loads from config, not from a core-only registration path
- `shell.env` injects guardrail mode metadata
- session lifecycle events are observed and recorded
- compaction hooks add guardrail state context
- scenario tests prove the runtime behavior without a deep core patch

## Additional rule

This issue must follow the source canon in `docs/ai-guardrails/README.md`, including the Anthropic skill guide PDF and the `claude-code-skills` epic `#130` philosophy: progressive disclosure, mechanism-first validation, and runtime proof over implementation claims.

## Dependencies

- ADR 001
- ADR 003
- ADR 004
- Issue 001
- Issue 002

## Sources

- `claude-code-skills` README
- `claude-code-skills` epic `#130`
- `claude-code-skills/docs/references/harness-engineering-best-practices-2026.md`
- `claude-code-skills/docs/references/anthropic-skill-guide-summary.md`
- Anthropic `The Complete Guide to Building Skills for Claude`
- https://docs.anthropic.com/en/docs/claude-code/hooks
- https://docs.anthropic.com/en/docs/claude-code/settings
- https://opencode.ai/docs/plugins
- https://opencode.ai/docs/config
