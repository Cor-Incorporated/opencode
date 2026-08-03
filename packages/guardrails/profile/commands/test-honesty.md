---
description: Treat skipped tests as incomplete verification (anti-patterns L/O/N).
agent: test-runner
---

Verification is not "green" until skip counts and harness honesty are explicit.

## Required report format

After any test run, report:

`N passed, M failed, K skipped`

Rules:

1. If `K > 0` for critical proofs (DB/store/migration/contract), the change is **not verified** — start services / set `*_TEST_DATABASE_URL`, re-run until critical skips are 0.
2. Do not summarize `mise run test` / `go test` as success when skips hide the proofs you claimed.
3. Check pattern N: harness must deliver event props / async signals under test (`harness-api-gotcha` skill).
4. Check pattern O: env-gated auth paths must be mocked (`env-hermetic-tests` skill).
5. Check pattern M: worktrees need `node_modules` before JS test runners.

## Arguments

$ARGUMENTS
