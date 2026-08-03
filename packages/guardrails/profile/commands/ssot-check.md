---
description: Compare mirrored SSOT artifacts before PR (anti-pattern K).
agent: investigate
---

Detect SSOT sync drift: artifacts that must agree on the **same final state**.

## When to run

After changing any of:

- DB migrations / `initial-schema.sql` (or `packages/contracts/**`)
- Version pins (deployment policy, preflight, contract-check script, CD workflow)
- OpenAPI vs generated clients/stubs

## Procedure

1. List touched mirrored paths in the current diff:
   ```bash
   git diff --name-only HEAD
   git status --porcelain
   ```
2. For each mirror set, confirm **every side** is updated (not just migrations / not just one pin file).
3. Run the repo's authoritative comparison if present, for example:
   - migrate-built DB vs SSOT-built DB contract validation
   - OpenAPI codegen + diff
   - version-pin equality across policy/preflight/workflow/contract-check
4. If the local comparison is missing, say so explicitly and do not claim SSOT sync.

## Fail closed for half-changes

A migration-only or single-pin bump is **not done**. Either update the mirrors or explain why the set does not apply.

## Arguments

$ARGUMENTS
