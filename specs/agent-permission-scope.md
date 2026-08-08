# Agent permission scope (OC-A2 / P4)

- Status: accepted for aidd-governance M3 mapping
- Related: issue #292, `packages/opencode/test/plugin/anti-pattern-guards.test.ts`

## Principles

1. **Non-interactive workers must not receive `ask`.**
   - At spawn time, resolve parent permissions.
   - Convert any remaining `ask` into `deny` (+ stop/report). Workers that cannot prompt must not hang forever (OC-1).

2. **Agent-specific permissions apply only to that agent session.**
   - Evaluate a snapshot at spawn; do not let a child agent's `deny` accumulate into the main agent (issue #292).
   - Main/default primary (`implement`) must honor explicit config `allow` over self-restricting secondary rules that are not intentionally read-only.

## Effective-state testing (C13)

Tests must assert **`Permission.evaluate` / merge of config + agent definition** (effective ruleset), not mirror fixtures alone.

Canonical proofs live in:

- `packages/opencode/test/plugin/anti-pattern-guards.test.ts`
  - `implement (default primary) effective permission allows gh pr merge per config`
  - falsify: primary-agent deny layered on config allow blocks main session

## Retirement / change control

- Changing spawn-time permission merge requires:
  1. defense ledger event on block paths (H6 / events.jsonl)
  2. negative test red→green in the same PR
  3. explicit retirement note if a restriction is removed

## Implementation note

`team.ts` behavioral changes that implement principle 1–2 must land only after this spec is accepted in-tree (this document). Existing #292 tests already encode principle 2 for the default primary.
