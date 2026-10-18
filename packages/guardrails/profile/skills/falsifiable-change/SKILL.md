---
name: falsifiable-change
description: Require a failing proof before claiming a fix (anti-pattern F). Use when reporting bug fixes or guard changes.
---

# Falsifiable change

A change is not done until removing it makes a test fail.

## Procedure

1. Write or identify a test that fails on the buggy behavior (RED).
2. Apply the fix (GREEN).
3. Temporarily disable or revert the fix and re-run — the test must fail again (falsify).
4. Restore the fix and confirm green.
5. Report with the falsify command/output, not narrative alone.
6. **Harness delivery (pattern N):** confirm the test runner actually supplies the event/async properties under test (see `harness-api-gotcha`). Vacuous passes are not falsification.
7. **Skip honesty (pattern L):** report `passed/failed/skipped`. Critical skips mean unverified.

If you cannot falsify, the claim is unverified — say so explicitly.
