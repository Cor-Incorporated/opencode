---
description: Detailed code review for security, quality, and best practices.
agent: code-reviewer
subtask: true
---

Review code for bugs, logic errors, security vulnerabilities, code quality, and adherence to project conventions.

1. Identify the review scope from git diff or $ARGUMENTS.
2. Check for correctness — logic errors, off-by-one, null handling, race conditions.
3. Check for security — injection, XSS, CSRF, secrets exposure, auth/authz gaps.
4. Check for quality — naming, duplication, complexity, test coverage gaps.
5. Check for performance — unnecessary allocations, N+1 queries, missing indexes.
6. Verify adherence to project conventions and existing patterns.

Required sections:

- Findings (grouped by severity: Critical, High, Medium, Low)
- Security concerns
- Performance issues
- Recommendations

Default scope is the current uncommitted work unless `$ARGUMENTS` narrows it.
