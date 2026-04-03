# Issue 004: Safe Agents And Workflow Commands

## Problem

Raw built-in agents are too permissive for an internal product. The repo needs a safer default operating model for implementation, review, and release workflows.

This issue is part of the MVP floor. It should not absorb later CI or broader migration scope.

## Deliverables

- hardened default primary agent
- review-oriented subagent
- slash commands for `/implement`, `/review`, `/ship`, and `/handoff`
- explicit permission policy for dangerous shell patterns and write operations

## Acceptance

- default agent is not an unrestricted build clone
- review workflow can run without edit access
- release workflow cannot bypass explicit gates
- the scope stays limited to local runtime workflow safety, not later CI/release authority

## Dependencies

- `003-guardrail-plugin-mvp.md`
- `docs/ai-guardrails/mvp-readiness.md`
- `docs/ai-guardrails/migration/claude-code-skills-inventory.md`

## Sources

- `claude-code-skills` epic `#130`
- `claude-code-skills` README
- Anthropic `The Complete Guide to Building Skills for Claude`
- https://opencode.ai/docs/agents
- https://opencode.ai/docs/commands
- https://opencode.ai/docs/config
