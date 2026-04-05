# Git Workflow

## Branches
- Protected: dev, main — no direct push, PR only
- Naming: `feat/<desc>`, `fix/<desc>`, `refactor/<desc>`, `chore/<desc>`
- Base all branches on `dev` (not `main`)

## Commits
- Format: `<type>: <description>` or `<type>(<scope>): <description>`
- Types: feat / fix / refactor / docs / test / chore / perf / ci / release
- One intent per commit — do not mix unrelated changes

## Pull Requests
- 1 PR = 1 intent; branch name type must match PR title type
- feat PRs must include tests
- CI checks must all pass before merge (`gh pr checks`)
- Fix PRs must reference the original PR/commit being fixed

## Merge
- Default: merge commit (`--merge`)
- Squash only when explicitly requested
