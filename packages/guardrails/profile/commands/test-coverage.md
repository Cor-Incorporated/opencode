---
description: Analyze and improve test coverage to 80%+.
agent: implement
---

Improve test coverage for the specified area.

1. Run coverage analysis to identify uncovered lines and branches.
2. Prioritize coverage gaps by risk (critical paths first, edge cases second).
3. Write tests for the highest-risk uncovered code.
4. Re-run coverage to verify improvement.
5. Repeat until coverage >= 80%.

Guidelines:
- Do not write tests that always pass regardless of implementation.
- Each test must be falsifiable — verify it fails when the tested code is broken.
- Prefer meaningful assertions over line-count coverage padding.
- Test boundary conditions and error paths, not just happy paths.

Required output:
- Coverage before (percentage and uncovered areas)
- Tests added (file locations)
- Coverage after (percentage)
- Remaining gaps (if any)

$ARGUMENTS
