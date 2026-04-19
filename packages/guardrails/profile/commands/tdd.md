---
description: Implement a feature using test-driven development.
agent: implement
---

Implement using the TDD cycle: RED, GREEN, IMPROVE.

1. **RED**: Write a failing test that describes the expected behavior.
2. **GREEN**: Write the minimal code to make the test pass.
3. **IMPROVE**: Refactor while keeping tests green.
4. Repeat steps 1-3 for each behavior increment.
5. Check coverage — target >= 80%.

Guidelines:
- Write the test BEFORE the implementation code.
- Each test should be falsifiable — it must fail when the bug exists.
- Use table-driven tests where applicable.
- Do not skip the RED phase.

Required output:
- Test file location
- Pass/fail counts at each phase
- Final coverage percentage

$ARGUMENTS
