# Issue 004: Safe Agents And Commands

## Problem

Raw built-in agents are too permissive for an internal product. The repo needs a safer default operating model for implementation, review, and release workflows.

## Deliverables

- hardened default primary agent
- review-oriented subagent
- slash commands for `/implement`, `/review`, `/ship`, and `/handoff`
- explicit permission policy for dangerous shell patterns and write operations

## Acceptance

- default agent is not an unrestricted build clone
- review workflow can run without edit access
- release workflow cannot bypass explicit gates

## Dependencies

- Issue 001
- Issue 003

## Sources

- https://opencode.ai/docs/agents
- https://opencode.ai/docs/commands
- https://opencode.ai/docs/permissions
