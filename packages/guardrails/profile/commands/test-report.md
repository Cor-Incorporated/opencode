---
description: Run tests and generate a report saved to log directory.
agent: implement
---

Run the project test suite and generate a structured report.

1. Detect the project test framework and runner (jest, vitest, pytest, go test, etc.).
2. Run the full test suite or the scope specified in $ARGUMENTS.
3. Collect results including pass/fail/skip counts, duration, and coverage if available.
4. Save the report to `./log/test/` with a timestamped filename (e.g., `test-report-2026-04-06T12-00-00.md`).
5. If tests fail, include failure details with file and line references.

Required output in the saved report:
- Test command executed
- Pass / fail / skip counts
- Coverage summary (if available)
- Failed test details (name, file, error message)
- Total duration
- Timestamp

$ARGUMENTS
