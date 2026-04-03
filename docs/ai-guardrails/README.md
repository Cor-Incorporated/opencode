# OpenCode Internal Guardrails Plan

This document defines the production plan for building an internal AI coding environment on top of OpenCode without turning the repo into a long-lived fork.

## Operating principles

This plan inherits the key philosophy from `claude-code-skills` epic `#130`, its README, and its ADRs:

- enforce quality and safety through mechanism before prose
- push checks to the fastest reliable layer first
- keep always-loaded instructions pointer-based and short
- treat deployment/runtime verification as a separate requirement from code review
- prefer explicit workflow gates for review, CI, and release-sensitive operations

That means the migration target is not "copy Claude hooks as-is." It is "preserve the operating model using OpenCode-native config, plugins, commands, permissions, and CI."

## Goal

Build a thin internal distribution that keeps OpenCode upstream-friendly while adding:

- managed configuration for enterprise control
- provider admission policies
- Claude-compatible skill and rule migration
- plugin- and command-based guardrails
- scenario tests that pin critical safety behavior

## Non-goals

- a deep rewrite of OpenCode core
- default use of preview or free third-party models for confidential code
- direct AI-driven push, merge, or release without explicit workflow gates
- always-on remote config, remote instructions, or unbounded MCP expansion

## Baseline facts

- OpenCode already supports `AGENTS.md`, `instructions`, managed config, plugins, commands, permissions, and provider allowlisting.
- OpenCode already supports Claude-compatible fallbacks for `CLAUDE.md` and `.claude/skills/*/SKILL.md`.
- OpenCode already supports OpenAI via `/connect`, including ChatGPT Plus/Pro browser auth, and OpenRouter as a first-class provider.
- OpenRouter exposes routing controls such as provider order, fallback control, data collection policy, and ZDR filtering.
- Z.AI pricing currently lists GLM-5-Code and related models with a Coding API price sheet.

## Product requirements

### Architecture

- Keep OpenCode as the upstream engine.
- Add a wrapper distribution, not a deep fork.
- Store organization defaults in managed config and project config, not in scattered local scripts.
- Default server exposure to localhost-only and default sharing to disabled.

### Provider policy

- Use Z.AI as the default daily lane.
- Use OpenAI as the high-confidence escalation lane.
- Use OpenRouter as an explicit evaluation lane.
- Gate provider access through `enabled_providers`, `disabled_providers`, managed config, and repo policy.
- Treat preview, free, or data-collecting models as opt-in only for non-confidential evaluation work.

### Claude asset migration

- Reuse `SKILL.md` assets directly where possible.
- Move long-lived repo rules into `AGENTS.md` plus `instructions`.
- Rebuild Claude hooks as OpenCode plugins, commands, or workflow gates.
- Preserve only organization-specific controls; do not re-implement platform behavior that OpenCode already has.

### Guardrails

- Default to explicit permission policies for `bash`, `edit`, `task`, `webfetch`, and external directories.
- Block secret reads and unsafe shell patterns through plugin hooks.
- Move completion gates such as review, CI, and release checks into slash commands and CI policies.
- Make scenario tests the contract for managed config precedence, Claude-compatible discovery, and plugin hook behavior.

## Delivery phases

1. Freeze architecture decisions in ADRs.
2. Create issue-sized implementation slices with acceptance criteria.
3. Lock critical behavior with scenario tests before adding internal product code.
4. Build the thin distribution pieces:
   - wrapper CLI
   - managed config profile
   - guardrail plugin
   - safe agents and commands
   - provider admission policy
5. Add replay and scenario harness coverage for future regressions.

## Cor-Incorporated roadmap

GitHub tracking lives in the fork, not only in local docs.

- Epic: [#1](https://github.com/Cor-Incorporated/opencode/issues/1) `internal AI guardrails thin distribution for Cor-Incorporated`
- [#2](https://github.com/Cor-Incorporated/opencode/issues/2) Bootstrap thin distribution
- [#3](https://github.com/Cor-Incorporated/opencode/issues/3) Claude asset inventory and import
- [#4](https://github.com/Cor-Incorporated/opencode/issues/4) Guardrail plugin MVP for policy enforcement
- [#5](https://github.com/Cor-Incorporated/opencode/issues/5) Safe agents and workflow commands
- [#6](https://github.com/Cor-Incorporated/opencode/issues/6) Provider admission policy
- [#7](https://github.com/Cor-Incorporated/opencode/issues/7) Scenario and replay harness

## Current status

Done:

- ADRs fixed for architecture, provider lanes, Claude asset migration, and scenario-first delivery
- scenario coverage added for managed config precedence, Claude-compatible skill discovery, plugin env injection, and compaction context
- thin distribution package added under `packages/guardrails/`
- initial migration inventory created from `/Users/teradakousuke/Developer/claude-code-skills`

Next:

- implement issue `#4` using the inventory's `plugin` bucket as the source map
- then implement issue `#5` for explicit safe workflows instead of relying on ad hoc shell paths
- keep replay and provider-policy work linked to issues `#6` and `#7`

## Session rule

When continuing this work in future sessions:

- start from the GitHub epic and the linked issue, not from memory
- preserve upstream compatibility unless a missing extension point proves otherwise
- update docs and tests in the same change set when guardrail behavior changes
- do not mark work complete unless runtime behavior is verified, not just implemented

## Artifact map

- ADRs: `docs/ai-guardrails/adr/`
- Issue briefs: `docs/ai-guardrails/issues/`
- Migration inventory: `docs/ai-guardrails/migration/`
- Scenario tests: `packages/opencode/test/scenario/`
- Thin distribution package: `packages/guardrails/`

## Primary references

- OpenCode config: https://opencode.ai/docs/config
- OpenCode providers: https://opencode.ai/docs/providers
- OpenCode plugins: https://opencode.ai/docs/plugins
- OpenCode rules: https://opencode.ai/docs/rules
- OpenCode skills: https://opencode.ai/docs/skills
- OpenCode commands: https://opencode.ai/docs/commands
- OpenCode agents: https://opencode.ai/docs/agents
- OpenCode server: https://opencode.ai/docs/server
- OpenRouter quickstart: https://openrouter.ai/docs/quickstart
- OpenRouter provider routing: https://openrouter.ai/docs/guides/routing/provider-selection
- OpenAI Codex web: https://developers.openai.com/codex/cloud
- ChatGPT pricing: https://chatgpt.com/pricing
- Z.AI pricing: https://docs.z.ai/guides/overview/pricing
