# Review evidence after receipt-pipeline retirement

The minimal-safety redesign in commit `3cd8456f4e655c619986cb86041c2bdb2267840c`
(2026-07-11) removed `guardrail-review.ts`, its completion recorder, evidence hydration,
and the FULL/LIGHT/DOCS_ONLY tool-level merge-evidence gate. This was an intentional retirement.

Some `/ship` instructions and compact runtime context still required a generated
`review_state="done"` value, even though no production path remained to generate a successful
receipt. Repeated reviews could not satisfy that obsolete instruction. Child sessions also
reset legacy telemetry, so those fields were unsuitable as current-head proof.

## Current workflow contract

- Keep `/review` read-only. Actual code-reviewer and Codex review remain required for source,
  profile, workflow, agent, package, lockfile, and config changes.
- `/ship` verifies those reviews against the current PR head and checks GitHub's actual
  checks/review status. Unresolved CRITICAL/HIGH findings, CHANGES_REQUESTED, failed/pending
  checks, or missing/stale review evidence required by the selected tier block merging.
  Existing docs-only and low-risk tier exemptions remain unchanged.
- GitHub branch protection and required checks are authoritative. No configured CI is not
  a successful CI run; report that distinction and do not invent status checks.
- Pin the merge to the verified head using `--match-head-commit`; re-verify if it changes.
- Legacy `review_state`, `reviewed`, `reviewed_head`, and lane flags are advisory telemetry,
  not admission receipts. In particular, `auto:no-codex-mcp` is not a Codex review.
- Never manufacture receipts or manually edit `.opencode/guardrails/`.

This alignment changes instructions and their injected text only. It does not remove or
change a current protected-branch, self-approval, secret, permission, or GitHub protection
mechanism. It does not claim the retired receipt pipeline exists or reinstall it.

## Verification boundary

`plugins/ship-contract.test.ts` checks the shipped command/agent text and invokes the actual
`command.execute.before` hook with an empty runtime state. The regression fails on the obsolete
contract and requires real current-head review evidence plus GitHub checks in the replacement.
The fact-check gate and merge permission denials remain intact.

These are source/hook contract tests, not an end-to-end model or CLI permission-prompt test.
OpenCode loads command/agent configuration at startup; restart the running process after
deploying the profile change. Existing unrelated `local:check` failures must be reported
separately rather than hidden by this fix.
