---
description: Confirm an existing environment is insufficient before creating a new one (anti-pattern D).
agent: investigate
---

Treat new environment creation as a last resort.

## Checklist (must answer before provisioning)

1. Which existing environment (local / dev / shared staging) could run this change?
2. What concrete capability is missing there (not preference)?
3. Can the gap be closed with config, fixtures, or a one-off script instead of a new env?
4. If a new env is still required: owner, teardown date, and cost ceiling.

## Block rule

If answers 1–3 show the existing environment is sufficient, **do not** create a new environment.
Propose the reuse path instead.

## Arguments

$ARGUMENTS
