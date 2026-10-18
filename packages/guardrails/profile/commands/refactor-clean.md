---
description: Refactor code for clarity without changing behavior.
agent: implement
---

Refactor the specified code while preserving exact behavior.

1. Read and understand the current code thoroughly.
2. Run existing tests to establish a green baseline.
3. Apply refactoring (extract function, rename, simplify logic, remove dead code).
4. Re-run tests — all must still pass.
5. Verify no behavioral change with a targeted diff review.

Guidelines:
- Do not add features or fix bugs during refactoring.
- Do not change public APIs without explicit instruction.
- Remove dead code completely — no commented-out code or _unused variables.
- Keep commits atomic: one refactoring intent per commit.

Required output:
- Refactoring type applied
- Files modified
- Test results before and after
- Diff summary

$ARGUMENTS
