# ADR 006: Plugin Hardening Floor For MVP

## Status

Accepted

## Context

Issue `#13` exists because the first plugin MVP proved the OpenCode hook surface, but it did not yet migrate enough of the high-value fast-feedback guardrails to support an MVP claim.

The source philosophy from epic `#130`, the source README, the harness-engineering references, and the Claude skill guide all point to the same rule:

- mechanism before prose
- fastest reliable feedback layer first
- "implemented" is not "working" without runtime proof

That means the next plugin wave should add only the local-runtime behaviors that materially strengthen the guarded workflows now, while refusing to quietly absorb later operational hardening.

## Decision

The MVP floor for plugin hardening in this repo is:

1. protect runtime-owned and policy-protected files from local mutation
2. block obvious version-baseline regressions before edit or write completion
3. track source-read budget and block further source edits once the budget is exceeded
4. record fact-check freshness and review freshness as local runtime state
5. inject that state into `/review`, `/ship`, `/handoff`, and compaction carry-over
6. scenario-test the above behavior in `packages/opencode/test/scenario/guardrails.test.ts`

This floor is implemented in `packages/guardrails/profile/plugins/guardrail.ts`.

## Included In MVP Floor

These behaviors are part of the MVP claim:

- provider lane enforcement remains declarative and independent from plugin hardening
- protected runtime/config mutation is blocked at `tool.execute.before`
- version downgrade and `:latest` pin regressions are blocked at `tool.execute.before`
- source-read budget is tracked in plugin state and blocks further source edits once exceeded
- successful `read`, `webfetch`, Context7, selected CLI checks, `edit`, `write`, and `task` completion update local guardrail state
- `/review`, `/ship`, `/handoff`, and session compaction consume that state so guarded workflows can report stale or missing checks explicitly

## Explicit Deferrals

These items are intentionally not part of the MVP floor:

- authoritative merge/review freshness enforcement in GitHub or CI
- post-merge and deployment verification
- Claude-specific local hook deployment integrity
- broader structural reminders that need more repository-specific tuning
- a separate `post-lint-format` plugin clone when OpenCode already formats on `edit` and `write`
- stronger fact-check-before-edit or GitHub-write blocking until the workflow and source-of-truth state are better defined

Those items belong to later maturity work such as `#14`, not to the MVP floor.

## Consequences

- the thin distribution stays upstream-friendly because enforcement remains in the packaged profile/plugin layer
- the guarded workflows now have file-backed state rather than prompt-only expectations
- the repo has a written boundary for what `#13` must do now versus what later issues should carry

## Sources

- `docs/ai-guardrails/README.md`
- `docs/ai-guardrails/mvp-readiness.md`
- `docs/ai-guardrails/migration/claude-code-skills-inventory.md`
- `claude-code-skills` README
- `claude-code-skills` epic `#130`
- `claude-code-skills/docs/references/harness-engineering-best-practices-2026.md`
- Anthropic `The Complete Guide to Building Skills for Claude`
