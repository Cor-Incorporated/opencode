---
description: Run the full autonomous pipeline on a task.
agent: implement
---

Execute the complete workflow for the requested change:

1. Plan the implementation (if complex, use /delegate for parallelization)
2. Implement the change with tests
3. Create a PR with proper branch naming and conventional commits
4. Run /review and fix all CRITICAL/HIGH findings (max 3 review cycles)
5. Run /ship to verify gates and execute merge
6. Create follow-up issues for any discovered out-of-scope problems
7. Verify completion: implementation + tests + docs + review + merge

Do NOT stop until all steps are complete or a hard blocker is encountered.
Report blockers explicitly with evidence.

$ARGUMENTS
