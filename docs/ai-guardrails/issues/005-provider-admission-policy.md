# Issue 005: Provider Admission Policy

## Problem

The internal distribution needs a stable provider strategy that does not tie product decisions to one transient model name.

## Deliverables

- lane policy for `zai`, `openai`, and `openrouter`
- provider allowlist and denylist defaults
- evaluation checklist for OpenRouter-backed candidates
- confidential-repo restrictions for preview, free, or data-collecting models

## Acceptance

- provider defaults are expressed in config, not only in prose
- evaluation lane is separate from standard defaults
- policy references official routing and data controls, not assumptions

## Dependencies

- ADR 002
- Issue 001

## Sources

- https://opencode.ai/docs/providers
- https://opencode.ai/docs/config
- https://openrouter.ai/docs/guides/routing/provider-selection
- https://developers.openai.com/codex/cloud
- https://chatgpt.com/pricing
- https://docs.z.ai/guides/overview/pricing
