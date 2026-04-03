# Issue 006: Scenario And Replay Harness

## Problem

Guardrails are only credible if config precedence, plugin behavior, and migration compatibility are exercised automatically.

## Deliverables

- scenario tests for managed config precedence
- scenario tests for Claude-compatible skill discovery
- scenario tests for plugin shell environment injection and lifecycle hooks
- follow-up plan for replaying release-gate and provider-admission scenarios

## Acceptance

- scenario suite runs under `packages/opencode`
- the tests are stable on local development machines and CI
- future guardrail issues can link to specific scenario coverage

## Dependencies

- ADR 004
- Issue 001
- Issue 002
- Issue 003

## Sources

- https://opencode.ai/docs/config
- https://opencode.ai/docs/plugins
- https://opencode.ai/docs/skills
