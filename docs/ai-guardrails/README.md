# OpenCode Internal Guardrails Plan

This document defines the production plan for building an internal AI coding environment on top of OpenCode without turning the repo into a long-lived fork.

## Product framing

The target product should be described consistently across README, issues, and future docs as:

- a Cor-Incorporated fork of OpenCode
- intentionally upstream-compatible where practical
- extended through a thin internal distribution layer
- not an official upstream OpenCode release channel

The migration goal is not to hide the upstream lineage. It is to make the fork legible while keeping core drift low.

## Operating principles

This plan inherits the key philosophy from `claude-code-skills` epic `#130`, its README, and its ADRs:

- enforce quality and safety through mechanism before prose
- push checks to the fastest reliable layer first
- keep always-loaded instructions pointer-based and short
- treat deployment/runtime verification as a separate requirement from code review
- prefer explicit workflow gates for review, CI, and release-sensitive operations

That means the migration target is not "copy Claude hooks as-is." It is "preserve the operating model using OpenCode-native config, plugins, commands, permissions, and CI."

## Goal

Bootstrap the first thin-distribution slice that keeps OpenCode upstream-friendly while adding:

- managed configuration for enterprise control
- localhost-only server defaults
- disabled sharing by default
- a pinned wrapper entrypoint
- scenario tests that pin config precedence and project-local compatibility

## Non-goals

- a deep rewrite of OpenCode core
- default use of preview or free third-party models for confidential code
- direct AI-driven push, merge, or release without explicit workflow gates
- always-on remote config, remote instructions, or unbounded MCP expansion

## Baseline facts

- OpenCode already supports `AGENTS.md`, managed config, commands, agents, skills, and permissions.
- Managed config and custom config directories are enough to ship a first internal distribution without a deep core fork.
- Scenario tests in `packages/opencode` can validate precedence and compatibility without special product code paths.

## Product requirements

### Architecture

- Keep OpenCode as the upstream engine.
- Add a wrapper distribution, not a deep fork.
- Store organization defaults in managed config and project config, not in scattered local scripts.
- Default server exposure to localhost-only and default sharing to disabled.

### First slice

- Keep OpenCode as the upstream engine.
- Add a wrapper distribution, not a deep fork.
- Store organization defaults in managed config and packaged profile files, not in scattered scripts.
- Default server exposure to localhost-only and default sharing to disabled.
- Prove config precedence and project-local compatibility with scenario tests.

## Delivery phases

1. Freeze architecture decisions in ADRs.
2. Land the thin-distribution bootstrap as the first issue-sized slice.
3. Keep scenario coverage in the same change set as runtime behavior.
4. Stack later issues for plugin policy, safe workflows, provider lanes, and replay coverage on top of this base.

## Tracking

- Epic: [#1](https://github.com/Cor-Incorporated/opencode/issues/1)
- Current issue: [#2](https://github.com/Cor-Incorporated/opencode/issues/2)
- Future slices remain separate issues so implementation can stay one issue per pull request.

## Session rule

When continuing this work in future sessions:

- start from the GitHub epic and the linked issue, not from memory
- preserve upstream compatibility unless a missing extension point proves otherwise
- update docs and tests in the same change set when guardrail behavior changes
- do not mark work complete unless runtime behavior is verified, not just implemented

## Artifact map

- ADRs: `docs/ai-guardrails/adr/`
- Issue briefs: `docs/ai-guardrails/issues/`
- Scenario tests: `packages/opencode/test/scenario/`
- Thin distribution package: `packages/guardrails/`

## Primary references

- OpenCode config: https://opencode.ai/docs/config
- OpenCode server: https://opencode.ai/docs/server
