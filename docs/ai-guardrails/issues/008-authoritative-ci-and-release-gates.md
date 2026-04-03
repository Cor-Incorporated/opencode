# Issue 008: Authoritative CI And Release Gates

## Problem

The local client can guide safe behavior, but merge, release, and post-merge authority must not depend on local agent goodwill alone.

This issue is intentionally outside the MVP floor. It should stay separated from `004-safe-agents-and-commands.md` so the MVP scope does not expand indefinitely.

## Deliverables

- CI or provider-enforced review freshness gates
- release and post-merge verification policy
- documented split between local preflight checks and authoritative server-side gates

## Acceptance

- the repo documents which gates are local-only versus authoritative
- release-sensitive operations are enforced outside the local client
- the work remains separate from the local-runtime MVP floor

## Dependencies

- `004-safe-agents-and-commands.md`
- `006-scenario-and-replay-harness.md`
- `docs/ai-guardrails/mvp-readiness.md`

## Sources

- `claude-code-skills` epic `#130`
- `claude-code-skills` README
- Anthropic `The Complete Guide to Building Skills for Claude`
