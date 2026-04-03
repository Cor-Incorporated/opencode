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

## Dependencies

- ADR 003
- Issue 001

## Sources

- https://opencode.ai/docs/rules
- https://opencode.ai/docs/skills
- https://opencode.ai/docs/commands
- https://opencode.ai/docs/plugins
