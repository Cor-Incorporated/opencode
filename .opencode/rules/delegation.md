# Delegation

## Task Assignment
- Interactive design/decisions: handle directly
- 2+ independent tasks: delegate to parallel agents
- Single long-running autonomous task: delegate to background worker
- Code review: use dedicated reviewer agent

## Parallel Execution Limits
- Sub-agents: max 5-7 concurrent
- Bash commands: max 3-4 concurrent
- Total active tasks: max 7

## Review Pipeline
- Source code changes: full review (code-reviewer + second opinion)
- CI/config/docs only: light review (code-reviewer only)
- docs/chore/ci branches: review optional

## Context Window Management
- At 20% remaining: stop new tasks, focus on completion
- At 10% remaining: save state and suggest continuation session
