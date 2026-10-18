---
description: Investigate and fix a bug with root cause analysis and regression test.
agent: implement
---

Fix the reported bug using a systematic approach.

1. Reproduce the bug or confirm the failure condition.
2. Grep for all instances of the problematic pattern across the codebase.
3. Trace the root cause — do not guess.
4. Fix ALL instances found in step 2, not just the first match.
5. Re-grep to confirm zero remaining instances.
6. Add a regression test that fails without the fix and passes with it.
7. Run the relevant test suite to verify no regressions.

Required output:
- Root cause description
- Files modified (with line references)
- Grep results before and after fix
- Regression test location and result

$ARGUMENTS
