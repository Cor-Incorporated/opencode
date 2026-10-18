---
description: Diagnose and fix build or compilation errors.
agent: implement
---

Fix the current build failure with minimal changes.

1. Run the build command and capture the full error output.
2. Parse the error to identify the root cause (type error, missing import, config issue).
3. Apply the minimal fix — do not refactor or improve surrounding code.
4. Re-run the build to confirm the fix.
5. Run tests to verify no regressions.

Guidelines:
- Fix only what is broken — no architectural changes.
- If multiple errors exist, fix them in dependency order.
- Prefer fixing the type annotation over adding as any or @ts-ignore.

Required output:
- Error message (before fix)
- Files modified
- Build result (after fix)
- Test result (after fix)

$ARGUMENTS
