# Issue 009: Broader Claude Asset Migration

## Problem

The MVP floor does not require full migration of every Claude-owned asset, but the longer-term product still needs a principled path for additional skills, commands, and packaging decisions.

This issue is intentionally after the MVP floor.

## Deliverables

- next-wave migration candidates beyond the MVP floor
- ownership rules for moving assets from `.claude` into `.opencode`
- packaging and maintenance rules for org-owned assets after the MVP ships

## Acceptance

- the repo distinguishes MVP-critical migration from later migration work
- future asset moves can point to an explicit issue and ownership rule instead of ad hoc decisions

## Dependencies

- `002-claude-asset-inventory-and-import.md`
- `docs/ai-guardrails/mvp-readiness.md`
- `docs/ai-guardrails/migration/claude-code-skills-inventory.md`

## Sources

- `claude-code-skills` epic `#130`
- `claude-code-skills` README
- Anthropic `The Complete Guide to Building Skills for Claude`
