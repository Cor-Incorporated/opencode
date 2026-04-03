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

This plan inherits the key philosophy from `claude-code-skills` epic `#130`, its README, its ADRs, and Anthropic's skill construction guide:

- enforce quality and safety through mechanism before prose
- push checks to the fastest reliable layer first
- keep always-loaded instructions pointer-based and short
- treat deployment/runtime verification as a separate requirement from code review
- prefer explicit workflow gates for review, CI, and release-sensitive operations

That means the migration target is not "copy Claude hooks as-is." It is "preserve the operating model using OpenCode-native config, plugins, commands, permissions, and CI."

## Source canon

Future implementation work should treat the following sources as normative, in this order:

1. current platform semantics from official product docs
2. `claude-code-skills` README, epic `#130`, and accepted ADRs
3. harness-engineering references and skill-construction references that the source README already cites
4. this repo's ADRs, issue briefs, and scenario tests

The main source set for this migration is:

- `terisuke/claude-code-skills` README
- `terisuke/claude-code-skills` epic `#130`
- `terisuke/claude-code-skills` ADRs `001` to `004`
- `terisuke/claude-code-skills/docs/references/harness-engineering-best-practices-2026.md`
- `terisuke/claude-code-skills/docs/references/anthropic-skill-guide-summary.md`
- `terisuke/claude-code-skills/docs/requirements/design-requirements-2026-03-24.md`
- Claude Code official hooks and settings docs
- Anthropic skill guide PDF (`The Complete Guide to Building Skills for Claude`) and summary
- OpenCode rules, skills, commands, and plugins docs

In this migration, references to the `BDF` document should be interpreted as Anthropic's PDF `The Complete Guide to Building Skills for Claude`, which is the skill-construction guide the source repository philosophy lines up with operationally.

When these sources disagree:

- use official runtime docs for concrete platform behavior
- use epic `#130` and harness best practices for guardrail philosophy
- use this repo's ADRs to document local implementation choices

## Non-negotiables

The following rules are mandatory for guardrail work in this fork:

- mechanism before prose
- fastest reliable feedback layer first
- pointer-based instructions instead of long always-loaded prompts
- "implemented" is not "working"; scenario or CI proof is required
- migrate assets by role, not by naive one-to-one copying
- reuse Claude-compatible `SKILL.md` assets directly before rewriting them
- keep OpenCode core close to upstream unless a missing extension point proves otherwise
- do not let merge, release, or review freshness depend on agent goodwill alone
- design instructions with progressive disclosure: frontmatter/router text stays short, body text stays task-focused, and detail lives in linked references or deterministic mechanisms
- define success before implementation with triggering tests, functional tests, and baseline comparison where applicable
- prefer problem-first workflows and explicit outcomes over tool-first feature narration
- for critical validation, prefer deterministic scripts, plugins, commands, or CI over soft language-only reminders
- sync `upstream/dev` into fork `dev` before starting each issue branch unless a documented exception blocks it
- push issue branches after meaningful checkpoints so the remote repo is the recovery point for the next session

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

### Asset migration discipline

- keep third-party Claude-only frameworks in `.claude` during transition
- keep representative `.claude/skills/*/SKILL.md` fixtures as migration truth data
- move organization-owned reusable skills into `.opencode/skills` only when ownership and packaging are stable
- move long-form repo rules into `AGENTS.md` plus `instructions`
- redesign hooks as plugins, commands, or CI policy instead of cloning Claude hook mechanics
- refuse implementation work that has not first been classified in the migration inventory or explicitly justified as an exception

## Delivery phases

1. Freeze architecture decisions in ADRs.
2. Land the thin-distribution bootstrap as the first issue-sized slice.
3. Keep scenario coverage in the same change set as runtime behavior.
4. Establish the MVP floor explicitly before broadening into later maturity work.
5. Stack later issues for plugin policy, safe workflows, provider lanes, replay coverage, and authoritative release gates on top of this base.

## MVP readiness split

The remaining work is intentionally split into two stages:

- `now required before MVP claim`: `#5`, `#6`, `#7`, and `#13`
- `later, after MVP floor`: `#14` and `#12`

The detailed rationale lives in `docs/ai-guardrails/mvp-readiness.md`. Future sessions should start there before expanding issue scope.

## Tracking

- Epic: [#1](https://github.com/Cor-Incorporated/opencode/issues/1)
- MVP readiness epic: [#16](https://github.com/Cor-Incorporated/opencode/issues/16)
- Current issue: [#15](https://github.com/Cor-Incorporated/opencode/issues/15)
- Future slices remain separate issues so implementation can stay one issue per pull request.

Issue `#2` is the merged bootstrap base.

Issue `#15` is complete only when:

- the repo has a written MVP readiness register
- missing local issue briefs for the open workstreams are committed
- GitHub issue structure matches the same `now` versus `later` split
- future implementation work can point back to this source canon instead of relying on memory

## Session rule

When continuing this work in future sessions:

- start from the GitHub epic and the linked issue, not from memory
- sync fork `dev` with `upstream/dev` before opening the next issue branch when possible
- preserve upstream compatibility unless a missing extension point proves otherwise
- update docs and tests in the same change set when guardrail behavior changes
- push branch checkpoints to GitHub after meaningful milestones so the next session can resume from remote state
- do not mark work complete unless runtime behavior is verified, not just implemented

## Artifact map

- ADRs: `docs/ai-guardrails/adr/`
- Issue briefs: `docs/ai-guardrails/issues/`
- MVP readiness: `docs/ai-guardrails/mvp-readiness.md`
- Migration inventory: `docs/ai-guardrails/migration/`
- Scenario tests: `packages/opencode/test/scenario/`
- Thin distribution package: `packages/guardrails/`

## Primary references

- OpenCode config: https://opencode.ai/docs/config
- OpenCode rules: https://opencode.ai/docs/rules
- OpenCode skills: https://opencode.ai/docs/skills
- OpenCode commands: https://opencode.ai/docs/commands
- OpenCode plugins: https://opencode.ai/docs/plugins
- OpenCode server: https://opencode.ai/docs/server
- Claude Code hooks: https://docs.anthropic.com/en/docs/claude-code/hooks
- Claude Code settings: https://docs.anthropic.com/en/docs/claude-code/settings
- Anthropic skills guide PDF: https://resources.anthropic.com/hubfs/The-Complete-Guide-to-Building-Skill-for-Claude.pdf
