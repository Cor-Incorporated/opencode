# Issue 002: Claude Asset Inventory And Import

## Problem

The Claude harness contains reusable assets, but they are not yet classified by what OpenCode can consume directly versus what must be redesigned.

## Deliverables

- migration inventory for skills, rules, hooks, and scripts
- direct-import path for Claude-compatible skills
- `AGENTS.md` plus `instructions` layout for long-form rules
- hook mapping table with target implementation type:
  - plugin
  - command
  - CI gate
  - drop

## Acceptance

- the inventory names each hook and assigns a migration bucket
- at least one representative `.claude/skills/*/SKILL.md` fixture is exercised by scenario tests
- repo guidance explains when to keep assets in `.claude` versus move them into `.opencode`

## Current artifact

- `docs/ai-guardrails/migration/claude-code-skills-inventory.md`

## Additional rule

Do not start plugin, command, or provider-lane implementation from memory alone. Classify the source asset first, then implement against the target bucket.

## Dependencies

- ADR 003
- Issue 001

## Sources

- `claude-code-skills` README
- `claude-code-skills` epic `#130`
- `claude-code-skills/docs/references/harness-engineering-best-practices-2026.md`
- `claude-code-skills/docs/references/anthropic-skill-guide-summary.md`
- `claude-code-skills/docs/requirements/design-requirements-2026-03-24.md`
- https://opencode.ai/docs/rules
- https://opencode.ai/docs/skills
- https://opencode.ai/docs/commands
- https://opencode.ai/docs/plugins
