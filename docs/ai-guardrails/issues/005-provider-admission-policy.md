# Issue 005: Provider Admission Policy

## Problem

The internal distribution needs a stable provider strategy that does not tie product decisions to one transient model name.

This issue is part of the MVP floor because the product needs a concrete answer for confidential-code routing before it can honestly be described as an MVP.

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

- `docs/ai-guardrails/adr/002-provider-admission-lanes.md`
- `docs/ai-guardrails/mvp-readiness.md`

## Sources

- `claude-code-skills` epic `#130`
- `claude-code-skills` README
- Anthropic `The Complete Guide to Building Skills for Claude`
- OpenRouter provider routing docs
- OpenAI pricing and model docs
- Z.AI pricing docs
- https://opencode.ai/docs/config
