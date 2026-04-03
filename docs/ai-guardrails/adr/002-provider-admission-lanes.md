# ADR 002: Provider Admission Lanes

- Status: Accepted
- Date: 2026-04-03

## Context

The internal tool needs multiple provider lanes:

- a cost-efficient default lane
- a high-confidence escalation lane
- an evaluation lane for model exploration

OpenCode supports provider allowlisting and per-provider model config. OpenRouter supports provider routing controls including fallback policy, data collection policy, and ZDR routing.

## Decision

Adopt three provider lanes:

- `zai`: default development lane
- `openai`: escalation lane for high-confidence or higher-stakes work
- `openrouter`: evaluation lane only

Admission rules:

- use `enabled_providers` and `disabled_providers` as the first coarse gate
- keep default sharing disabled and server localhost-only in managed config
- allow OpenRouter only when the repo policy explicitly permits it
- do not standardize preview, free, or data-collecting models for confidential repos
- require evaluation results before promoting any OpenRouter-backed model into a wider lane

## Consequences

### Positive

- clean separation between cost, confidence, and experimentation
- safer future model churn because policy targets lanes, not one named model
- lower risk of standardizing unstable preview offerings

### Negative

- additional evaluation work is required before model promotion
- some teams may want a faster path than the policy allows

## Evidence

- OpenCode provider config and provider allowlists: https://opencode.ai/docs/providers and https://opencode.ai/docs/config
- OpenAI Codex availability in ChatGPT plans: https://developers.openai.com/codex/cloud and https://chatgpt.com/pricing
- OpenRouter unified API and routing controls: https://openrouter.ai/docs/quickstart and https://openrouter.ai/docs/guides/routing/provider-selection
- Z.AI pricing reference: https://docs.z.ai/guides/overview/pricing
