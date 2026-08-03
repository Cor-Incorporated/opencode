---
description: Declare the minimal verification path before implementing (anti-patterns C/G).
agent: planner
---

Plan with the smallest verification path that still produces learning.

## Required one-line declaration

Before proposing steps, state exactly one minimal path:

`fake/failing test → local unit → CI (scoped) → PR`

Do not expand this path until the minimal path has failed to catch a real defect.

## Reject heavy-by-default pipelines

If the draft plan includes any of the following without prior evidence of need, rewrite to the minimal path first:

- multi-environment promotion (dev + staging + uat + prod) for a single bounded change
- multi-layer review gates beyond `/review` once
- new CI orchestration, custom runners, or parallel matrix expansion
- "comprehensive" end-to-end suites for a docs-only or single-package change

Respond with:

1. Minimal path (one line)
2. Why heavier steps are deferred
3. What evidence would justify adding one heavier step later

## SSOT / mirror sets (pattern K)

If the change touches migrations, `initial-schema`/contracts, version pins, or OpenAPI/codegen, add `/ssot-check` to the minimal path **before PR**. Updating one side alone is a half-change even when reverse references are empty.

## Arguments

$ARGUMENTS
