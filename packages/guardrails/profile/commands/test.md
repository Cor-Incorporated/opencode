---
description: Run verification for the current change.
agent: implement
---

Run tests relevant to the current change.

1. Identify which test files cover the modified code (check git diff for changed files).
2. Run the smallest relevant test suite (prefer targeted over full suite).
3. If tests fail, diagnose the failure cause.
4. Report results with pass/fail counts and any failures.

Required output:
- Test command executed
- Results (pass / fail / skip counts)
- Failure details (if any)
- Coverage impact (if measurable)
