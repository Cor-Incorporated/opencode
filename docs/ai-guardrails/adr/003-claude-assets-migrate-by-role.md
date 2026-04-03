# ADR 003: Claude Assets Migrate By Role

- Status: Accepted
- Date: 2026-04-03

## Context

The source Claude harness contains skills, rules, hooks, and scripts. OpenCode can already read Claude-compatible rule and skill locations, but it does not offer a one-to-one clone of Claude hook semantics.

Trying to copy every hook as-is would create brittle behavior and duplicate platform capabilities that OpenCode already provides.

## Decision

Migrate Claude assets by role:

- skills: reuse directly through `.claude/skills/*/SKILL.md` and `.opencode/skills/*/SKILL.md`
- rules: move to `AGENTS.md` plus `instructions`
- hooks: redesign as plugins, commands, or CI workflow gates
- scripts: keep only when they remain the simplest implementation unit

Hook classes should be triaged into four buckets:

- direct keep
- plugin rewrite
- command rewrite
- drop because OpenCode already covers it

## Consequences

### Positive

- high reuse for skill assets
- lower migration risk for repo instructions
- clearer ownership of runtime guardrails

### Negative

- hook inventory and mapping work becomes a dedicated migration task
- some Claude-only lifecycle semantics need workflow redesign

## Evidence

- OpenCode rules and Claude compatibility: https://opencode.ai/docs/rules
- OpenCode skills and Claude-compatible discovery: https://opencode.ai/docs/skills
- OpenCode plugins and commands: https://opencode.ai/docs/plugins and https://opencode.ai/docs/commands
