# Quality

## Zero Tolerance
- Fix all errors and warnings immediately — "out of scope" and "known issue" are not excuses
- Before commit: lint, typecheck (`bun typecheck`), and tests must all pass

## Completion Definition
- "Done" = implementation + tests + doc updates + user-perspective verification
- Re-read the original request before reporting completion; verify each item has code changes
- Bug fixes: grep all instances -> fix all -> re-grep to confirm zero remaining

## Pre-Merge Checklist
- No env vars or secrets in code
- Endpoint changes: verify client -> API route -> backend -> response alignment
- Update related docs in the same PR (grep for references)

## Fact Verification
- Back claims with CLI output, git diff, or API responses
- Mark unverified statements as "(unverified)"
