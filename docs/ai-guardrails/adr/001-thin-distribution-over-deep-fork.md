# ADR 001: Thin Distribution Over Deep Fork

- Status: Accepted
- Date: 2026-04-03

## Context

The internal product needs enterprise guardrails, provider policy, and Claude asset migration. OpenCode already exposes the primitives needed to do this through config layering, managed settings, plugins, commands, agents, and server APIs.

A deep fork would create a permanent rebase tax, make upstream updates harder, and encourage product logic to drift into core files that are not unique to the internal distribution.

## Decision

Build the internal product as a thin distribution:

- keep upstream OpenCode pinned and trackable
- prefer wrapper CLI, managed config, project config, `.opencode` assets, and plugins
- treat core patches as exceptions that must be justified by a missing extension point

## Consequences

### Positive

- lower upstream merge cost
- easier security and version upgrades
- clearer separation between platform behavior and organization policy
- easier scenario testing because policy lives at the edges

### Negative

- some existing Claude hooks must be redesigned instead of copied 1:1
- workflow control depends on configuration discipline and tests

## Evidence

- OpenCode config precedence and managed config support: https://opencode.ai/docs/config
- OpenCode plugins and hook surface: https://opencode.ai/docs/plugins
- OpenCode commands and agents: https://opencode.ai/docs/commands and https://opencode.ai/docs/agents
