# MVP Readiness Register

This document defines the remaining work between the current guardrails slice and an honest MVP claim.

The current state is not "production-ready." It is a verified thin-distribution base with a first guardrail plugin slice. That is enough to start the next implementation waves, but not enough to describe the system as a complete internal MVP yet.

The split below is mandatory for future planning:

- `now required before MVP claim`: work that must land before the product can be described as an MVP
- `later, after MVP floor`: work that materially improves safety or maturity, but should not be used to bloat the MVP floor

## Current position

What exists today:

- thin wrapper distribution and managed profile
- Claude-compatible skill discovery proof
- first guardrail plugin slice for env injection, protected files, lifecycle logging, and compaction carry-over
- scenario coverage for the above

What is still missing:

- safe default operating workflows for implementation, review, ship, and handoff
- declarative provider lanes and confidential-code admission rules
- replayable scenario coverage for the next policy layers
- more of the high-value hook inventory moved into deterministic runtime mechanisms

## Now Required Before MVP Claim

These items define the MVP floor. If they are not complete, the product should still be described as "in progress" rather than "MVP".

### `#5` Safe Agents And Workflow Commands

Why it blocks MVP:

- the current runtime still lacks the final guarded primary workflow surface
- implementation, review, ship, and handoff need explicit entrypoints so policy is not left to agent goodwill

Required outcome:

- guarded default primary agent
- review-safe subagent behavior
- slash commands for `/implement`, `/review`, `/ship`, and `/handoff`
- dangerous shell and write flows routed through explicit workflow gates

### `#6` Provider Admission Policy

Why it blocks MVP:

- without provider lanes, the internal product does not yet have a stable answer for confidential code handling or evaluation traffic
- the README philosophy explicitly rejects product decisions tied to one transient model label

Required outcome:

- declarative provider lanes in config/profile
- allow/deny defaults for standard use versus evaluation use
- documented restrictions for preview, free, or data-collecting providers in confidential repos

### `#7` Scenario And Replay Harness

Why it blocks MVP:

- the philosophy from epic `#130` requires runtime proof, not just implementation
- the current scenario suite proves the first slices, but not the later guarded workflows or provider lanes

Required outcome:

- stable scenario coverage for guarded commands, provider policy, and plugin behavior
- replay strategy for future release-sensitive checks without requiring deep forks

### `#13` Plugin Hardening Wave 2 For MVP Floor

Why it blocks MVP:

- `#4` proved the plugin surface, but it did not yet migrate enough of the highest-value fast-feedback hooks
- the plugin still needs more of the mechanical guardrail layer before the runtime can be described as a coherent MVP

Required outcome:

- next high-value plugin migrations from the inventory
- context budget and version-baseline protections where feasible
- fact-check and review-state primitives where they materially improve the guarded workflows

## Later, After MVP Floor

These items should be tracked now, but they should not be allowed to endlessly delay the MVP floor.

### `#14` Authoritative CI And Release Gates

Why it is later:

- local workflows and provider policy can still establish an MVP floor first
- this work is authoritative and necessary, but it belongs to the next maturity tier rather than the first local-runtime MVP

Target outcome:

- CI/provider-enforced review freshness
- release and post-merge verification outside the local client
- a clean split between local preflight and authoritative server-side gates

### `#12` Broader Claude Asset Migration Beyond MVP Floor

Why it is later:

- the MVP does not require every Claude-owned asset to be repackaged
- the current strategy already prefers direct reuse and role-based migration over forced copying

Target outcome:

- next-wave ownership and packaging rules for org-owned assets
- deliberate moves from `.claude` to `.opencode` only when maintenance ownership is stable

## Execution Rule

When scoping future work:

- if the task advances the guarded runtime needed to make an MVP claim, it belongs in the `now required` set
- if the task improves maturity without changing the MVP claim, keep it in the `later` set
- do not quietly absorb `later` scope into `#5`, `#6`, or `#7`

## Sources

- `docs/ai-guardrails/README.md`
- `docs/ai-guardrails/migration/claude-code-skills-inventory.md`
- `claude-code-skills` epic `#130`
- `claude-code-skills` README
- Anthropic `The Complete Guide to Building Skills for Claude`
