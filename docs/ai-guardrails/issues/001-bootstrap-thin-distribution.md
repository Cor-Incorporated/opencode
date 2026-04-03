# Issue 001: Bootstrap Thin Distribution

## Problem

The repo needs a first internal distribution layer that can enforce organization defaults without forking core behavior into unrelated files.

## Deliverables

- wrapper entrypoint for the internal distribution
- pinned OpenCode version strategy
- managed config profile for enterprise defaults
- localhost-only server default
- default `share: "disabled"`

## Acceptance

- internal launcher resolves to a pinned OpenCode build
- managed config overrides weaker config layers in tests
- project config can still add project-local commands, skills, and agents

## Dependencies

- ADR 001
- ADR 004

## Sources

- https://opencode.ai/docs/config
- https://opencode.ai/docs/server
