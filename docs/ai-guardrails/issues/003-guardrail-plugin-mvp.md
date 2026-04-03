# Issue 003: Guardrail Plugin MVP

## Problem

Claude hooks that enforced guardrails do not transfer directly. OpenCode plugins are the primary runtime surface for secret blocking, shell environment injection, and lifecycle observation.

## Deliverables

- local or packaged guardrail plugin skeleton
- secret read blocklist
- shell environment injection for policy mode
- lifecycle logging for session and permission events
- compaction hook stub for future context preservation

## Acceptance

- plugin loads from project config
- plugin can inject environment through `shell.env`
- plugin can observe `session.created`
- plugin tests do not require a deep core patch

## Dependencies

- ADR 001
- ADR 003
- ADR 004

## Sources

- https://opencode.ai/docs/plugins
- https://opencode.ai/docs/permissions
