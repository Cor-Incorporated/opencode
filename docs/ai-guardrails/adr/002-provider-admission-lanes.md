# ADR 002: Provider Admission Lanes

## Status

Accepted

## Context

The internal product needs a stable answer for confidential-code routing before it can honestly be called an MVP.

OpenCode already exposes the needed primitives in config, provider metadata, commands, agents, and plugins. The missing piece is not another fork-level provider abstraction. It is a thin-distribution policy that:

- admits a small provider set intentionally
- keeps standard work separate from evaluation traffic
- blocks free, preview, or otherwise non-approved models for confidential repositories
- stays declarative in config and verifiable at runtime

This follows the same philosophy imported from `claude-code-skills` epic `#130` and the harness-engineering references:

- mechanism before prose
- fastest reliable layer first
- pointer-based instructions
- runtime proof instead of "the code exists"

## Decision

Adopt three admission lanes:

1. `zai`, `zai-coding-plan`, and `openai` are the standard confidential-code lane.
2. `openrouter` is admitted only as a separate evaluation lane.
3. OpenRouter-backed evaluation stays on an explicit `provider-eval` agent and command instead of widening the default implementation lane.

The policy is implemented in two layers:

- config expresses admitted providers and model allowlists
- the guardrail plugin enforces lane usage at runtime through `chat.params`

## Policy

### Standard lane

- admitted providers: `zai`, `zai-coding-plan`, `openai`
- admitted models are pinned through provider allowlists
- `zai-coding-plan` is exposed as its own provider because Z.AI's official OpenCode guidance instructs Coding Plan subscribers to select `Z.AI Coding Plan` rather than overloading the general `Z.AI` provider
- preview, free, and non-approved variants are excluded by default

### Evaluation lane

- admitted provider: `openrouter`
- admitted models are a narrow allowlist of approved evaluation candidates
- the lane is entered only through the packaged `provider-eval` workflow

### Confidential-repo rule

For confidential repositories:

- do not use free models
- do not use preview, alpha, beta, or experimental models
- do not use OpenRouter outside the explicit evaluation lane
- do not expand the admitted model set without a docs-backed review of routing and data controls

## Rationale

This keeps the runtime upstream-compatible while still answering the real policy question:

- standard work has a stable provider set
- evaluation traffic is explicit instead of accidental
- adding a new OpenRouter candidate requires a deliberate config change
- plugin enforcement means project-local config cannot silently widen the lane

## Consequences

### Positive

- provider policy is declarative and testable
- the default lane is smaller and easier to reason about
- evaluation traffic is visible in workflow and logs
- future provider additions become explicit admission decisions, not casual model switches

### Negative

- the policy duplicates some intent across config and plugin checks
- OpenRouter evaluation remains intentionally narrower than raw upstream capability
- new model admissions require docs and allowlist maintenance

## Verification

Issue `#6` must prove:

- admitted providers and model allowlists load from config
- OpenRouter-backed models are available only in the explicit evaluation lane
- blocked provider misuse throws at runtime through the guardrail plugin

## Sources

- `claude-code-skills` epic `#130`
- `claude-code-skills` README
- `claude-code-skills/docs/references/harness-engineering-best-practices-2026.md`
- Anthropic `The Complete Guide to Building Skills for Claude`
- OpenCode config docs: `https://opencode.ai/docs/config`
- OpenRouter provider routing docs: `https://openrouter.ai/docs/guides/routing/provider-selection`
- OpenAI pricing: `https://openai.com/api/pricing/`
- OpenAI data controls: `https://developers.openai.com/api/docs/guides/your-data`
- Z.AI pricing: `https://docs.z.ai/guides/overview/pricing`
- Z.AI OpenCode guide: `https://docs.z.ai/devpack/tool/opencode`
