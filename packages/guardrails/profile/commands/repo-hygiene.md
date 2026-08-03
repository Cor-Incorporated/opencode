---
description: List stale branches/worktrees and dry-run cleanup candidates (anti-pattern E).
agent: investigate
---

Inspect repository hygiene. Do not delete anything in this command — dry-run only.

## Collect

Run (read-only):

```bash
git worktree list
git branch --merged
git branch -vv
```

Optionally: `gh issue list --state open --limit 30`

## Report

1. Worktree count and paths that look abandoned (merged branch, old date, agent prefix)
2. Local branches already merged into the integration branch
3. Suggested deletions as a **dry-run list** only
4. Ask the human/agent for explicit confirmation before any `git worktree remove` / `git branch -D`

Never run destructive cleanup from this command.

## Arguments

$ARGUMENTS
