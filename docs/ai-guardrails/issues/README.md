# AI Guardrails Issue Pack

These issue briefs are intentionally written as implementation slices that can be handed to humans or agents.

## Order

1. `001-bootstrap-thin-distribution.md`
2. `002-claude-asset-inventory-and-import.md`
3. `003-guardrail-plugin-mvp.md`
4. `004-safe-agents-and-commands.md`
5. `005-provider-admission-policy.md`
6. `006-scenario-and-replay-harness.md`
7. `007-plugin-hardening-wave-2.md`
8. `008-authoritative-ci-and-release-gates.md`
9. `009-broader-claude-asset-migration.md`

## MVP split

- `004` to `007` define the MVP floor
- `008` and `009` are later maturity work and should not silently expand the MVP scope

## Working rule

No issue is complete unless:

- acceptance criteria are met
- linked scenario tests are green
- any required ADR updates are committed in the same change set
- the implementation follows the source canon fixed in `docs/ai-guardrails/README.md`
- the implementation also respects the Anthropic skill guide PDF fixed in that canon
- the work can ship as a single issue-scoped pull request
