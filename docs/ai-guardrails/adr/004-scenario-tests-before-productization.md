# ADR 004: Scenario Tests Before Productization

- Status: Accepted
- Date: 2026-04-03

## Context

The internal distribution will add policy, not just features. Policy breaks quietly when config precedence, plugin hooks, or compatibility discovery shifts under upstream changes.

Unit tests are necessary but not sufficient. The contract that matters is scenario behavior across config, discovery, and plugin wiring.

## Decision

Add scenario tests before product code for these contracts:

- managed config overrides weaker config layers for enterprise restrictions
- Claude-compatible skills remain discoverable during migration
- plugin hooks can inject environment and observe session lifecycle events

Future work should extend this suite with replay tests for release gates, provider admission, and share/server restrictions.

## Consequences

### Positive

- safer upstream upgrades
- easier AI-driven implementation because expected behavior is executable
- faster detection of regressions in config precedence and plugin surfaces

### Negative

- test fixtures must stay aligned with evolving config semantics

## Evidence

- OpenCode config precedence and managed settings: https://opencode.ai/docs/config
- OpenCode plugin events: https://opencode.ai/docs/plugins
- OpenCode skills and commands: https://opencode.ai/docs/skills and https://opencode.ai/docs/commands
